/**
 * Employment rows to the pure `EmploymentData`, and the loader the cash flow and the card commitment use: the active
 * CLT employments of a household that point to a "Salary" recurrence. Read-only.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { dayString } from '../recurring-transactions/recurring-dates.js';
import type { EmploymentData } from './payroll-events.js';

export const employmentInclude = {
  salaries: { orderBy: { startDate: 'asc' } },
  items: { orderBy: { createdAt: 'asc' }, include: { values: { orderBy: { startDate: 'asc' } } } },
  vacations: { orderBy: [{ startDate: 'asc' }, { month: 'asc' }], include: { items: true } },
  fgtsBalances: { orderBy: { asOfDate: 'asc' } },
  fgtsWithdrawals: { orderBy: { date: 'asc' } },
  fgtsModes: { orderBy: { startDate: 'asc' } },
} satisfies Prisma.EmploymentInclude;

export type EmploymentRow = Prisma.EmploymentGetPayload<{ include: typeof employmentInclude }>;

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
    items: row.items.map((i) => ({
      id: i.id,
      name: i.name,
      kind: i.kind === 'DEDUCTION' ? 'deduction' : 'earning',
      inInssBase: i.inInssBase,
      inIrrfBase: i.inIrrfBase,
      inFgtsBase: i.inFgtsBase,
      values: i.values.map((v) => ({ startDate: dayString(v.startDate), amountCents: cents(v.amount) })),
    })),
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
  recurringTransactionId: string;
  /** Account of the linked recurrence. */
  recurrenceAccountId: string;
  recurrenceActive: boolean;
  /** Where the 13th, vacation and withdrawal money lands: the employment's account, else the recurrence's. */
  receivingAccountId: string;
  data: EmploymentData;
}

/** Active CLT employments of the household that point to a recurrence. Empty when there is none: callers do nothing then. */
export async function loadPayrollLinks(householdId: string): Promise<PayrollLink[]> {
  const rows = await prisma.employment.findMany({
    where: { householdId, isActive: true, regime: 'CLT', recurringTransactionId: { not: null } },
    include: { ...employmentInclude, recurringTransaction: { select: { id: true, accountId: true, isActive: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const links: PayrollLink[] = [];
  for (const row of rows) {
    const rec = row.recurringTransaction;
    if (!rec) continue;
    links.push({
      employmentId: row.id,
      recurringTransactionId: rec.id,
      recurrenceAccountId: rec.accountId,
      recurrenceActive: rec.isActive,
      receivingAccountId: row.accountId ?? rec.accountId,
      data: toEmploymentData(row),
    });
  }
  return links;
}
