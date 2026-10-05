import { Prisma } from '../../generated/prisma/client.js';
import { ConflictError } from '../../shared/errors/app-error.js';
import { normalizeLabel } from '../transactions/maxfin-import.helpers.js';

/** The Prisma client or an interactive-transaction client: every helper works inside or outside a transaction. */
export type Db = Prisma.TransactionClient;

/** True for a unique-constraint violation (P2002), the loser of a race on a unique key. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

/** Runs a write, answering 409 when it loses a unique-key race instead of surfacing a 500. */
export async function conflictOnUnique<T>(message: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(message);
    throw error;
  }
}

/** A decimal(12,2) value from integer cents. */
export function decimalFromCents(cents: number): Prisma.Decimal {
  return new Prisma.Decimal((cents / 100).toFixed(2));
}

/** Lookup key of a name or alias: lower case, no accents, single spaces. */
export function labelKey(label: string): string {
  return normalizeLabel(label);
}

/**
 * The text of a person as written in a note: a leading "*" (the sheet's marker for "paid by them") and stray
 * spaces are not part of the name.
 */
export function cleanPersonName(raw: string): string {
  return raw.replace(/^[\s*]+/, '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

export interface KeyRow {
  label: string;
  key: string;
  isName: boolean;
}

/**
 * The lookup rows of a person: the name first, then the aliases, one per distinct key (an alias that repeats the
 * name or an earlier alias is dropped, not an error).
 */
export function buildKeyRows(name: string, aliases: readonly string[]): KeyRow[] {
  const rows: KeyRow[] = [];
  const seen = new Set<string>();
  const add = (label: string, isName: boolean) => {
    const trimmed = label.trim();
    const key = labelKey(trimmed);
    if (key === '' || seen.has(key)) return;
    seen.add(key);
    rows.push({ label: trimmed, key, isName });
  };
  add(name, true);
  for (const alias of aliases) add(alias, false);
  return rows;
}

/** At most this many warnings travel in a response; the rest is summarized. */
export const MAX_WARNINGS = 50;

export function capWarnings(warnings: string[]): string[] {
  if (warnings.length <= MAX_WARNINGS) return warnings;
  return [...warnings.slice(0, MAX_WARNINGS), `... e mais ${warnings.length - MAX_WARNINGS} avisos`];
}

/** Rows per INSERT: Postgres takes at most 32767 bound values per statement, and a share is 8 of them. */
export const INSERT_CHUNK = 1000;

export function chunks<T>(items: readonly T[], size = INSERT_CHUNK): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}
