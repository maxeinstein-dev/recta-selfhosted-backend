import { parseGmail } from './gmail.js';
import { parseMercadoPago } from './mercadopago.js';
import { parseNubank } from './nubank.js';
import type { AppParser, ParsedCapture, ParserInput } from './types.js';

export type { ParsedCapture, ParserInput } from './types.js';

/**
 * Bumped whenever a parser rule changes (a new format, a fixed pattern), so `POST /captures/reparse` can tell which
 * captures were read by an older rule. Stored in `captured_notifications.parser_version`.
 */
export const PARSER_VERSION = 4;

/** One parser per app package. XP is not here on purpose: investments are out of the notification reader. */
const PARSERS: Record<string, AppParser> = {
  'com.nu.production': parseNubank,
  'com.mercadopago.wallet': parseMercadoPago,
  'com.google.android.gm': parseGmail,
};

/** Pure. null = not understood (the capture stays PENDING for the user to fill in by hand). */
export function parseCapture(input: ParserInput): ParsedCapture | null {
  const parser = PARSERS[input.package];
  return parser ? parser({ title: input.title, text: input.text }) : null;
}
