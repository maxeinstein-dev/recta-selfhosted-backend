import type { Prisma } from '../../generated/prisma/client.js';
import { CategoryType, GENERAL_BUDGET_CATEGORY } from '../../shared/enums/index.js';
import { deductionCents, type TheirShare } from '../people/own-share.js';

/**
 * The ONE definition of "what counts as the realized amount of a budget", shared by the budget summary (what the
 * screens show) and by the budget alerts (the notifications), so that an alert never disagrees with the screen.
 *
 * A budget counts the transactions of its household, of its own type (an income filed under an expense category, such
 * as a refund, or a transfer, is not spending) and of its category; the "General" budget takes every category.
 * `periodWhere` is the period filter (see monthOrRangeWhere): the planning month, or a date range.
 *
 * The payment of a card invoice (tagged `invoice_pay:<card>:...` in `attachmentUrl`) is left out: the purchases of the
 * card already count on their own dates, so the payment would count the same money twice.
 */
export const INVOICE_PAYMENT_PREFIX = 'invoice_pay:';
const NOT_INVOICE_PAYMENT = { OR: [{ attachmentUrl: null }, { NOT: { attachmentUrl: { startsWith: INVOICE_PAYMENT_PREFIX } } }] };

export function budgetSpendingWhere(
  budget: { householdId: string | undefined; categoryName: string; type: string },
  periodWhere: Record<string, unknown>,
): Prisma.TransactionWhereInput {
  const { AND: periodAnd, ...period } = periodWhere as { AND?: unknown };
  const periodConditions = periodAnd === undefined ? [] : Array.isArray(periodAnd) ? periodAnd : [periodAnd];
  return {
    householdId: budget.householdId,
    ...(budget.categoryName === GENERAL_BUDGET_CATEGORY ? {} : { categoryName: budget.categoryName }),
    type: budget.type as CategoryType,
    ...period,
    AND: [...periodConditions, NOT_INVOICE_PAYMENT],
  } as Prisma.TransactionWhereInput;
}

/** Sum of the absolute amounts, in reais, added in whole cents. */
export function sumSpending(rows: ReadonlyArray<{ amount: { toNumber(): number } }>): number {
  return rows.reduce((cents, row) => cents + Math.round(Math.abs(row.amount.toNumber()) * 100), 0) / 100;
}

/** How a budget is measured: the full spending (a budget kept together) or the own share (kept separately). */
export type BudgetMeasure = 'WHOLE' | 'OWN_SHARE';
export const BUDGET_MEASURES: readonly BudgetMeasure[] = ['WHOLE', 'OWN_SHARE'];

/** The stored mode of a budget; a row without it (older data) is measured as WHOLE. */
export function measureOf(budget: { measure?: string | null }): BudgetMeasure {
  return budget.measure === 'OWN_SHARE' ? 'OWN_SHARE' : 'WHOLE';
}

/**
 * Own share of the spending of a budget: the spending minus what other people owe on its expenses (the shares of its
 * category; of every category for the General budget). Expense budgets only; never below zero.
 */
export function ownSpentOf(budget: { categoryName: string; type: string }, spending: number, theirShares: readonly TheirShare[]): number {
  if (budget.type !== 'EXPENSE') return spending;
  const sharedCents = theirShares
    .filter((share) => budget.categoryName === GENERAL_BUDGET_CATEGORY || share.categoryName === budget.categoryName)
    .reduce((sum, share) => sum + deductionCents(share), 0);
  return sharedCents === 0 ? spending : Math.max(0, Math.round(spending * 100) - sharedCents) / 100;
}

/**
 * The amount the limit is compared with (percentage, remaining, over-budget flag and alerts): the own share for an
 * expense budget measured separately, the full spending otherwise.
 */
export function measuredAmount(budget: { type: string; measure?: string | null }, spending: number, ownSpent: number): number {
  return budget.type === 'EXPENSE' && measureOf(budget) === 'OWN_SHARE' ? ownSpent : spending;
}
