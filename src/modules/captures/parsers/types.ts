import type { CaptureKind } from '../captures.schema.js';

/** Why the user should look twice at a reading. POSSIBLE_OWN_TRANSFER: money that may come from another own account. */
export type CaptureWarning = 'POSSIBLE_OWN_TRANSFER';

/** What a parser understood from one notification. */
export interface ParsedCapture {
  /** `IGNORE`: a recognized notice that is not a transaction (limit, advertising); the capture is dismissed. */
  kind: CaptureKind | 'IGNORE';
  /** null when the notification is not a transaction (notices). */
  type: 'INCOME' | 'EXPENSE' | null;
  /** Integer cents, positive; null for notices or when the (cut) text carries none. The source of `amount`. */
  amountCents: number | null;
  /** amountCents / 100 (reais): what the draft and the confirm body use. */
  amount: number | null;
  /** The draft description (merchant, "Estorno: X", or a short label). */
  description: string | null;
  /** The merchant as written, when the text names one. */
  merchant?: string;
  /** How the money moved, when the text says it. */
  method?: 'CREDIT' | 'NUPAY' | 'PIX' | 'TRANSFER';
  /** true: the capture must not become a draft (it is stored as DISMISSED, and can be restored). */
  ignore?: true;
  /** Last four digits of the card, when the text carries them. */
  cardLast4?: string;
  /** "em Nx" of the text, when present. Informative only: the draft does not create installments. */
  installments?: number;
  warning?: CaptureWarning;
}

export interface ParserInput {
  package: string;
  title: string | null;
  text: string;
}

export type AppParser = (input: { title: string | null; text: string }) => ParsedCapture | null;
