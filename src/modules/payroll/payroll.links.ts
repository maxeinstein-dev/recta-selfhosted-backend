/**
 * Employment rows to the pure `EmploymentData`, and the loader the cash flow and the card commitment use: the active
 * CLT employments of a household that point to a "Salary" recurrence or have a benefit paid per business day
 * (optionally only those of one person). Read-only.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { dayString } from '../recurring-transactions/recurring-dates.js';
import type { DailyBenefitData } from './payroll-daily-benefit.js';
import type { EmploymentData } from './payroll-events.js';

export const employmentInclude = {
  salaries: { orderBy: { startDate: 'asc' } },
  items: {
    orderBy: { createdAt: 'asc' },
    include: { values: { orderBy: { startDate: 'asc' } }, recurringTransaction: { select: { id: true, isActive: true } } },
  },
  vacations: { orderBy: [{ startDate: 'asc' }, { month: 'asc' }], include: { items: true } },
  fgtsBalances: { orderBy: { asOfDate: 'asc' } },
  fgtsWithdrawals: { orderBy: { date: 'asc' } },
  fgtsModes: { orderBy: { startDate: 'asc' } },
} satisfies Prisma.EmploymentInclude;

export type EmploymentRow = Prisma.EmploymentGetPayload<{ include: typeof employmentInclude }>;

const isPerBusinessDay = (i: { calcMode?: string | null }): boolean => i.calcMode === 'PER_BUSINESS_DAY';

const cents = (d: { toNumber(): number }): number => Math.round(d.toNumber() * 100);
const day = (d: Date | null): string | null => (d ? dayString(d) : null);

export function toEmploymentData(row: EmploymentRow): EmploymentData {
  // The latest informed balance is the basis of the FGTS estimate
  const latest = row.fgtsBalances.reduce<EmploymentRow['fgtsBalances'][number] | null>(
    (best, b) => (!best || b.asOfDate > best.asOfDate ? b : best),
    null,
  );
  return {
    employmentId: row.id,
    personId: row.personId ?? null,
    accountId: row.accountId ?? null,
    calendar: row.holidayUf ? { uf: row.holidayUf, city: row.holidayCity ?? null, optionalOff: row.optionalHolidaysOff ?? false } : null,
    admissionDate: dayString(row.admissionDate),
    endDate: day(row.endDate),
    dependents: row.dependents,
    payDay: row.payDay,
    method: { bracket: row.bracketMethod === 'DIRECT' ? 'direct' : 'deduction', rounding: row.rounding === 'ROUND' ? 'round' : 'truncate' },
    thirteenth: {
      first: { month: row.thirteenthFirstMonth, day: row.thirteenthFirstDay },
      second: { month: row.thirteenthSecondMonth, day: row.thirteenthSecondDay },
    },
    salaries: row.salaries.map((s) => ({ startDate: dayString(s.startDate), amountCents: cents(s.amount) })),
    // Items paid per business day have their own payment: they are not payslip lines
    items: row.items
      .filter((i) => !isPerBusinessDay(i))
      .map((i) => ({
        id: i.id,
        name: i.name,
        kind: i.kind === 'DEDUCTION' ? 'deduction' : 'earning',
        inInssBase: i.inInssBase,
        inIrrfBase: i.inIrrfBase,
        inFgtsBase: i.inFgtsBase,
        values: i.values.map((v) => ({ startDate: dayString(v.startDate), amountCents: cents(v.amount) })),
      })),
    benefits: row.items.filter(isPerBusinessDay).map(
      (i): DailyBenefitData => ({
        id: i.id,
        name: i.name,
        values: i.values.map((v) => ({ startDate: dayString(v.startDate), amountCents: cents(v.amount) })),
        payDay: i.payDay ?? 1,
        referenceMonthOffset: i.referenceMonthOffset ?? 0,
        accountId: i.accountId ?? null,
        isAvailableCash: i.isAvailableCash ?? true,
        recurringTransactionId: i.recurringTransactionId ?? null,
        recurrenceActive: i.recurringTransaction?.isActive ?? false,
        marginDays: i.marginDays ?? 0,
      }),
    ),
    vacations: row.vacations.map((v) => ({
      id: v.id,
      start: day(v.startDate),
      month: v.month,
      days: v.days,
      sellDays: v.sellDays,
      items: v.items.map((i) => ({
        label: i.label,
        amountCents: cents(i.amount),
        kind: i.kind === 'DEDUCTION' ? 'deduction' : 'earning',
        inInssBase: i.inInssBase,
        inIrrfBase: i.inIrrfBase,
        inFgtsBase: i.inFgtsBase,
      })),
    })),
    fgts: {
      balance: latest ? { asOfDate: dayString(latest.asOfDate), amountCents: cents(latest.amount) } : null,
      withdrawals: row.fgtsWithdrawals.map((w) => ({
        date: dayString(w.date),
        amountCents: cents(w.amount),
        kind: w.kind === 'BIRTHDAY' ? 'birthday' : w.kind === 'TERMINATION' ? 'termination' : 'other',
      })),
      modes: row.fgtsModes.map((m) => ({
        startDate: dayString(m.startDate),
        mode: m.mode === 'BIRTHDAY' ? 'birthday' : 'termination',
        birthdayMonth: m.birthdayMonth,
        expectedAmountCents: m.expectedAmount ? cents(m.expectedAmount) : null,
      })),
    },
  };
}

export interface PayrollLink {
  employmentId: string;
  /** Owner of the employment; null when it has none. */
  personId: string | null;
  /** The salary recurrence the employment feeds; null when it only has per-business-day benefits. */
  recurringTransactionId: string | null;
  /** Account of the linked recurrence; null without a salary recurrence. */
  recurrenceAccountId: string | null;
  /** False without a salary recurrence: nothing salary-related (13th, vacation, birthday withdrawal) is then forecast. */
  recurrenceActive: boolean;
  /** Where the 13th, vacation and withdrawal money lands: the employment's account, else the recurrence's. Null when neither exists. */
  receivingAccountId: string | null;
  data: EmploymentData;
}

/**
 * Active CLT employments of the household that point to a recurrence or have a per-business-day benefit, optionally
 * only those of one person. Empty when there is none: callers do nothing then.
 */
export async function loadPayrollLinks(householdId: string, filter: { personId?: string } = {}): Promise<PayrollLink[]> {
  const rows = await prisma.employment.findMany({
    where: {
      householdId,
      isActive: true,
      regime: 'CLT',
      ...(filter.personId ? { personId: filter.personId } : {}),
      OR: [{ recurringTransactionId: { not: null } }, { items: { some: { calcMode: 'PER_BUSINESS_DAY' } } }],
    },
    include: { ...employmentInclude, recurringTransaction: { select: { id: true, accountId: true, isActive: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => {
    const rec = row.recurringTransaction;
    return {
      employmentId: row.id,
      personId: row.personId ?? null,
      recurringTransactionId: rec?.id ?? null,
      recurrenceAccountId: rec?.accountId ?? null,
      recurrenceActive: rec?.isActive ?? false,
      receivingAccountId: row.accountId ?? rec?.accountId ?? null,
      data: toEmploymentData(row),
    };
  });
}
