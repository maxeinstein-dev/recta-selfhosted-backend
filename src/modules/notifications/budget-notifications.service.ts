import { prisma } from '../../shared/db/prisma.js';
import { NotificationType } from './notifications.schema.js';
import { createNotification } from './notifications.service.js';
import { monthOfDate, monthOrRangeWhere } from '../../shared/utils/competence.js';
import { budgetSpendingWhere, measureOf, measuredAmount, ownSpentOf, sumSpending } from '../budgets/budget-spending.js';
import { pickEffectiveBudgets } from '../budgets/budget-effective.js';
import { loadTheirShares } from '../people/own-share.js';
import { Prisma } from '../../generated/prisma/client.js';
import { CategoryName, CATEGORY_NAME_DISPLAY, GENERAL_BUDGET_CATEGORY } from '../../shared/enums/index.js';
import { isCustomCategoryName, toCustomCategoryId } from '../../shared/utils/categoryHelpers.js';

type BudgetRow = { id: string; categoryName: string; type: string; measure?: string | null; monthlyLimit: Prisma.Decimal };

/** Display name of a budget category: "Geral" for the General budget, the custom name, or the system name. */
async function categoryDisplayNameOf(categoryName: string): Promise<string> {
  if (categoryName === GENERAL_BUDGET_CATEGORY) return 'Geral';
  if (isCustomCategoryName(categoryName)) {
    const customId = toCustomCategoryId(categoryName);
    if (!customId) return categoryName;
    const customCategory = await prisma.category.findUnique({ where: { id: customId }, select: { name: true } });
    return customCategory?.name || categoryName;
  }
  return CATEGORY_NAME_DISPLAY[categoryName as CategoryName] || categoryName;
}

/**
 * Check budget status and create notifications for 75% and 100% thresholds
 * Called after creating or updating a transaction
 *
 * Two budgets of the month can be touched by one expense: the budget of its category and the General budget (every
 * category). Each is checked on its own, with the amount its mode measures (the full spending, or the own share for a
 * budget measured separately): the same amount the budget summary shows.
 */
