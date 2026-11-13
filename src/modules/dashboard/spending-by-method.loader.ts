import { prisma } from '../../shared/db/prisma.js';
import { GENERAL_BUDGET_CATEGORY } from '../../shared/enums/index.js';
import { monthOrRangeWhere } from '../../shared/utils/competence.js';
import { budgetSpendingWhere } from '../budgets/budget-spending.js';
import { storedToCents } from '../people/money.js';
import { loadTheirShares, ownAmountCents } from '../people/own-share.js';
import { dayString } from '../recurring-transactions/recurring-dates.js';
import { addMonthKey } from '../transactions/credit-card-commitment.js';
import { utcToday } from '../transactions/transactions.service.js';

/**
 * How the spending of each month was paid: on a credit card or from the other accounts (checking, cash, savings).
 * The user's goal is to move from the card to debit/Pix, and this is the number that shows the move.
 *
 * The rows are exactly the ones of the "General" expense budget of the month (budgetSpendingWhere: expenses only, by
 * planning month, card invoice payments left out, since the purchases of the card already count on their own), each by
 * its own share (what other people owe on it taken off). So the total of a month is the General budget's own spending.
 * A card purchase counts as credit in the month it is filed under, not when the invoice is paid.
 */

export interface MethodAmounts {
  credit: number;
  other: number;
  total: number;
  /** credit / total, four decimals; null when nothing was spent. */
  creditShare: number | null;
}

export interface MethodMonth extends MethodAmounts {
  month: string;
}

export interface SpendingByMethod {
  basis: 'own-share';
  months: MethodMonth[];
  totals: MethodAmounts;
}

function amounts(creditCents: number, otherCents: number): MethodAmounts {
  const totalCents = creditCents + otherCents;
  return {
    credit: creditCents / 100,
    other: otherCents / 100,
    total: totalCents / 100,
    creditShare: totalCents > 0 ? Math.round((creditCents / totalCents) * 10000) / 10000 : null,
  };
}

async function monthCents(householdId: string, month: string, creditIds: ReadonlySet<string>): Promise<{ credit: number; other: number }> {
  const where = budgetSpendingWhere({ householdId, categoryName: GENERAL_BUDGET_CATEGORY, type: 'EXPENSE' }, monthOrRangeWhere({ month }));
  const [rows, theirShares] = await Promise.all([
    prisma.transaction.findMany({ where, select: { id: true, accountId: true, amount: true } }),
    loadTheirShares(prisma, householdId, where),
  ]);
  let credit = 0;
  let other = 0;
  for (const row of rows) {
    const cents = ownAmountCents(storedToCents(row.amount), theirShares.get(row.id)?.theirCents ?? 0);
    if (row.accountId && creditIds.has(row.accountId)) credit += cents;
    else other += cents;
  }
  return { credit, other };
}

/** The last `months` months up to `to` (default: the month of today), oldest first, and the totals of the period. */
export async function loadSpendingByMethod(params: { householdId: string; months: number; to?: string; today?: Date }): Promise<SpendingByMethod> {
  const { householdId } = params;
  const to = params.to ?? dayString(params.today ?? utcToday()).slice(0, 7);
  const keys = Array.from({ length: params.months }, (_, i) => addMonthKey(to, i - params.months + 1));
  // Closed cards too: their past purchases were still made on credit.
  const accounts = await prisma.account.findMany({ where: { householdId }, select: { id: true, type: true } });
  const creditIds = new Set(accounts.filter((a) => a.type === 'CREDIT').map((a) => a.id));

  const perMonth = await Promise.all(keys.map((month) => monthCents(householdId, month, creditIds)));
  const credit = perMonth.reduce((sum, m) => sum + m.credit, 0);
  const other = perMonth.reduce((sum, m) => sum + m.other, 0);
  return {
    basis: 'own-share',
    months: keys.map((month, i) => ({ month, ...amounts(perMonth[i]!.credit, perMonth[i]!.other) })),
    totals: amounts(credit, other),
  };
}
