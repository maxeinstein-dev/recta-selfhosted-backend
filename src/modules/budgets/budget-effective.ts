import { monthOfDate } from '../../shared/utils/competence.js';

/**
 * The ONE definition of "which budget is in force in a month", shared by the budget summary (what the screens show)
 * and by the budget alerts, so a budget created in one month keeps holding in the next ones without being copied.
 *
 * Per category and type, the budget in force in month M is the one with the newest month that is not after M. It stops
 * holding after its end month (included up to it). An older budget never comes back when the newer one ended: ending
 * means "no budget from then on", and changing the amount means a new budget from that month on, so past months keep
 * showing the amount they had.
 */
export interface BudgetPeriodRow {
  categoryName: string;
  type: string;
  month: Date;
  endMonth?: Date | null;
}

/** 'YYYY-MM' of a stored budget month (a UTC-midnight @db.Date value). */
const keyOf = (month: Date): string => monthOfDate(month);

/** UTC first day of a 'YYYY-MM' month: the value a budget month column holds. */
export function monthStartOf(monthKey: string): Date {
  return new Date(Date.UTC(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)) - 1, 1));
}

/** The budgets in force in `monthKey`, in the order of `rows`. */
export function pickEffectiveBudgets<T extends BudgetPeriodRow>(rows: readonly T[], monthKey: string): T[] {
  const newest = new Map<string, T>();
  for (const row of rows) {
    if (keyOf(row.month) > monthKey) continue;
    const group = `${row.type}|${row.categoryName}`;
    const current = newest.get(group);
    if (!current || keyOf(row.month) > keyOf(current.month)) newest.set(group, row);
  }
  const inForce = new Set<T>();
  for (const row of newest.values()) {
    if (row.endMonth && keyOf(row.endMonth) < monthKey) continue;
    inForce.add(row);
  }
  return rows.filter((row) => inForce.has(row));
}
