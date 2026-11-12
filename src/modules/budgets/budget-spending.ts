import type { Prisma } from '../../generated/prisma/client.js';
import { CategoryType, GENERAL_BUDGET_CATEGORY } from '../../shared/enums/index.js';

/**
 * The ONE definition of "what counts as the realized amount of a budget", shared by the budget summary (what the
 * screens show) and by the budget alerts (the notifications), so that an alert never disagrees with the screen.
 *
 * A budget counts the transactions of its household, of its own type (an income filed under an expense category, such
 * as a refund, or a transfer, is not spending) and of its category; the "General" budget takes every category.
 * `periodWhere` is the period filter (see monthOrRangeWhere): the planning month, or a date range.
 */
export function budgetSpendingWhere(
  budget: { householdId: string | undefined; categoryName: string; type: string },
  periodWhere: Record<string, unknown>,
): Prisma.TransactionWhereInput {
  return {
    householdId: budget.householdId,
    ...(budget.categoryName === GENERAL_BUDGET_CATEGORY ? {} : { categoryName: budget.categoryName }),
    type: budget.type as CategoryType,
    ...periodWhere,
  };
}

/** Sum of the absolute amounts, in reais, added in whole cents. */
export function sumSpending(rows: ReadonlyArray<{ amount: { toNumber(): number } }>): number {
  return rows.reduce((cents, row) => cents + Math.round(Math.abs(row.amount.toNumber()) * 100), 0) / 100;
}
