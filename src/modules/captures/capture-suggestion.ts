import { CARD_LAST4_PATTERN, type CaptureKind } from './captures.schema.js';
import type { CaptureWarning } from './parsers/types.js';

/**
 * What the web app pre-fills when a capture is opened as a draft. Type, amount and description come from the parser
 * (null when it did not understand the text); the category is always null for now: no rule of the household
 * defines it from a notification, and none is invented here.
 */
export interface CaptureSuggestion {
  type: 'INCOME' | 'EXPENSE' | null;
  accountId: string | null;
  categoryName: string | null;
  /** Reais (the confirm body takes reais), from the integer cents of the reading. */
  amount: number | null;
  description: string | null;
  /** The instant the notification was posted (ISO 8601); the client turns it into the transaction day. */
  date: string;
  /** Last four digits of the card the notification named, to show next to the suggested account. */
  cardLast4: string | null;
  /** Something the user should look at before confirming (e.g. money that may come from another own account). */
  warning: CaptureWarning | null;
}

export interface SuggestionRule {
  package: string;
  kind: string;
  accountId: string;
}

export interface SuggestionCardRule {
  package: string;
  cardLast4: string;
  accountId: string;
}

export interface SuggestionInput {
  package: string;
  postedAt: Date;
  /** Output of a parser (null when the text was not understood). */
  parsed: unknown;
}

const WARNINGS: readonly CaptureWarning[] = ['POSSIBLE_OWN_TRANSFER'];

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

/** Reais of a reading: from the integer cents (parser v4+), else the reais of an older reading; null if not positive. */
function suggestedAmount(parsed: unknown): number | null {
  const cents = parsedField(parsed, 'amountCents');
  if (cents !== undefined && cents !== null) {
    return typeof cents === 'number' && Number.isSafeInteger(cents) && cents > 0 ? cents / 100 : null;
  }
  const amount = parsedField(parsed, 'amount');
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? amount : null;
}

/**
 * Pure: builds the draft suggestion of one capture from its stored fields and the household's rules.
 * Account: a card-ending rule of the same app wins (one account per card, virtual cards included); else the
 * (package, kind) rule; else none. Fields of the wrong shape are dropped to null, never guessed.
 */
export function buildSuggestion(
  capture: SuggestionInput,
  rules: readonly SuggestionRule[],
  cardRules: readonly SuggestionCardRule[] = []
): CaptureSuggestion {
  const kind = parsedKind(capture.parsed);
  const rawLast4 = parsedField(capture.parsed, 'cardLast4');
  const cardLast4 = typeof rawLast4 === 'string' && CARD_LAST4_PATTERN.test(rawLast4) ? rawLast4 : null;
  const cardRule = kind && cardLast4 ? cardRules.find((r) => r.package === capture.package && r.cardLast4 === cardLast4) : undefined;
  const rule = kind ? rules.find((r) => r.package === capture.package && r.kind === kind) : undefined;
  const type = parsedField(capture.parsed, 'type');
  const description = parsedField(capture.parsed, 'description');
  const warning = parsedField(capture.parsed, 'warning');
  return {
    type: type === 'INCOME' || type === 'EXPENSE' ? type : null,
    accountId: cardRule?.accountId ?? rule?.accountId ?? null,
    categoryName: null,
    amount: suggestedAmount(capture.parsed),
    description: typeof description === 'string' && description.length > 0 ? description : null,
    date: capture.postedAt.toISOString(),
    cardLast4,
    warning: WARNINGS.find((w) => w === warning) ?? null,
  };
}
