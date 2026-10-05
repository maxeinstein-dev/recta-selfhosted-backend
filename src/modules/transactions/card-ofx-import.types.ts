/**
 * HTTP contract of the card invoice OFX importer (phase 3 of the MaxFin importer):
 *   POST /transactions/import/card-ofx/preview  (multipart: file .ofx, accountId, options JSON optional)
 *   POST /transactions/import/card-ofx/confirm  (application/json: CardOfxConfirmRequest)
 *
 * The frontend builds against these shapes: keep them free of Prisma types and of internal helper types.
 */
import type { MaxFinCategoryMapEntry, MaxFinCategoryMapInput } from './maxfin-import.types.js';

export interface CardOfxOptionsInput {
  /** Invoice month when the one derived from the statement (DTEND and the card's due and closing days) is wrong. */
  monthOverride?: { year: number; month: number };
}

export type CardOfxKind = 'purchase' | 'refund' | 'discount' | 'payment';
export type CardOfxStatus = 'reconciled' | 'proposed' | 'payment';

export interface CardOfxLine {
  /** ofx:<FITID>:<8 hex> */
  ref: string;
  fitid: string;
  /** YYYY-MM-DD */
  date: string;
  /** > 0 */
  amount: number;
  /** purchase = EXPENSE; refund and discount = INCOME; payment = INCOME (never becomes a transaction). */
  type: 'INCOME' | 'EXPENSE';
  kind: CardOfxKind;
  memo: string;
  /** The memo without " - Parcela N/M" and " - NuPay". */
  merchant: string;
  installment: { number: number; total: number } | null;
  status: CardOfxStatus;
  /** Proposal the line belongs to. */
  group: string | null;
}

export type CardOfxProposalKind = 'enrich-exact' | 'enrich-plan' | 'enrich-sum' | 'consume-future' | 'create' | 'reversal';

export interface CardOfxTransactionRef {
  transactionId: string;
  description: string;
  amount: number;
  type: 'INCOME' | 'EXPENSE';
  /** YYYY-MM-DD */
  date: string;
  sourceRef: string | null;
}

export interface CardOfxProposal {
  /** Deterministic id: kind + sorted refs + target transaction (the confirm recomputes and compares). */
  group: string;
  kind: CardOfxProposalKind;
  /** OFX lines covered. */
  refs: string[];
  /** false for an ambiguous sum, a reversal pair, and new purchases in a month that has sheet rows. */
  defaultSelected: boolean;
  ambiguous: boolean;
  target: null | CardOfxTransactionRef;
  /** How the target ends up (enrich and consume). */
  result: null | { date: string; description: string; notesAppend: string | null };
  /** create: future installments that will be generated. */
  futureInstallments: number;
}

export type CardOfxSheetOnly = CardOfxTransactionRef;

export interface CardOfxPayment {
  /** The "Pagamento recebido" taken as the previous invoice's payment. */
  ref: string;
  amount: number;
  date: string;
  /** Invoice it pays (the previous month), YYYY-MM. */
  invoiceMonthKey: string;
  /**
   * The recorded payment (amounts summed when there are several). sourceAccountId is null when its account can no
   * longer pay an invoice (deleted, inactive): an adjust then needs the confirm's payment.sourceAccountId.
   */
  recorded: null | { transactionId: string; amount: number; date: string; sourceAccountId: string | null };
  proposal: 'ok' | 'adjust' | 'create';
}

export interface CardOfxPreviewResponse {
  accountId: string;
  householdId: string;
  month: { year: number; month: number };
  monthKey: string;
  monthSource: 'statement' | 'override';
  period: { start: string; end: string };
  /** Purchases minus refunds and discounts (payments left out). */
  ofxTotal: number;
  lines: CardOfxLine[];
  proposals: CardOfxProposal[];
  sheetOnly: CardOfxSheetOnly[];
  payment: CardOfxPayment | null;
  /** Merchants of the create proposals (same format as the monthly sheet's). */
  categoryMap: MaxFinCategoryMapEntry[];
  /**
   * lines: every OFX line; reconciled: lines already reconciled; proposals: proposals of every kind; create:
   * create proposals (one per purchase, i.e. per FITID); sheetOnly: sheet rows left without a line.
   */
  totals: { lines: number; reconciled: number; proposals: number; create: number; sheetOnly: number };
  warnings: string[];
}

export type CardOfxConfirmLine = Pick<
  CardOfxLine,
  'ref' | 'fitid' | 'date' | 'amount' | 'type' | 'kind' | 'memo' | 'merchant' | 'installment'
>;

export interface CardOfxConfirmRequest {
  accountId: string;
  monthKey: string;
  /** The preview's lines, echoed (up to 1000). */
  lines: CardOfxConfirmLine[];
  selectedGroups: string[];
  /** For the create proposals. */
  categoryMap: MaxFinCategoryMapInput[];
  /**
   * sourceAccountId is required when the payment proposal is 'create', and for an 'adjust' whose
   * recorded.sourceAccountId is null; otherwise an adjust pays again from the recorded payment's account.
   */
  payment: null | { apply: boolean; sourceAccountId?: string };
}

export interface CardOfxConfirmResponse {
  enriched: number;
  consumedFutures: number;
  /** Transactions created from create proposals (future installments and reversal pairs apart). */
  created: number;
  futureInstallments: number;
  /** Transactions created from reversal pairs (two per pair). */
  reversalsImported: number;
  payment: null | { action: 'adjusted' | 'created'; transactionId: string; amount: number; date: string };
  /** Selected groups that no longer exist in the recomputation (or were applied meanwhile by another confirm). */
  skipped: number;
  createdCategories: Array<{ id: string; name: string; type: 'INCOME' | 'EXPENSE' }>;
  warnings: string[];
}
