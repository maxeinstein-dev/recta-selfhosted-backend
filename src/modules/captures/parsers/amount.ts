/** Up to 12 digits of reais (under a trillion): far above any notification, and exact as an integer of cents. */
const BRL_NUMBER = /^(\d{1,3}(?:\.\d{3})+|\d{1,12})(?:,(\d{2}))?$/;

/**
 * Integer cents of reais as written in a Brazilian notification: "9,90", "1.234,56", "15". Thousands use ".", cents
 * use ",". The cents come from the digits (never from multiplying a float), so "0,29" is 29. Null for anything else
 * (a changed text is "not understood" instead of a wrong value) and for negatives.
 */
export function parseBrlCents(raw: string): number | null {
  const match = BRL_NUMBER.exec(raw.trim());
  if (!match) return null;
  const whole = match[1]!.replace(/\./g, '');
  if (whole.length > 12) return null;
  return Number(whole) * 100 + Number(match[2] ?? '0');
}

/** The same reading in reais (cents / 100). */
export function parseBrlAmount(raw: string): number | null {
  const cents = parseBrlCents(raw);
  return cents === null ? null : cents / 100;
}

/** Positive cents only (a transaction amount), else null. */
export function parsePositiveCents(raw: string): number | null {
  const cents = parseBrlCents(raw);
  return cents !== null && cents > 0 ? cents : null;
}

/** Amount fields of a reading: the cents and the same value in reais, which the draft and the confirm body use. */
export function money(cents: number | null): { amountCents: number | null; amount: number | null } {
  return { amountCents: cents, amount: cents === null ? null : cents / 100 };
}

/** Collapses the runs of spaces a bank pads merchant names with, and trims. */
export function cleanMerchant(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** One line, single spaces (also the non-breaking space Android puts after "R$"), trimmed. */
export function normalizeText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** The reais token of a text: "R$ 1.234,56" (any spacing after R$, or none). */
export const BRL = String.raw`R\$\s*(\d(?:[\d.,]*\d)?)`;