export async function checkBudgetThresholds(
  householdId: string,
  categoryName: string,
  transactionDate: Date,
  transactionAmount: number,
  transactionType: 'INCOME' | 'EXPENSE',
  competenceMonth?: string | null
) {
  // Only check expenses (budgets are for expenses)
  if (transactionType !== 'EXPENSE') {
    return;
  }

  // The budget month is the planning month: the reference month when set, else the month of the date.
  const budgetMonth = competenceMonth ?? monthOfDate(transactionDate);
  // A budget month is stored as the first day, a UTC-midnight date like every @db.Date value
  const budgetMonthStart = new Date(Date.UTC(Number(budgetMonth.slice(0, 4)), Number(budgetMonth.slice(5, 7)) - 1, 1));

  // The budget in force in the month (it repeats from its own month on): the newest one not after the month, unless it
  // ended before it. Same rule as the summary (see budget-effective.ts).
  const findBudget = async (name: string) => {
    const newest = await prisma.budget.findFirst({
      where: { householdId, categoryName: name, type: 'EXPENSE', month: { lte: budgetMonthStart } },
      orderBy: { month: 'desc' },
    });
    return newest ? (pickEffectiveBudgets([newest], budgetMonth)[0] ?? null) : null;
  };
  const categoryBudget = await findBudget(categoryName);
  const generalBudget = categoryName === GENERAL_BUDGET_CATEGORY ? null : await findBudget(GENERAL_BUDGET_CATEGORY);
  const budgets = [categoryBudget, generalBudget].filter((b): b is NonNullable<typeof b> => b !== null) as BudgetRow[];

  if (budgets.length === 0) {
    return; // No budget touched by this expense
  }

  const periodWhere = monthOrRangeWhere({ month: budgetMonth });

  // What other people owe on the expenses of the month: only loaded when a budget is measured by the own share
  const theirShares = budgets.some((b) => measureOf(b) === 'OWN_SHARE')
    ? [...(await loadTheirShares(prisma, householdId, periodWhere as Prisma.TransactionWhereInput)).values()]
    : [];

  // Get household members to notify (all members should receive budget alerts)
  const members = await prisma.householdMember.findMany({
    where: { householdId },
    include: { user: { select: { id: true } } },
  });

  // Check if we've already sent notifications for this threshold
  // We only want to send once per threshold per month
  // Query all BUDGET_ALERT notifications for this household in this month. `createdAt` is an instant (not a
  // @db.Date), so the month of the transaction date is bounded by local-time instants. The month comes from
  // monthOfDate, which reads a date from a @db.Date column (UTC midnight) as its own day: a local getter read the
  // day before when the transaction is the first of a month.
  const dateMonth = monthOfDate(transactionDate);
  const notificationsStart = new Date(Number(dateMonth.slice(0, 4)), Number(dateMonth.slice(5, 7)) - 1, 1);
  const notificationsEnd = new Date(Number(dateMonth.slice(0, 4)), Number(dateMonth.slice(5, 7)), 0, 23, 59, 59, 999);
  const existingNotifications = await prisma.notification.findMany({
    where: {
      type: NotificationType.BUDGET_ALERT,
      userId: {
        in: members.map((m) => m.userId),
      },
      createdAt: {
        gte: notificationsStart,
        lte: notificationsEnd,
      },
    },
  });

  const notifications = [];

  for (const budget of budgets) {
    const limit = budget.monthlyLimit.toNumber();
    if (limit <= 0) {
      continue; // Invalid limit
    }

    // The spending of the budget in its month: the same definition the budget summary shows (see budget-spending.ts)
    const transactions = await prisma.transaction.findMany({
      where: budgetSpendingWhere({ householdId, categoryName: budget.categoryName, type: 'EXPENSE' }, periodWhere),
      select: { amount: true },
    });
    const fullSpending = sumSpending(transactions);
    const measure = measureOf(budget);
    // What the limit is compared with: the own share for a budget measured separately, the full spending otherwise
    const spending = measuredAmount(budget, fullSpending, ownSpentOf(budget, fullSpending, theirShares));

    const percentage = (spending / limit) * 100;
    const roundedPercentage = Math.round(percentage * 100) / 100;

    // Notifications already sent for this specific budget, and their thresholds
    const notifiedPercentages = existingNotifications
      .filter((n) => {
        const metadata = n.metadata as any;
        return metadata && typeof metadata === 'object' && metadata.budgetId === budget.id;
      })
      .map((n) => (n.metadata as any)?.percentage)
      .filter((p): p is number => typeof p === 'number');

    const hasNotified75 = notifiedPercentages.some((p) => p >= 75 && p < 100);
    const hasNotified100 = notifiedPercentages.some((p) => p >= 100);

    const reaches75 = roundedPercentage >= 75 && roundedPercentage < 100 && !hasNotified75;
    const reaches100 = roundedPercentage >= 100 && !hasNotified100;
    if (!reaches75 && !reaches100) {
      continue;
    }

    const categoryDisplayName = await categoryDisplayNameOf(budget.categoryName);
    const deepLink = `/app/budgets?budgetId=${budget.id}`;
    // A budget measured separately says so: the amounts in the message are the own share, not the full spending
    const ownNote = measure === 'OWN_SHARE' ? ' (sua parte)' : '';
    const overBudgetAmount = spending - limit;
    const title = reaches100 ? `Orçamento ${categoryDisplayName} excedido!` : `Orçamento ${categoryDisplayName} atingiu 75%`;
    const message = reaches100
      ? `Você excedeu o orçamento de ${categoryDisplayName} em ${overBudgetAmount.toFixed(2)} este mês. O limite era ${limit.toFixed(2)} e você gastou ${spending.toFixed(2)}${ownNote}.`
      : `Você já gastou ${roundedPercentage.toFixed(2)}% do orçamento de ${categoryDisplayName} este mês${ownNote}. Restam ${((100 - roundedPercentage) * limit / 100).toFixed(2)} para o final do mês.`;

    for (const member of members) {
      if (member.user) {
        try {
          const notification = await createNotification({
            userId: member.user.id,
            type: NotificationType.BUDGET_ALERT,
            title,
            message,
            metadata: {
              budgetId: budget.id,
              householdId,
              categoryName: budget.categoryName,
              percentage: roundedPercentage,
              spending,
              fullSpending,
              measure,
              limit,
              ...(reaches100 ? { overBudget: overBudgetAmount } : {}),
              month: notificationsStart.toISOString(),
            },
            deepLink,
          });
          notifications.push(notification);
        } catch (error) {
          console.error(`[checkBudgetThresholds] Error creating ${reaches100 ? '100%' : '75%'} notification for user ${member.user.id}:`, error);
        }
      }
    }
  }

  return notifications;
}
