import { prisma } from '../../shared/db/prisma.js';
import { GENERAL_BUDGET_CATEGORY } from '../../shared/enums/index.js';
import { monthOrRangeWhere } from '../../shared/utils/competence.js';
import { budgetSpendingWhere } from '../budgets/budget-spending.js';
import { loadTheirShares } from '../people/own-share.js';
import { loadGroupMap } from '../category-groups/category-groups.service.js';
import { expectedIncomeByMonth } from '../transactions/credit-card-commitment.js';
import { dayString } from '../recurring-transactions/recurring-dates.js';
import { utcToday } from '../transactions/transactions.service.js';
import { recurrenceEvents } from './cash-flow.loader.js';
import { buildIncomeSplit, ownCentsByCategory, type IncomeSplit } from './income-split.js';

/** Last day of a 'YYYY-MM' month, 'YYYY-MM-DD'. */
function lastDayOf(month: string): string {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
  return dayString(d);
}

/**
 * Realized spending of the month per category: the rows of the "General" expense budget of the month (budgetSpendingWhere:
 * expenses only, by planning month, without card invoice payments), each by its own share. The same rows and the same
 * own-share rule the budget summary uses, so the split never disagrees with the budgets.
 */
async function realizedByCategory(householdId: string, month: string): Promise<Map<string | null, number>> {
  const where = budgetSpendingWhere({ householdId, categoryName: GENERAL_BUDGET_CATEGORY, type: 'EXPENSE' }, monthOrRangeWhere({ month }));
  const [rows, theirShares] = await Promise.all([
    prisma.transaction.findMany({ where, select: { id: true, categoryName: true, amount: true } }),
    loadTheirShares(prisma, householdId, where),
  ]);
  return ownCentsByCategory(rows, theirShares);
}

/**
 * What is still committed in the month per category: the expense occurrences the recurrences of the household's active
 * accounts (cash accounts and cards) have not generated yet, up to the last day of the month. The walk is the one of the
 * cash flow (`recurrenceEvents`): a month that already holds a transaction of the recurrence is not counted again, and
 * a stale occurrence still owed counts. Pending entries already posted are in the realized part, and the card purchases
 * count on their own dates there, so the invoice payment is never added (it would count the same money twice).
 * An occurrence counts in the month of its date.
 */
async function committedByCategory(householdId: string, month: string, today: string): Promise<Map<string | null, number>> {
  const accounts = await prisma.account.findMany({ where: { householdId, isActive: true }, select: { id: true } });
  const out = new Map<string | null, number>();
  if (accounts.length === 0) return out;
  const events = await recurrenceEvents(householdId, accounts.map((a) => a.id), today, lastDayOf(month));
  const expense = events.filter((e) => e.amountCents < 0 && e.date.slice(0, 7) === month);
  if (expense.length === 0) return out;
  const recurrences = await prisma.recurringTransaction.findMany({
    where: { householdId, id: { in: [...new Set(expense.map((e) => e.sourceId))] } },
    select: { id: true, categoryName: true },
  });
  const categoryOf = new Map(recurrences.map((r) => [r.id, r.categoryName]));
  for (const e of expense) {
    if (!categoryOf.has(e.sourceId)) continue;
    const categoryName = categoryOf.get(e.sourceId) ?? null;
    out.set(categoryName, (out.get(categoryName) ?? 0) - e.amountCents);
  }
  return out;
}

/**
 * GET /dashboard/income-split: where the month's income goes. The income is the household's EXPECTED income of the month
 * (expectedIncomeByMonth: the monthly income recurrences, salary and benefits calculated by the Income area), the whole
 * month including what already came in; the realized income is not mixed in. The groups are realized (own share) plus
 * committed; the leftover is what remains of the income.
 */
export async function loadIncomeSplit(params: { householdId: string; month: string; today?: Date }): Promise<IncomeSplit> {
  const { householdId, month } = params;
  const today = dayString(params.today ?? utcToday());
  const [map, income, realized, committed] = await Promise.all([
    loadGroupMap(householdId),
    expectedIncomeByMonth(householdId, [month]),
    realizedByCategory(householdId, month),
    committedByCategory(householdId, month, today),
  ]);
  return buildIncomeSplit({
    month,
    incomeCents: income.get(month) ?? 0,
    groups: map.groups,
    groupOf: map.groupOf,
    realizedByCategory: realized,
    committedByCategory: committed,
  });
}
