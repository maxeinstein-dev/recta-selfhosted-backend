/**
 * THE single extension point for "what amount does the next occurrence of a recurrence carry".
 *
 * Today the answer is the recurrence amount, which `followLastAmount` keeps equal to the last confirmed value
 * (strategy "last value"). A later change can add per-recurrence forecast strategies here without touching the
 * callers: fixed, conservative (min of the last N confirmed for income, max for expenses) and per-business-day rate x
 * business days of the reference month (Brazilian holiday calendar). `history` holds the confirmed occurrences,
 * newest first; `referenceMonth` is the 'YYYY-MM' the occurrence counts for.
 */
export interface ExpectedAmountRecurrence {
  amount: number;
  followLastAmount?: boolean;
  /** Reserved for the strategy field of a later migration; absent today. */
  forecastStrategy?: string | null;
}

export interface ConfirmedOccurrence {
  amount: number;
  date: string;
  competenceMonth?: string | null;
}

export function expectedAmountFor(
  recurrence: ExpectedAmountRecurrence,
  _history: readonly ConfirmedOccurrence[],
  _referenceMonth: string,
): number {
  return recurrence.amount;
}
