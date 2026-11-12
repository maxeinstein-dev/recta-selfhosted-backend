import { daysInMonth } from './recurring-dates.js';

/**
 * "Desconto por pagar antes do vencimento": a recurrence may cost less when paid up to a day of the month.
 *
 * - FIXED: a value in reais taken off the amount.
 * - PERCENT: a percentage taken off, and the result is rounded UP to the cent (129.95 - 5% = 123.4525 -> 123.46).
 *
 * The limit day belongs to the month of the occurrence date (its due date). Up to and including that day the discounted
 * amount is the expected one; from the next day on, the full amount. A limit day past the end of the month is the last
 * day of the month. Pure; all money is computed in integer cents.
 */
export const EARLY_DISCOUNT_TYPES = ['FIXED', 'PERCENT'] as const;
export type EarlyDiscountType = (typeof EARLY_DISCOUNT_TYPES)[number];

export interface EarlyDiscount {
  /** 1..31 */
  day: number;
  type: EarlyDiscountType;
  /** Reais (FIXED) or percent (PERCENT). */
  value: number;
}

/** What a screen needs to warn "pay by {limitDate} and save {savings}". */
export interface EarlyDiscountQuote {
  /** 'YYYY-MM-DD' last day the discount is valid (inclusive). */
  limitDate: string;
  fullAmount: number;
  discountedAmount: number;
  savings: number;
}

const toCents = (value: number): number => Math.round(value * 100 + (value < 0 ? -1e-6 : 1e-6));
const fromCents = (cents: number): number => cents / 100;

function discountedCents(fullCents: number, discount: Pick<EarlyDiscount, 'type' | 'value'> & { day?: number }): number {
  if (discount.type === 'FIXED') return fullCents - toCents(discount.value);
  // Basis points keep the percentage exact; the division is an integer ceiling, so nothing drifts in binary.
  const basisPoints = toCents(discount.value);
  return Math.ceil((fullCents * (10_000 - basisPoints)) / 10_000);
}

/** The amount after the discount (rounded up to the cent for a percentage). */
export function discountedAmount(full: number, discount: Pick<EarlyDiscount, 'type' | 'value'> & { day?: number }): number {
  return fromCents(discountedCents(toCents(full), discount));
}

/** Last day ('YYYY-MM-DD') the discount is valid for an occurrence dated `occurrenceDate`: same month, clamped. */
export function earlyDiscountLimit(occurrenceDate: string, day: number): string {
  const year = Number(occurrenceDate.slice(0, 4));
  const month = Number(occurrenceDate.slice(5, 7));
  const clamped = Math.min(day, daysInMonth(year, month));
  return `${occurrenceDate.slice(0, 8)}${String(clamped).padStart(2, '0')}`;
}

/** The discount config of a stored recurrence (all three columns or none); null for a recurrence without one. */
export function earlyDiscountOf(row: {
  earlyDiscountDay?: number | null;
  earlyDiscountType?: string | null;
  earlyDiscountValue?: { toNumber(): number } | number | null;
}): EarlyDiscount | null {
  const { earlyDiscountDay: day, earlyDiscountType: type, earlyDiscountValue: raw } = row;
  if (day == null || type == null || raw == null) return null;
  if (!(EARLY_DISCOUNT_TYPES as readonly string[]).includes(type)) return null;
  return { day, type: type as EarlyDiscountType, value: typeof raw === 'number' ? raw : raw.toNumber() };
}

/** True when the discount takes a positive amount to something above zero and below the amount. */
function takesEffect(fullCents: number, discount: EarlyDiscount): boolean {
  if (fullCents <= 0) return false;
  const after = discountedCents(fullCents, discount);
  return after > 0 && after < fullCents;
}

/**
 * The quote of an occurrence while the discount can still be had (`today` <= the limit date); null otherwise (no
 * discount, the limit passed, or a discount that would leave the amount at zero or leave it unchanged).
 */
export function earlyDiscountQuote(
  full: number,
  discount: EarlyDiscount | null,
  occurrenceDate: string,
  today: string,
): EarlyDiscountQuote | null {
  if (!discount) return null;
  const fullCents = toCents(full);
  if (!takesEffect(fullCents, discount)) return null;
  const limitDate = earlyDiscountLimit(occurrenceDate, discount.day);
  if (today > limitDate) return null;
  const afterCents = discountedCents(fullCents, discount);
  return { limitDate, fullAmount: fromCents(fullCents), discountedAmount: fromCents(afterCents), savings: fromCents(fullCents - afterCents) };
}

/** The amount an occurrence is expected to carry as of `today`: discounted up to the limit day, full after it. */
export function amountOnDay(full: number, discount: EarlyDiscount | null, occurrenceDate: string, today: string): number {
  const quote = earlyDiscountQuote(full, discount, occurrenceDate, today);
  return quote ? quote.discountedAmount : full;
}

/** The rule across fields: null when coherent, else the message of the first problem. */
export function validateEarlyDiscount(input: { day: number; type: EarlyDiscountType; value: number; amount: number }): string | null {
  const { day, type, value, amount } = input;
  if (!Number.isInteger(day) || day < 1 || day > 31) return 'The discount day must be a whole number from 1 to 31';
  if (!(amount > 0)) return 'A discount needs a recurrence amount greater than zero';
  if (type === 'PERCENT') {
    if (!(value > 0 && value < 100)) return 'The discount percentage must be between 0 and 100 (exclusive)';
  } else {
    if (!(value > 0)) return 'The fixed discount must be greater than zero';
    if (!(value < amount)) return 'The fixed discount must be less than the amount';
  }
  if (!takesEffect(toCents(amount), { day, type, value })) {
    return 'The discount must leave an amount above zero and less than the amount (a percentage is rounded up to the cent)';
  }
  return null;
}
