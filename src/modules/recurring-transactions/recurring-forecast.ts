import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError } from '../../shared/errors/index.js';
import { CategoryType, getCategoriesByType } from '../../shared/enums/index.js';
import { isCustomCategoryName, toCustomCategoryId } from '../../shared/utils/categoryHelpers.js';
import { addMonths, monthOfDate } from '../../shared/utils/competence.js';
import { conservativeWindowOf, explainExpectedAmount, normalizeStrategy } from './expected-amount.js';
import type { ConfirmedOccurrence, ExpectedAmountDetail, ExpectedAmountRecurrence, ForecastStrategy } from './expected-amount.js';
import { dayString } from './recurring-dates.js';

/** The columns of a recurrence row that decide its forecast. */
export interface ForecastRow {
  amount: { toNumber(): number };
  followLastAmount?: boolean | null;
  forecastStrategy?: string | null;
  forecastWindow?: number | null;
  dailyRate?: { toNumber(): number } | null;
  safetyBusinessDays?: number | null;
  nonWorkingDays?: string[] | null;
  optionalHolidays?: string[] | null;
  competenceOffsetMonths?: number | null;
}

/** Input of `expectedAmountFor` for a stored recurrence of the given kind. */
export function forecastInputOf(row: ForecastRow, isIncome: boolean): ExpectedAmountRecurrence {
  return {
    amount: row.amount.toNumber(),
    followLastAmount: row.followLastAmount === true,
    forecastStrategy: normalizeStrategy(row.forecastStrategy),
    type: isIncome ? 'INCOME' : 'EXPENSE',
    forecastWindow: row.forecastWindow ?? null,
    dailyRate: row.dailyRate ? row.dailyRate.toNumber() : null,
    safetyBusinessDays: row.safetyBusinessDays ?? 0,
    nonWorkingDays: row.nonWorkingDays ?? [],
    optionalHolidays: row.optionalHolidays ?? [],
  };
}

/** The month an occurrence dated `date` counts for: its date month moved by the recurrence offset. */
export function referenceMonthOf(date: Date, offsetMonths: number | null | undefined): string {
  return offsetMonths != null ? addMonths(monthOfDate(date), offsetMonths) : monthOfDate(date);
}

/** True when the category is an income one (custom categories carry their own type). */
export async function isIncomeCategory(db: Pick<typeof prisma, 'category'>, householdId: string, categoryName: string): Promise<boolean> {
  if (isCustomCategoryName(categoryName)) {
    const cat = await db.category.findFirst({ where: { id: toCustomCategoryId(categoryName)!, householdId }, select: { type: true } });
    return cat?.type === CategoryType.INCOME;
  }
  return getCategoriesByType(CategoryType.INCOME).includes(categoryName as never);
}

/**
 * The last CONFIRMED (paid) occurrences of a recurrence, newest first, as many as its strategy can use. Only CONSERVATIVE
 * reads the history, so the other strategies cost no query.
 */
export async function loadConfirmedHistory(
  db: Pick<typeof prisma, 'transaction'> | Prisma.TransactionClient,
  recurring: { id: string; householdId: string; forecastStrategy?: string | null; forecastWindow?: number | null },
  isIncome: boolean,
): Promise<ConfirmedOccurrence[]> {
  if (normalizeStrategy(recurring.forecastStrategy) !== 'CONSERVATIVE') return [];
  const rows = await db.transaction.findMany({
    where: { householdId: recurring.householdId, recurringTransactionId: recurring.id, paid: true },
    select: { amount: true, date: true, competenceMonth: true },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    take: conservativeWindowOf({ forecastWindow: recurring.forecastWindow, type: isIncome ? 'INCOME' : 'EXPENSE' }),
  });
  return rows.map((r) => ({ amount: r.amount.toNumber(), date: dayString(r.date), competenceMonth: r.competenceMonth }));
}

