import { monthOrRangeWhere } from '../../shared/utils/competence.js';
import { budgetSpendingWhere, measureOf, measuredAmount, ownSpentOf, sumSpending } from './budget-spending.js';
import { pickEffectiveBudgets } from './budget-effective.js';
import { monthOfDate } from '../../shared/utils/competence.js';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { NotFoundError, BadRequestError } from '../../shared/errors/index.js';
import { CategoryType, GENERAL_BUDGET_CATEGORY, getCategoriesByType, getCategoryColor } from '../../shared/enums/index.js';
import { isCustomCategoryName, toCustomCategoryId } from '../../shared/utils/categoryHelpers.js';
import { lockCustomCategory } from '../../shared/utils/categoryLock.js';
import { deductionCents, loadTheirShares } from '../people/own-share.js';
import type {
  CreateBudgetInput,
  UpdateBudgetInput,
  ListBudgetsQuery,
  BudgetSummaryQuery,
} from './budgets.schema.js';


/**
 * First day of the month of `day` (a local-midnight Date from `localDateSchema`) as the UTC-midnight Date a `@db.Date`
 * column holds. Built from the local calendar day, so the month is the one the user picked, and from UTC midnight,
 * so it is the same value the month filters and the budget lookups compare with in any time zone.
 */
export function budgetMonthStart(day: Date): Date {
  return new Date(Date.UTC(day.getFullYear(), day.getMonth(), 1));
}

/**
 * Create a new budget
 */
export async function createBudget(input: CreateBudgetInput) {
  // householdId must be provided (resolved in routes via ensurePersonalHousehold)
  if (!input.householdId) {
    throw new BadRequestError('householdId is required');
  }
  const householdId = input.householdId;

  const { categoryName, monthlyLimit, month, type, measure } = input;

  // Verify category type matches budget type
  if (categoryName === GENERAL_BUDGET_CATEGORY) {
    // General pseudo-category is valid for both INCOME and EXPENSE budgets.
  } else if (isCustomCategoryName(categoryName)) {
    const customId = toCustomCategoryId(categoryName)!;
    const cat = await prisma.category.findFirst({ where: { id: customId, householdId } });
    if (!cat || cat.type !== type) {
      throw new BadRequestError(`Category does not match budget type (${type})`);
    }
  } else {
    const categoriesByType = getCategoriesByType(type);
    if (!categoriesByType.includes(categoryName as any)) {
      throw new BadRequestError(`Category ${categoryName} does not match budget type (${type})`);
    }
  }

  // Normalize month to start of month
  const monthStart = budgetMonthStart(month);

  // Check if budget already exists for this category, month and type.
  // Including type lets a household keep both a general INCOME and a general
  // EXPENSE budget in the same month (GENERAL is shared across both types).
  const existingBudget = await prisma.budget.findFirst({
    where: {
      householdId,
      categoryName,
      month: monthStart,
      type,
    },
  });

  if (existingBudget) {
    throw new BadRequestError('Budget already exists for this category and month');
  }

  const budget = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lockCustomCategory(tx, householdId, categoryName);
    return tx.budget.create({
      data: {
        householdId,
        categoryName,
        monthlyLimit: new Prisma.Decimal(monthlyLimit),
        month: monthStart,
        type,
        measure: measure ?? 'WHOLE',
      },
    });
  });

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    ...budget,
    monthlyLimit: budget.monthlyLimit.toNumber(),
  };
}

/**
 * Get budget by ID
 */
export async function getBudget(budgetId: string) {
  const budget = await prisma.budget.findUnique({
    where: { id: budgetId },
  });

  if (!budget) {
    throw new NotFoundError('Budget');
  }

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    ...budget,
    monthlyLimit: budget.monthlyLimit.toNumber(),
  };
}

/**
 * List budgets for a household
 */
export async function listBudgets(query: ListBudgetsQuery) {
  const { householdId } = query;

  const budgets = await prisma.budget.findMany({
    where: { householdId },
    orderBy: [
      { month: 'desc' },
      { createdAt: 'desc' },
    ],
  });

  // Convert Prisma.Decimal to number for JSON serialization
  return budgets.map(budget => ({
    ...budget,
    monthlyLimit: budget.monthlyLimit.toNumber(),
  }));
}

/**
 * Update budget
 */
