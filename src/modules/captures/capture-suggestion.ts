import type { CaptureKind } from './captures.schema.js';

/** What the web app pre-fills when a capture is opened as a draft. Every field but `date` is null until a parser exists. */
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
  /** Output of a parser (null while there is none). Only `kind` is read today. */
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

/**
 * Pure: builds the draft suggestion of one capture from its stored fields and the household's account rules.
 * Without a parser the date is the only certain field; the account is suggested only when the parser gave a `kind`
 * and a rule maps (package, kind) to an account. Parser-filled fields (type, amount, description, category) are
 * added here once they exist.
 */
export function buildSuggestion(capture: SuggestionInput, rules: readonly SuggestionRule[]): CaptureSuggestion {
  const kind = parsedKind(capture.parsed);
  const rule = kind ? rules.find((r) => r.package === capture.package && r.kind === kind) : undefined;
  return {
    type: null,
    accountId: rule?.accountId ?? null,
    categoryName: null,
    amount: null,
    description: null,
    date: capture.postedAt.toISOString(),
  };
}
