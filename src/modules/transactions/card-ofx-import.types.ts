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
  /**
   * purchase = EXPENSE; refund and discount = INCOME; payment = INCOME. A payment line becomes a transaction only as an
   * `advance-payment` proposal (a payment made before the due date that no sheet credit already holds); the previous
   * invoice's payment is handled apart (payment).
   */
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

export type CardOfxProposalKind = 'enrich-exact' | 'enrich-plan' | 'enrich-sum' | 'enrich-merge' | 'enrich-neighbour' | 'enrich-group' | 'enrich-near' | 'consume-future' | 'create' | 'reversal' | 'advance-payment';

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
  /**
   * enrich-merge: the other sheet rows whose amounts the target takes over (they are deleted on apply; their
   * descriptions and amounts go to the target's notes). Empty for every other kind.
   */
  absorbed: CardOfxTransactionRef[];
  /**
   * Why the proposal is not selected by default: 'ambiguous', 'no-shared-words', 'mixed-categories' (merges),
   * 'neighbour-ambiguous' (the line or the row of the adjacent month has other candidates), 'pool-too-large' (groups), 'near-amount' (a few cents apart without a strong signal), 'near-ambiguous', 'neighbour-weak', 'neighbour-month-not-imported',
   * 'sheet-residue' (new purchases while sheet rows of the month are left without a bank line), 'sheet-credit-near' (advance-payment: a left-over sheet credit within 5 cents may be the same payment), 'changed-in-statement' (create: the same purchase is already recorded under another ref because the statement changed its amount, date or memo; counterpart = the recorded row), or null.
   */
  reason: string | null;
  /** 'sheet-residue' on history, 'sheet-credit-near' on an advance payment: the card row left over that the line may be a copy of. */
  counterpart: null | CardOfxTransactionRef;
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

/**
 * Statement closing: the OFX total against the card's transactions in the OFX period (DTSTART..DTEND) as they will
 * be once the proposals selected by default are applied. delta = uncreated + heldMatches - sheetOnlyInPeriod -
 * foreignInPeriod - advancePayments + residual. All amounts in reais, purchases positive.
 */
export interface CardOfxClosing {
  periodStart: string;
  periodEnd: string;
  /** DTEND counts as inside the period only when the OFX lists lines dated on it (otherwise it is the next statement's first day). */
  endInclusive: boolean;
  ofxTotal: number;
  recordedTotal: number;
  /** ofxTotal - recordedTotal: positive = the card holds less than the bank charged. */
  delta: number;
  components: {
    /** Lines of unselected proposals (new purchases, reversal pairs): missing from the card. */
    uncreated: number;
    /** Lines of unselected matches minus the sheet rows standing in for them. */
    heldMatches: number;
    /** Sheet rows of the month with no bank line, dated inside the period. */
    sheetOnlyInPeriod: number;
    /** Other card rows inside the period that this statement does not account for. */
    foreignInPeriod: number;
    /** Sheet credits paired with advance payment lines: in the card total, not in the OFX total. */
    advancePayments: number;
    /** What the others leave unexplained. */
    residual: number;
  };
  /** Sheet rows of the month with no bank line dated outside the period (counted in a neighbouring period). */
  sheetOnlyOutsidePeriod: number;
  /** |residual| within 5 cents. */
  explained: boolean;
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
  /** The statement closing (see CardOfxClosing). */
  closing: CardOfxClosing;
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
  /** Sheet rows enriched (a merge counts once). */
  enriched: number;
  /** Sheet rows deleted by merges (absorbed into the row that stays). */
  absorbedRows: number;
  consumedFutures: number;
  /** Transactions created from create proposals (future installments and reversal pairs apart). */
  created: number;
  futureInstallments: number;
  /** Transactions created from reversal pairs (two per pair). */
  reversalsImported: number;
  /** Advance payments recorded as credits on the card (one per `advance-payment` proposal applied). */
  advancePayments: number;
  payment: null | { action: 'adjusted' | 'created'; transactionId: string; amount: number; date: string };
  /** Selected groups that no longer exist in the recomputation (or were applied meanwhile by another confirm). */
  skipped: number;
  createdCategories: Array<{ id: string; name: string; type: 'INCOME' | 'EXPENSE' }>;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Review queue: card sheet rows without a bank counterpart
//   GET  /transactions/import/card-ofx/review-queue?accountId=<card>[&monthKey=YYYY-MM][&limit=200]
//   POST /transactions/import/card-ofx/review-queue/actions
// ---------------------------------------------------------------------------

export interface CardOfxReviewItem {
  transactionId: string;
  description: string;
  amount: number;
  type: 'INCOME' | 'EXPENSE';
  /** YYYY-MM-DD */
  date: string;
  sourceRef: string;
  /** Sheet month (invoice due month) the row came from. */
  monthKey: string;
  categoryName: string | null;
  /** The row has shares, a split, a settlement, a recurrence or an attachment: only "keep" is allowed. */
  blocked: boolean;
}

export interface CardOfxReviewQueue {
  accountId: string;
  items: CardOfxReviewItem[];
  /** Per month: rows still in the queue and their net amount (purchases positive). */
  months: Array<{ monthKey: string; count: number; net: number }>;
  totals: { count: number; net: number };
  /** 'queue' (default) or 'kept': rows already marked "sem comprovante", which `unkeep` puts back in the queue. */
  view: 'queue' | 'kept';
  /** The items were cut at `limit`. */
  truncated: boolean;
}

export type CardOfxReviewActionType = 'keep' | 'unkeep' | 'move' | 'delete';

export interface CardOfxReviewAction {
  transactionId: string;
  action: CardOfxReviewActionType;
  /** move: the account that receives the row (same household, active, not a credit card). */
  targetAccountId?: string;
}

export interface CardOfxReviewActionsRequest {
  accountId: string;
  actions: CardOfxReviewAction[];
}

export interface CardOfxReviewActionResult {
  transactionId: string;
  action: CardOfxReviewActionType;
  /**
   * done: applied; skipped: no longer in the queue (already handled, deleted, moved, or never was) — repeating a
   * request is harmless; blocked: move/delete refused because the row has shares, a split, a settlement, a
   * recurrence or an attachment; failed: this row hit an unexpected error (reason = its code), the others in the
   * batch were still tried — the request is partial, row by row.
   */
  status: 'done' | 'skipped' | 'blocked' | 'failed';
  reason?: string;
}

export interface CardOfxReviewActionsResponse {
  results: CardOfxReviewActionResult[];
  done: number;
  skipped: number;
  blocked: number;
  failed: number;
  /** Things to know about what was done (e.g. whether a deleted sheet row can come back with the workbook). */
  warnings: string[];
}
