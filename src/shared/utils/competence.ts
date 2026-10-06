import { parseMonthFilter } from './pagination.js';
import { dayString } from '../../modules/recurring-transactions/recurring-dates.js';

/**
 * Reference month (competencia) helpers.
 *
 * A transaction belongs to the "planning month" `competenceMonth` when it is set, else to the month of its `date`.
 * Money (account balance, calendar, card invoices, bank reconciliation) always follows `date`; only month planning
 * (list by month, summaries, budgets, recap) follows the effective month, and only for INCOME and EXPENSE rows
 * (the API refuses a competence on transfers and allocations, so those rows are always null and fall back to date).
 */

export const COMPETENCE_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** How far (months) a reference month may be from the transaction date. */
export const MAX_COMPETENCE_DISTANCE_MONTHS = 24;

/** 'YYYY-MM' of a stored/local date. */
export function monthOfDate(date: Date): string {
  return dayString(date).slice(0, 7);
}

/** The month a row counts for in month planning. */
export function effectiveMonth(row: { date: Date; competenceMonth?: string | null }): string {
  return row.competenceMonth ?? monthOfDate(row.date);
}

/** Months between two 'YYYY-MM' (b - a). */
export function monthDistance(a: string, b: string): number {
  return (Number(b.slice(0, 4)) * 12 + Number(b.slice(5, 7))) - (Number(a.slice(0, 4)) * 12 + Number(a.slice(5, 7)));
}

/** 'YYYY-MM' moved by n months. */
export function addMonths(month: string, n: number): string {
  const idx = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
  return `${String(Math.floor(idx / 12)).padStart(4, '0')}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

/** True when `competenceMonth` is within +-24 months of `date`. */
export function competenceWithinRange(competenceMonth: string, date: Date): boolean {
  return Math.abs(monthDistance(monthOfDate(date), competenceMonth)) <= MAX_COMPETENCE_DISTANCE_MONTHS;
}

/**
 * Prisma `where` for "the transaction counts in month M": (competence_month = M) OR (competence_month IS NULL AND
 * date within M). With no competence set this is exactly the date-range filter the code used before.
 * Combine it through `AND: [...]`, never spread next to another `OR`.
 */
export function effectiveMonthWhere(month: string): { OR: Array<Record<string, unknown>> } {
  const { start, end } = parseMonthFilter(month);
  return {
    OR: [
      { competenceMonth: month },
      { competenceMonth: null, date: { gte: start, lte: end } },
    ],
  };
}

/**
 * `where` fragment of the "month or custom range" filters of the transaction endpoints: a month means the planning
 * month (effective month); an explicit startDate/endDate range stays a plain date range (cash view).
 */
export function monthOrRangeWhere(f: { month?: string; startDate?: Date; endDate?: Date }): Record<string, unknown> {
  if (f.month) return { AND: [effectiveMonthWhere(f.month)] };
  if (f.startDate || f.endDate) {
    const date: { gte?: Date; lte?: Date } = {};
    if (f.startDate) date.gte = f.startDate;
    if (f.endDate) date.lte = f.endDate;
    return { date };
  }
  return {};
}