export async function updateBudget(budgetId: string, input: UpdateBudgetInput) {
  const updateData: any = {
    ...(input.monthlyLimit !== undefined && {
      monthlyLimit: new Prisma.Decimal(input.monthlyLimit),
    }),
    ...(input.type !== undefined && { type: input.type }),
    ...(input.measure !== undefined && { measure: input.measure }),
  };

  // The own share only exists for expenses: checked against the type the budget ends up with
  if (input.measure === 'OWN_SHARE' || input.type === 'INCOME') {
    const current = await prisma.budget.findUnique({ where: { id: budgetId }, select: { type: true, measure: true } });
    if (!current) throw new NotFoundError('Budget');
    const finalType = input.type ?? current.type;
    const finalMeasure = input.measure ?? current.measure;
    if (finalMeasure === 'OWN_SHARE' && finalType !== 'EXPENSE') {
      throw new BadRequestError('Only an expense budget can be measured by the own share');
    }
  }

  // Normalize month to start of month if provided
  if (input.month) {
    updateData.month = budgetMonthStart(input.month);
  }

  // End month: the last month in force; never before the budget's own first month
  if (input.endMonth !== undefined) {
    updateData.endMonth = input.endMonth ? budgetMonthStart(input.endMonth) : null;
    if (updateData.endMonth) {
      const current = await prisma.budget.findUnique({ where: { id: budgetId }, select: { month: true } });
      if (!current) throw new NotFoundError('Budget');
      const first: Date = updateData.month ?? current.month;
      if (monthOfDate(updateData.endMonth) < monthOfDate(first)) {
        throw new BadRequestError('The end month cannot be before the first month of the budget');
      }
    }
  }

  const budget = await prisma.budget.update({
    where: { id: budgetId },
    data: updateData,
  });

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    ...budget,
    monthlyLimit: budget.monthlyLimit.toNumber(),
  };
}

/**
 * Delete budget
 */
export async function deleteBudget(budgetId: string) {
  const budget = await prisma.budget.findUnique({
    where: { id: budgetId },
  });

  if (!budget) {
    throw new NotFoundError('Budget');
  }

  await prisma.budget.delete({
    where: { id: budgetId },
  });

  return { deleted: true };
}

/**
 * Get budget summary with spending vs limit
 */
export async function getBudgetSummary(query: BudgetSummaryQuery) {
  const { householdId, month, startDate, endDate } = query;

  // A month means the planning month (reference month when set, else the month of the date); a range stays by date.
  const periodWhere = monthOrRangeWhere({ month, startDate, endDate });

  // The budgets of the household; for a month, only the ones in force in it (a budget repeats from its month on)
  const allBudgets = await prisma.budget.findMany({
    where: { householdId },
  });
  const budgets = month ? pickEffectiveBudgets(allBudgets, month) : allBudgets;

  // Resolve colors for custom categories (batch)
  const customIds = budgets
    .filter((b) => isCustomCategoryName(b.categoryName))
    .map((b) => toCustomCategoryId(b.categoryName)!);
  const customCategories = customIds.length
    ? await prisma.category.findMany({ where: { id: { in: customIds }, householdId }, select: { id: true, color: true } })
    : [];
  const customColorMap = new Map(customCategories.map((c) => [c.id, c.color ?? '#64748B']));

  function categoryColor(categoryName: string): string {
    if (isCustomCategoryName(categoryName)) {
      return customColorMap.get(toCustomCategoryId(categoryName)!) ?? '#64748B';
    }
    return getCategoryColor(categoryName as any);
  }

  // What other people owe on the expenses of the period, in one query (only transactions that have shares)
  const theirShares = householdId && budgets.some((b) => b.type === 'EXPENSE')
    ? [...(await loadTheirShares(prisma, householdId, periodWhere as Prisma.TransactionWhereInput)).values()]
    : [];

  // Get spending for each budget category
  const budgetSummaries = await Promise.all(
    budgets.map(async (budget: { categoryName: string; monthlyLimit: Prisma.Decimal; month: Date; endMonth?: Date | null; type: string; measure?: string | null; id: string; householdId: string; createdAt: Date; updatedAt: Date }) => {
      // One definition of what counts, shared with the budget alerts (see budget-spending.ts)
      const transactions = await prisma.transaction.findMany({
        where: budgetSpendingWhere({ householdId, categoryName: budget.categoryName, type: budget.type }, periodWhere),
        select: { amount: true },
      });
      const spending = sumSpending(transactions);

      // Own share: the same spending without the parts other people owe back (expense budgets only)
      const ownSpent = ownSpentOf(budget, spending, theirShares);
      // What the limit is compared with: the own share for a budget measured separately, the spending otherwise
      const measured = measuredAmount(budget, spending, ownSpent);

      const limit = budget.monthlyLimit.toNumber();
      const remaining = (Math.round(limit * 100) - Math.round(measured * 100)) / 100;
      const percentage = limit > 0 ? (measured / limit) * 100 : 0;

      return {
        budgetId: budget.id,
        categoryName: budget.categoryName,
        categoryColor: categoryColor(budget.categoryName),
        monthlyLimit: limit,
        // First month in force and last one (null = no end): the budget repeats in between
        month: monthOfDate(budget.month),
        endMonth: budget.endMonth ? monthOfDate(budget.endMonth) : null,
        measure: measureOf(budget),
        spending,
        ownSpent,
        measured,
        remaining,
        percentage: Math.round(percentage * 100) / 100,
        isOverBudget: measured > limit,
      };
    })
  );

  return {
    budgets: budgetSummaries,
    totalLimit: budgets.reduce((sum: number, b: { monthlyLimit: Prisma.Decimal }) => sum + b.monthlyLimit.toNumber(), 0),
    totalSpending: budgetSummaries.reduce((sum: number, b: { spending: number }) => sum + b.spending, 0),
    totalOwnSpending: budgetSummaries.reduce((sum: number, b: { ownSpent: number }) => sum + b.ownSpent, 0),
  };
}

