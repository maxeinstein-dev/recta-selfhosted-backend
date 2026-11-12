/**
 * Reais as written in a Brazilian notification: "9,90", "1.234,56", "15". Thousands use ".", cents use ",".
 * Null for anything else (so a changed text is "not understood" instead of a wrong value) and for negatives.
 */
export function parseBrlAmount(raw: string): number | null {
  const match = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))?$/.exec(raw.trim());
  if (!match) return null;
  const whole = match[1]!.replace(/\./g, '');
  const value = Number(`${whole}.${match[2] ?? '00'}`);
  return Number.isFinite(value) ? value : null;
}

/** Same as parseBrlAmount but only for a positive value (a transaction amount). */
export function parsePositiveAmount(raw: string): number | null {
  const value = parseBrlAmount(raw);
  return value !== null && value > 0 ? value : null;
}

/** Collapses the runs of spaces a bank pads merchant names with, and trims. */
export function cleanMerchant(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** The reais token of a text: "R$ 1.234,56". */
export const BRL = String.raw`R\$\s*(\d(?:[\d.,]*\d)?)`;
