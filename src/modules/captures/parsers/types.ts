import type { CaptureKind } from '../captures.schema.js';

/** What a parser understood from one notification. */
export interface ParsedCapture {
  /**
   * `IGNORE`: a recognized notice that is not a transaction (limit, advertising).
   * `OWN_TRANSFER_IN`: money the user moved between own accounts. Not in CAPTURE_KINDS on purpose (no account rule
   * can match it) and `type` is null: the capture stays PENDING and the user decides, so nothing becomes income alone.
   */
  kind: CaptureKind | 'OWN_TRANSFER_IN' | 'IGNORE';
  /** null when the notification is not a transaction (ignored notices) or has no direction. */
  type: 'INCOME' | 'EXPENSE' | null;
  /** Reais, positive; null when ignored or when the (cut) text carries none. */
  amount: number | null;
  /** Merchant or a short label; the draft description. */
  description: string | null;
  /** true: the capture must not become a draft (it is stored as IGNORED). */
  ignore?: true;
  /** Last four digits of the card, when the text carries them. */
  cardLast4?: string;
  /** "em Nx" of the text, when present. Informative only: the draft does not create installments. */
  installments?: number;
}

export interface ParserInput {
  package: string;
  title: string | null;
  text: string;
}

export type AppParser = (input: { title: string | null; text: string }) => ParsedCapture | null;
