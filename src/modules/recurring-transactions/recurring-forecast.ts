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

/** What the next occurrence of a recurrence is expected to carry, for the lists. */
export interface NextForecast extends ExpectedAmountDetail {
  /** 'YYYY-MM' the next occurrence counts for. */
  referenceMonth: string;
}

export async function nextForecastOf(
  row: ForecastRow & { id: string; householdId: string; nextRunAt: Date },
  isIncome: boolean,
): Promise<NextForecast> {
  const history = await loadConfirmedHistory(prisma, row, isIncome);
  const referenceMonth = referenceMonthOf(row.nextRunAt, row.competenceOffsetMonths);
  return { ...explainExpectedAmount(forecastInputOf(row, isIncome), history, referenceMonth), referenceMonth };
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