/** What an occurrence of a recurrence is expected to carry, and how it was reached. */
export interface NextForecast extends ExpectedAmountDetail {
  /** 'YYYY-MM' the amount is for. */
  referenceMonth: string;
}

/** The recurrences a batch is computed for (one household). */
export type BatchRow = ForecastRow & { id: string; householdId: string; categoryName: string };

/**
 * The inputs of `expectedAmountFor` for MANY recurrences of one household at once (lists, the dashboard and the card
 * statement forecast): one category query for the custom categories and one transaction query for the history of the
 * CONSERVATIVE ones, instead of one query per recurrence. `expected(row, referenceMonth)` is then pure.
 */
export async function forecastBatch(
  db: Pick<Prisma.TransactionClient, 'transaction'> & Partial<Pick<Prisma.TransactionClient, 'category'>>,
  rows: readonly BatchRow[],
): Promise<{
  isIncome(row: BatchRow): boolean;
  history(row: BatchRow): ConfirmedOccurrence[];
  expected(row: BatchRow, referenceMonth: string): NextForecast;
}> {
  const incomeBuiltIn = new Set<string>(getCategoriesByType(CategoryType.INCOME));
  const customTypes = new Map<string, string>();
  const customIds = [...new Set(rows.filter((r) => isCustomCategoryName(r.categoryName)).map((r) => toCustomCategoryId(r.categoryName)!))];
  if (customIds.length > 0 && db.category) {
    const cats = await db.category.findMany({ where: { householdId: rows[0]!.householdId, id: { in: customIds } }, select: { id: true, type: true } });
    for (const c of cats) customTypes.set(c.id, c.type);
  }
  const isIncome = (row: BatchRow): boolean =>
    isCustomCategoryName(row.categoryName)
      ? customTypes.get(toCustomCategoryId(row.categoryName)!) === CategoryType.INCOME
      : incomeBuiltIn.has(row.categoryName);

  const conservative = rows.filter((r) => normalizeStrategy(r.forecastStrategy) === 'CONSERVATIVE');
  const histories = new Map<string, ConfirmedOccurrence[]>();
  if (conservative.length > 0) {
    const found = await db.transaction.findMany({
      where: { householdId: conservative[0]!.householdId, recurringTransactionId: { in: conservative.map((r) => r.id) }, paid: true },
      select: { recurringTransactionId: true, amount: true, date: true, competenceMonth: true },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
    for (const t of found) {
      if (!t.recurringTransactionId) continue;
      const list = histories.get(t.recurringTransactionId) ?? [];
      list.push({ amount: t.amount.toNumber(), date: dayString(t.date), competenceMonth: t.competenceMonth });
      histories.set(t.recurringTransactionId, list);
    }
    for (const r of conservative) {
      histories.set(r.id, (histories.get(r.id) ?? []).slice(0, conservativeWindowOf({ forecastWindow: r.forecastWindow, type: isIncome(r) ? 'INCOME' : 'EXPENSE' })));
    }
  }
  const history = (row: BatchRow): ConfirmedOccurrence[] => histories.get(row.id) ?? [];
  return {
    isIncome,
    history,
    expected: (row, referenceMonth) => ({ ...explainExpectedAmount(forecastInputOf(row, isIncome(row)), history(row), referenceMonth), referenceMonth }),
  };
}

/** The strategy rules that span fields: refuses a recurrence that could not compute its amount. */
export function assertForecastConsistent(merged: {
  forecastStrategy: ForecastStrategy;
  dailyRate: number | null;
  frequency: string;
}): void {
  if (merged.forecastStrategy !== 'PER_BUSINESS_DAY') return;
  if (merged.dailyRate === null || !(merged.dailyRate > 0)) {
    throw new BadRequestError('dailyRate is required (greater than zero) for the PER_BUSINESS_DAY strategy');
  }
  if (merged.frequency !== 'MONTHLY') {
    throw new BadRequestError('The PER_BUSINESS_DAY strategy needs a MONTHLY recurrence');
  }
}
