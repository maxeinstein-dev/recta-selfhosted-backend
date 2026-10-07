import { prisma } from '../../shared/db/prisma.js';
import { NotificationType } from './notifications.schema.js';
import { createNotification } from './notifications.service.js';
import { effectiveMonthWhere, monthOfDate } from '../../shared/utils/competence.js';
import { Prisma } from '../../generated/prisma/client.js';
import { CategoryName, CATEGORY_NAME_DISPLAY } from '../../shared/enums/index.js';
import { isCustomCategoryName, toCustomCategoryId } from '../../shared/utils/categoryHelpers.js';

/**
 * Check budget status and create notifications for 75% and 100% thresholds
 * Called after creating or updating a transaction
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

  const budget = await prisma.budget.findFirst({
    where: {
      householdId,
      categoryName,
      month: budgetMonthStart,
      type: 'EXPENSE',
    },
  });

  if (!budget) {
    return; // No budget for this category
  }

  // Calculate spending for this category in this month
  const transactions = await prisma.transaction.findMany({
    where: {
      householdId,
      categoryName,
      type: 'EXPENSE',
      AND: [effectiveMonthWhere(budgetMonth)],
    },
    select: { amount: true },
  });

  const spending = transactions.reduce((sum, t) => {
    return sum + Math.abs(t.amount.toNumber());
  }, 0);

  const limit = budget.monthlyLimit.toNumber();
  if (limit <= 0) {
    return; // Invalid limit
  }

  const percentage = (spending / limit) * 100;
  const roundedPercentage = Math.round(percentage * 100) / 100;

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

  // Filter notifications for this specific budget and check thresholds
  const budgetNotifications = existingNotifications.filter((n) => {
    const metadata = n.metadata as any;
    return metadata && typeof metadata === 'object' && metadata.budgetId === budget.id;
  });

  // Check which thresholds have already been notified
  const notifiedPercentages = budgetNotifications
    .map((n) => {
      const metadata = n.metadata as any;
      return metadata?.percentage;
    })
    .filter((p): p is number => typeof p === 'number');

  const hasNotified75 = notifiedPercentages.some((p) => p >= 75 && p < 100);
  const hasNotified100 = notifiedPercentages.some((p) => p >= 100);

  // Get category display name (translated)
  let categoryDisplayName: string;
  if (isCustomCategoryName(categoryName)) {
    // For custom categories, fetch the name from database
    const customId = toCustomCategoryId(categoryName);
    if (customId) {
      const customCategory = await prisma.category.findUnique({
        where: { id: customId },
        select: { name: true },
      });
      categoryDisplayName = customCategory?.name || categoryName;
    } else {
      categoryDisplayName = categoryName;
    }
  } else {
    // For system categories, use the display name mapping
    categoryDisplayName = CATEGORY_NAME_DISPLAY[categoryName as CategoryName] || categoryName;
  }

  // Create notifications for all household members
  const notifications = [];

  // 75% threshold notification
  if (roundedPercentage >= 75 && roundedPercentage < 100 && !hasNotified75) {
    const title = `Orçamento ${categoryDisplayName} atingiu 75%`;
    const message = `Você já gastou ${roundedPercentage.toFixed(2)}% do orçamento de ${categoryDisplayName} este mês. Restam ${((100 - roundedPercentage) * limit / 100).toFixed(2)} para o final do mês.`;
    const deepLink = `/app/budgets?budgetId=${budget.id}`;

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
              categoryName,
              percentage: roundedPercentage,
              spending,
              limit,
              month: notificationsStart.toISOString(),
            },
            deepLink,
          });
          notifications.push(notification);
        } catch (error) {
          console.error(`[checkBudgetThresholds] Error creating 75% notification for user ${member.user.id}:`, error);
        }
      }
    }
  }

  // 100% threshold notification (budget exceeded)
  if (roundedPercentage >= 100 && !hasNotified100) {
    const title = `Orçamento ${categoryDisplayName} excedido!`;
    const overBudgetAmount = spending - limit;
    const message = `Você excedeu o orçamento de ${categoryDisplayName} em ${overBudgetAmount.toFixed(2)} este mês. O limite era ${limit.toFixed(2)} e você gastou ${spending.toFixed(2)}.`;
    const deepLink = `/app/budgets?budgetId=${budget.id}`;

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
              categoryName,
              percentage: roundedPercentage,
              spending,
              limit,
              overBudget: overBudgetAmount,
              month: notificationsStart.toISOString(),
            },
            deepLink,
          });
          notifications.push(notification);
        } catch (error) {
          console.error(`[checkBudgetThresholds] Error creating 100% notification for user ${member.user.id}:`, error);
        }
      }
    }
  }

  return notifications;
}
