import type { CaptureKind } from './captures.schema.js';

/**
 * What the web app pre-fills when a capture is opened as a draft. Type, amount and description come from the parser
 * (null when it did not understand the text); the category is always null for now: no rule of the household
 * defines it from a notification, and none is invented here.
 */
export interface CaptureSuggestion {
  type: 'INCOME' | 'EXPENSE' | null;
  accountId: string | null;
  categoryName: string | null;
  amount: number | null;
  description: string | null;
  /** The instant the notification was posted (ISO 8601); the client turns it into the transaction day. */
  date: string;
}

export interface SuggestionRule {
  package: string;
  kind: string;
  accountId: string;
}

export interface SuggestionInput {
  package: string;
  postedAt: Date;
  /** Output of a parser (null when the text was not understood). */
  parsed: unknown;
}

/** `parsed.kind` when the parser recognized the notification, else null. */
export function parsedKind(parsed: unknown): CaptureKind | string | null {
  if (parsed && typeof parsed === 'object' && 'kind' in parsed) {
    const kind = (parsed as { kind?: unknown }).kind;
    if (typeof kind === 'string' && kind.length > 0) return kind;
  }
  return null;
}

function parsedField(parsed: unknown, key: string): unknown {
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[key] : undefined;
}

/**
 * Pure: builds the draft suggestion of one capture from its stored fields and the household's account rules.
 * Without a reading the date is the only certain field; the account is suggested only when the parser gave a `kind`
 * and a rule maps (package, kind) to an account. Fields of the wrong shape are dropped to null, never guessed.
 */
export function buildSuggestion(capture: SuggestionInput, rules: readonly SuggestionRule[]): CaptureSuggestion {
  const kind = parsedKind(capture.parsed);
  const rule = kind ? rules.find((r) => r.package === capture.package && r.kind === kind) : undefined;
  const type = parsedField(capture.parsed, 'type');
  const amount = parsedField(capture.parsed, 'amount');
  const description = parsedField(capture.parsed, 'description');
  return {
    type: type === 'INCOME' || type === 'EXPENSE' ? type : null,
    accountId: rule?.accountId ?? null,
    categoryName: null,
    amount: typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? amount : null,
    description: typeof description === 'string' && description.length > 0 ? description : null,
    date: capture.postedAt.toISOString(),
  };
}
