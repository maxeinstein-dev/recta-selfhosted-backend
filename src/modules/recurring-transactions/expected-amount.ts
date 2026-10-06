import { businessDaysInMonth } from './br-calendar.js';

/**
 * THE single extension point for "what amount does the next occurrence of a recurrence carry".
 *
 * Each recurrence has a forecast strategy (`forecastStrategy`, default LAST so nothing changes for existing rows):
 *  - LAST: the recurrence amount, which `followLastAmount` keeps equal to the last confirmed value (today's behaviour).
 *  - FIXED: the typed amount; a confirmed value never replaces it.
 *  - CONSERVATIVE: income = the SMALLEST of the last N confirmed values, expense = the LARGEST (N defaults to 6 for an
 *    income and 3 for an expense). With fewer than N confirmed it uses those there are; with none, the recurrence amount.
 *  - PER_BUSINESS_DAY: `dailyRate` x the business days of the REFERENCE month, minus `safetyBusinessDays` (never below
 *    zero). Business days follow the Brazilian calendar of `br-calendar.ts` (+ the recurrence's optional holidays and
 *    "dias sem vale"). Without a daily rate it falls back to the recurrence amount.
 *
 * `history` holds the confirmed (paid) occurrences, newest first; `referenceMonth` is the 'YYYY-MM' the occurrence counts
 * for. Pure, and all money is computed in integer cents.
 */
export const FORECAST_STRATEGIES = ['LAST', 'FIXED', 'CONSERVATIVE', 'PER_BUSINESS_DAY'] as const;
export type ForecastStrategy = (typeof FORECAST_STRATEGIES)[number];

/** Default size of the CONSERVATIVE window, by the kind of the recurrence. */
export const DEFAULT_CONSERVATIVE_WINDOW = { INCOME: 6, EXPENSE: 3 } as const;
/** Largest window a recurrence may ask for. */
export const MAX_CONSERVATIVE_WINDOW = 36;

export interface ExpectedAmountRecurrence {
  amount: number;
  followLastAmount?: boolean;
  /** Absent / null = LAST. */
  forecastStrategy?: ForecastStrategy | string | null;
  /** Kind of the recurrence (decides min vs max of CONSERVATIVE); absent = EXPENSE. */
  type?: 'INCOME' | 'EXPENSE';
  /** N of CONSERVATIVE; null/absent = the default of the kind. */
  forecastWindow?: number | null;
  /** Amount per business day (PER_BUSINESS_DAY). */
  dailyRate?: number | null;
  /** Business days discounted from the month (PER_BUSINESS_DAY), >= 0. */
  safetyBusinessDays?: number | null;
  /** "Dias sem vale": 'MM-DD' or 'YYYY-MM-DD'. */
  nonWorkingDays?: readonly string[] | null;
  /** 'CARNIVAL' / 'CORPUS_CHRISTI'. */
  optionalHolidays?: readonly string[] | null;
}

export interface ConfirmedOccurrence {
  amount: number;
  date: string;
  competenceMonth?: string | null;
}

/** How an expected amount was reached, for the screens (the amount is always `amount`). */
export interface ExpectedAmountDetail {
  amount: number;
  strategy: ForecastStrategy;
  /** PER_BUSINESS_DAY: business days of the reference month before the margin, the margin and the days that count. */
  businessDays?: number;
  safetyBusinessDays?: number;
  countedBusinessDays?: number;
  dailyRate?: number;
  /** CONSERVATIVE: the window asked for and the confirmed values it used, newest first. */
  window?: number;
  usedValues?: number[];
  /** True when the strategy had nothing to work with and the recurrence amount was used. */
  fellBack?: boolean;
}

const toCents = (value: number): number => Math.round(value * 100 + (value < 0 ? -1e-6 : 1e-6));
const fromCents = (cents: number): number => cents / 100;

export function normalizeStrategy(value: unknown): ForecastStrategy {
  return (FORECAST_STRATEGIES as readonly string[]).includes(value as string) ? (value as ForecastStrategy) : 'LAST';
}

/** N of CONSERVATIVE for a recurrence: its own, else the default of its kind. */
export function conservativeWindowOf(recurrence: Pick<ExpectedAmountRecurrence, 'forecastWindow' | 'type'>): number {
  const own = recurrence.forecastWindow;
  if (typeof own === 'number' && Number.isInteger(own) && own >= 1) return Math.min(own, MAX_CONSERVATIVE_WINDOW);
  return recurrence.type === 'INCOME' ? DEFAULT_CONSERVATIVE_WINDOW.INCOME : DEFAULT_CONSERVATIVE_WINDOW.EXPENSE;
}

/** The amount of an occurrence and how it was reached. */
export function explainExpectedAmount(
  recurrence: ExpectedAmountRecurrence,
  history: readonly ConfirmedOccurrence[],
  referenceMonth: string,
): ExpectedAmountDetail {
  const strategy = normalizeStrategy(recurrence.forecastStrategy);
  const fallback: ExpectedAmountDetail = { amount: recurrence.amount, strategy, fellBack: true };

  if (strategy === 'CONSERVATIVE') {
    const window = conservativeWindowOf(recurrence);
    const used = history.slice(0, window).map((h) => toCents(h.amount)).filter((c) => Number.isFinite(c) && c > 0);
    if (used.length === 0) return { ...fallback, window, usedValues: [] };
    const pick = recurrence.type === 'INCOME' ? Math.min(...used) : Math.max(...used);
    return { amount: fromCents(pick), strategy, window, usedValues: used.map(fromCents) };
  }

  if (strategy === 'PER_BUSINESS_DAY') {
    const rate = recurrence.dailyRate;
    if (rate === null || rate === undefined || !(rate > 0) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(referenceMonth)) return fallback;
    const businessDays = businessDaysInMonth(referenceMonth, { optionalHolidays: recurrence.optionalHolidays, nonWorkingDays: recurrence.nonWorkingDays });
    const safety = Math.max(0, Math.trunc(recurrence.safetyBusinessDays ?? 0));
    const counted = Math.max(0, businessDays - safety);
    return {
      amount: fromCents(toCents(rate) * counted),
      strategy,
      businessDays,
      safetyBusinessDays: safety,
      countedBusinessDays: counted,
      dailyRate: fromCents(toCents(rate)),
    };
  }

  // LAST and FIXED both carry the recurrence amount; they differ in whether a confirmed value ever replaces it
  // (followLastAmount, only under LAST).
  return { amount: recurrence.amount, strategy };
}

export function expectedAmountFor(
  recurrence: ExpectedAmountRecurrence,
  history: readonly ConfirmedOccurrence[],
  referenceMonth: string,
): number {
  return explainExpectedAmount(recurrence, history, referenceMonth).amount;
}
