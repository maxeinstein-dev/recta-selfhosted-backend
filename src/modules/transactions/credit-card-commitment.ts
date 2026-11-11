import { prisma } from '../../shared/db/prisma.js';
import { dayString } from '../recurring-transactions/recurring-dates.js';
import { forecastBatch } from '../recurring-transactions/recurring-forecast.js';
import { formatDay } from '../payroll/payroll-dates.js';
import { extraPayrollEvents, salaryPaidInMonth } from '../payroll/payroll-events.js';
import { loadPayrollLinks } from '../payroll/payroll.links.js';
import { fromCents, toCents, type InvoiceState } from './credit-card-invoice-forecast.js';
import { calculateCreditCardInvoice, utcToday } from './transactions.service.js';

/** What one invoice is expected to cost, and how it compares with the income expected for its month. */
export interface CommitmentMonth {
  /** Invoice month, 'YYYY-MM' (the month it is due in). */
  month: string;
  closingDate: string;
  dueDate: string | null;
  state: InvoiceState;
  /** Already on the invoice: purchases and installments, net of refunds. */
  posted: number;
  /** Recurrences still expected before it closes. */
  forecast: number;
  /** posted + forecast. */
  expectedTotal: number;
  /** Income the household's monthly income recurrences are expected to bring in that month. */
  expectedIncome: number;
  /** expectedTotal / expectedIncome, rounded to four decimals; null when no income is expected. */
  incomeShare: number | null;
}

export interface CardCommitment {
  accountId: string;
  months: CommitmentMonth[];
  totals: { posted: number; forecast: number; expectedTotal: number; expectedIncome: number; incomeShare: number | null };
}

export interface CommitmentInput {
  month: string;
  closingDate: string;
  dueDate: string | null;
  state: InvoiceState;
  postedCents: number;
  forecastCents: number;
}

const share = (totalCents: number, incomeCents: number): number | null =>
  incomeCents > 0 ? Math.round((totalCents / incomeCents) * 10000) / 10000 : null;

/** 'YYYY-MM' + n months. */
export function addMonthKey(month: string, n: number): string {
  const index = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + n;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** Pure part: one line per invoice and the totals, all summed in whole cents. */
export function buildCommitment(
  accountId: string,
  invoices: CommitmentInput[],
  incomeCentsByMonth: ReadonlyMap<string, number>,
): CardCommitment {
  let postedCents = 0;
  let forecastCents = 0;
  let incomeCents = 0;
  const months = invoices.map((invoice): CommitmentMonth => {
    const monthIncome = incomeCentsByMonth.get(invoice.month) ?? 0;
    const total = invoice.postedCents + invoice.forecastCents;
    postedCents += invoice.postedCents;
    forecastCents += invoice.forecastCents;
    incomeCents += monthIncome;
    return {
      month: invoice.month,
      closingDate: invoice.closingDate,
      dueDate: invoice.dueDate,
      state: invoice.state,
      posted: fromCents(invoice.postedCents),
      forecast: fromCents(invoice.forecastCents),
      expectedTotal: fromCents(total),
      expectedIncome: fromCents(monthIncome),
      incomeShare: share(total, monthIncome),
    };
  });
  return {
    accountId,
    months,
    totals: {
      posted: fromCents(postedCents),
      forecast: fromCents(forecastCents),
      expectedTotal: fromCents(postedCents + forecastCents),
      expectedIncome: fromCents(incomeCents),
      incomeShare: share(postedCents + forecastCents, incomeCents),
    },
  };
}

/**
 * Income expected per month, in cents, from the household's active MONTHLY income recurrences (their forecast strategy
 * decides the amount). A recurrence counts from the month of its next run to the month of its end date. Other
 * frequencies are left out: this is a reference line for the card, not a cash-flow projection.
 * An employment linked to a salary recurrence replaces that recurrence's amount with the calculated net paid in the
 * month, and adds the 13th, vacation and FGTS birthday withdrawal of the month they fall in (nothing is filtered by
 * today: it is the income of the month). Without a linked employment the result is the one of the recurrences alone.
 */
export async function expectedIncomeByMonth(householdId: string, months: readonly string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>(months.map((m) => [m, 0]));
  const payroll = await loadPayrollLinks(householdId);
  const rows = await prisma.recurringTransaction.findMany({ where: { householdId, isActive: true, frequency: 'MONTHLY' } });
  if (rows.length > 0) {
    const batch = await forecastBatch(prisma, rows);
    for (const row of rows) {
      if (!batch.isIncome(row)) continue;
      const first = dayString(row.nextRunAt).slice(0, 7);
      const last = row.endDate ? dayString(row.endDate).slice(0, 7) : null;
      const link = payroll.find((l) => l.recurringTransactionId === row.id);
      for (const month of months) {
        if (month < first || (last && month > last)) continue;
        const calc = link ? salaryPaidInMonth(link.data, month) : null;
        result.set(month, (result.get(month) ?? 0) + (calc ? calc.netCents : toCents(batch.expected(row, month).amount)));
      }
    }
  }
  // 13th, vacations and birthday withdrawals of the employments that feed an active salary recurrence
  if (payroll.length > 0 && months.length > 0) {
    const sorted = [...months].sort();
    const from = `${sorted[0]}-01`;
    const to = formatDay(Number(sorted[sorted.length - 1]!.slice(0, 4)), Number(sorted[sorted.length - 1]!.slice(5, 7)), 31);
    for (const link of payroll) {
      if (!link.recurrenceActive) continue;
      for (const e of extraPayrollEvents(link.data, { from, to })) {
        const month = e.date.slice(0, 7);
        if (result.has(month)) result.set(month, (result.get(month) ?? 0) + e.netCents);
      }
    }
  }
  return result;
}

/**
 * The card's next invoices side by side: what is already on each one, what the recurrences will still add, and the
 * income expected for the same month. Read-only: it reuses the invoice calculation, month by month.
 */
export async function getCreditCardCommitment(
  accountId: string,
  householdId: string,
  options: { months?: number; from?: string; today?: Date } = {},
): Promise<CardCommitment> {
  const count = Math.min(12, Math.max(1, options.months ?? 6));
  const today = options.today ?? utcToday();
  const from = options.from ?? dayString(today).slice(0, 7);
  const keys = Array.from({ length: count }, (_, i) => addMonthKey(from, i));

  const invoices: CommitmentInput[] = [];
  for (const month of keys) {
    const { data } = await calculateCreditCardInvoice(accountId, month, householdId, { limit: 1 }, { today });
    invoices.push({
      month,
      closingDate: data.closingDate,
      dueDate: data.dueDate,
      state: data.state,
      postedCents: toCents(data.statementTotal),
      forecastCents: toCents(data.forecast.total),
    });
  }
  return buildCommitment(accountId, invoices, await expectedIncomeByMonth(householdId, keys));
}
