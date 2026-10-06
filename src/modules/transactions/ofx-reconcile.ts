/**
 * Reconciliation of a card invoice OFX with what Recta already stores on the card. Pure: no prisma, no I/O; the
 * service loads the stored rows, runs this, and the confirm runs it again on fresh data before writing.
 *
 * Steps, in order (each one only sees what the previous ones left):
 *  0. payment: among the "Pagamento recebido" lines, the one closest to the previous invoice is that invoice's
 *     payment; the others are advance payments, which only pair with sheet credits (step 3);
 *  1. already reconciled: the line's ref is recorded (external refs, or the sourceRef of a transaction an earlier
 *     import created); or legacy: a card transaction without ref with the same day, amount, type and description
 *     (what the generic "Importar" button stored);
 *  2. prepaid plan: a sheet row "N/M +K" = installments N..N+K of one FITID minus its discount(s), within 2 cents;
 *  2b. plan without "+K": a sheet expense equal to the net of all remaining lines of one FITID (2 lines or more);
 *  3. exact, one to one: same type and amount, or one cent apart when both carry the same N/M (installment
 *     rounding; the sheet keeps its amount); ties go by equal N/M, then exact amount, then words in common;
 *  4. sum: a sheet expense equal to a subset of the remaining purchases (searched among at most 15 of them, those
 *     sharing words with the row first, then in file order; smaller rows first); more than one subset anywhere in
 *     the pool of remaining purchases makes the proposal ambiguous (unselected);
 *  4b. merge: a free purchase equal to the sum of 2 to 4 sheet expense rows (the first row stays and takes the bank
 *     line's amount, the others are absorbed into it); more than one combination makes the proposal ambiguous;
 *  5. stored future installment (sheet or earlier OFX), same N/M, amount within 1 cent: the real line consumes it;
 *     a prepayment's lines N+1..N+K consume the futures with those numbers (its discount is left to step 7);
 *  6. reversal: a purchase and a refund of the same amount and a similar merchant (unselected);
 *  6b. neighbour: a left-over purchase line and an unlinked sheet row of the adjacent invoice month (+-1) with the
 *     same type and amount, a word in common (fuzzy) and dates within 10 days: the sheet typed it in the wrong month;
 *     selected only when each side has no other candidate;
 *  6c. group: a sheet expense equal to a bounded subset (12 lines at most) of the left-over purchases that share a
 *     merchant token with it (a sheet row "Uber/99" against several Uber and 99 lines); unique solution = selected;
 *  6d. near amount: an unlinked paid sheet row of this month and a left-over line of the same type whose amounts differ
 *     by 1 to 5 cents; unique both ways and (same N/M, or a shared word incl. fuzzy prefix, or an alias) = selected;
 *     the row then adopts the bank amount;
 *  7. the rest of the OFX is new (grouped by FITID, selected in months without sheet rows, when the purchase date is
 *     before the earliest sheet month stored on the card, or when no sheet row of the month is left over); what is left of
 *     the month's sheet is reported, never deleted;
 *  7b. a left-over purchase whose FITID (and installment number) is already tied to a row of the file's date range under
 *     another ref (the updated statement changed its amount, date or memo) is held back as 'changed-in-statement';
 *  8. advance payments: the "Pagamento recebido" lines that are neither the previous invoice's payment nor paired with a
 *     sheet credit are real payments the card never recorded: one `advance-payment` proposal per line (a credit on the
 *     card dated on the bank day), selected unless a sheet credit of the month is left over within 5 cents of it.
 */
import { clampText, parseInstallment } from './parsers/maxfin.parser.js';
import { fitidToken, type CardOfxStatementLine } from './parsers/ofx-card.parser.js';
import { normalizeLabel } from './maxfin-import.helpers.js';

export type ReconcileLine = CardOfxStatementLine;

/** A card transaction stored in Recta, as the reconciliation needs it. */
export interface StoredCardRow {
  id: string;
  description: string;
  /** Absolute value. */
  amount: number;
  type: 'INCOME' | 'EXPENSE';
  /** YYYY-MM-DD */
  date: string;
  sourceRef: string | null;
  notes: string | null;
  paid: boolean;
  installmentId: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
  /** Category of the row (a merge needs equal categories to be selected). */
  categoryName?: string | null;
  /** The row has shares, a split, a settlement, a recurrence or an attachment: never merged (see mergeBlocked). */
  mergeBlocked?: boolean;
}

export type ProposalKind =
  | 'enrich-exact'
  | 'enrich-plan'
  | 'enrich-sum'
  | 'enrich-merge'
  | 'enrich-neighbour'
  | 'enrich-group'
  | 'enrich-near'
  | 'consume-future'
  | 'create'
  | 'reversal'
  | 'advance-payment';

export const PROPOSAL_KINDS: readonly ProposalKind[] = [
  'enrich-exact',
  'enrich-plan',
  'enrich-sum',
  'enrich-merge',
  'enrich-neighbour',
  'enrich-group',
  'enrich-near',
  'consume-future',
  'create',
  'reversal',
  'advance-payment',
];

export interface ReconcileInput {
  /** The OFX lines, in file order. */
  lines: ReconcileLine[];
  /**
   * Sheet rows of the invoice month on the card (`maxfin:<month>:credit:<line>`, generated futures excluded),
   * including the ones already linked to OFX refs (they still make the month a "sheet month").
   */
  sheetRows: StoredCardRow[];
  /** Future installments stored on the card (from the sheet or an earlier OFX), dated from the invoice month on. */
  futures: StoredCardRow[];
  /** Card transactions without sourceRef in the lines' date range (the legacy rule's candidates). */
  legacy: StoredCardRow[];
  /** ref -> id of the transaction that already represents it (external refs, and sourceRefs of OFX creations). */
  knownRefs: ReadonlyMap<string, string>;
  /** Transactions that already represent OFX lines: never candidates again. */
  linkedTransactionIds: ReadonlySet<string>;
  /** installmentId -> numbers stored on the card, for the `ofx:<FITID>` plans of the lines. */
  planNumbers: ReadonlyMap<string, ReadonlySet<number>>;
  /** Amount of the previous invoice (its recorded payment, else its total); null: the largest payment line wins. */
  paymentReference: number | null;
  /**
   * The statement's closing balance owed (LEDGERBAL, positive = debt), in reais; null when the file has none. The
   * payment lines inside a statement are the advances plus the previous invoice's payment, and the balance is the
   * purchases minus the advances only: purchases - balance = the advances, which tells the main payment apart.
   */
  ledgerBalance?: number | null;
  /**
   * First day ('YYYY-MM-DD') of the calendar month of the card's earliest sheet month. A leftover purchase dated
   * before it is history the sheet never covered, so it is selected by default. Other leftovers of a sheet month are
   * selected only when every sheet row found its bank line (no residue). Null/undefined: no such history.
   */
  historyBefore?: string | null;
  /**
   * Sheet rows of the adjacent invoice months (+-1) on the card, generated futures excluded. Only rows not linked to
   * OFX lines are candidates of the neighbour step.
   */
  neighbourRows?: StoredCardRow[];
  /**
   * Sheet months ('YYYY-MM') among the neighbour rows whose statement was already imported (some row of the month is
   * linked to an OFX line). A neighbour match is selected by default only for those months.
   */
  neighbourStatementMonths?: ReadonlySet<string>;
  /**
   * Card rows tied to OFX lines (by ref) dated inside this file's date range whose refs are not among its lines: what a
   * re-imported, updated statement no longer lists as it was (removed, or changed amount/date/memo, which changes the
   * ref), within the statement's period. `fitids` are the FITID tokens of their refs. A left-over purchase with the same FITID and installment number
   * is held back (`changed-in-statement`) instead of becoming a second copy.
   */
  vanished?: Array<{ row: StoredCardRow; fitids: string[] }>;
}

export type PaymentBasis = 'ledger' | 'reference' | 'dominant' | 'ambiguous' | 'single';

export interface ReconcileProposal {
  /** Why a proposal is not selected by default (machine code), or null. */
  reason: string | null;
  /** create held back as 'sheet-residue': the row left over on the card that its lines may be a re-dated copy of. */
  counterpart: StoredCardRow | null;
  /** `kind|sorted refs joined by ','|target id` (see buildGroupId; a merge lists its target ids joined by '+'). */
  group: string;
  kind: ProposalKind;
  /** Sorted. */
  refs: string[];
  defaultSelected: boolean;
  ambiguous: boolean;
  /** Sheet row (enrich) or stored future (consume) the proposal writes to; null for create and reversal. */
  target: StoredCardRow | null;
  /** enrich-merge: the other sheet rows the target absorbs (deleted on apply), in sheet order. */
  absorbed: StoredCardRow[];
  /** How the target ends up (enrich and consume); null otherwise. */
  result: { date: string; description: string; notesAppend: string | null } | null;
  /** create: numbers of the future installments to generate (months without sheet rows only). */
  futureNumbers: number[];
  /** create: ref of the line the future installments continue (`<ref>:f<i>` refs, plan `ofx:<FITID>`). */
  futureBaseRef: string | null;
  /** enrich-exact: the row or the line had other candidates (decided by N/M, exact amount, then words in common). */
  tieBroken: boolean;
}

export interface ReconciledLine {
  status: 'reconciled' | 'proposed' | 'payment';
  group: string | null;
  /** reconciled: the transaction that already represents the line. */
  transactionId: string | null;
  reconciledBy: 'ref' | 'legacy' | null;
}

export interface ReconcileResult {
  /** Same order as the input lines. */
  lines: ReconciledLine[];
  proposals: ReconcileProposal[];
  sheetOnly: StoredCardRow[];
  /** The previous invoice's payment, and a legacy card credit that already holds it (it would count twice). */
  payment: { line: ReconcileLine; legacyDuplicateId: string | null } | null;
  /**
   * How the previous invoice's payment line was singled out: 'ledger' (statement balance cross-check), 'reference' (equal
   * to its recorded payment or sheet total within 2 cents), 'dominant' (no reference, clearly the largest), 'ambiguous'
   * (several payment lines and no evidence), 'single' (one payment line or none).
   */
  paymentBasis: PaymentBasis;
  /** Payment lines that are not the previous invoice's payment and paired with no sheet credit (each has an `advance-payment` proposal). */
  unpairedAdvances: ReconcileLine[];
  monthHasSheet: boolean;
  /** The merge search ran out of its work budget: some bank lines got no merge proposal. */
  mergeBudgetExhausted: boolean;
}

/** A +K plan or a FITID net may differ from the sheet by rounding of the prepayment discount. */
export const PLAN_TOLERANCE_CENTS = 2;
/** A sheet installment and the bank's one may differ by a cent of rounding when both carry the same N/M. */
export const INSTALLMENT_ROUNDING_CENTS = 1;
/** A stored future installment is the real one within one cent (its amount was copied or estimated). */
export const FUTURE_TOLERANCE_CENTS = 1;
/** Candidate purchases searched per sheet row in the sum step (2^15 subsets at most). */
export const SUM_MAX_CANDIDATES = 15;
/**
 * Work the whole reconciliation may spend counting the subsets of the full pool of purchases (one unit = one cell of
 * the knapsack table). Past it, a sum whose pool is larger than the search window is reported ambiguous.
 */
export const SUM_COUNT_BUDGET = 40_000_000;
/**
 * Lines one proposal may cover. A group id lists its refs, so this bounds its length: 150 refs of at most 77
 * characters (`ofx:` + a 64-character FITID + `:` + 8 hex) stay under MAX_GROUP_ID_LENGTH.
 */
export const MAX_GROUP_REFS = 150;
/** Longest group id the confirm endpoint accepts. */
export const MAX_GROUP_ID_LENGTH = 16_000;
/** A left-over sheet credit this close (cents) to an unpaired advance payment may be the same payment typed differently. */
export const ADVANCE_LOOKALIKE_CENTS = 5;
/** A left-over sheet credit whose description names a payment holds any advance back, whatever its amount. */
export const PAYMENT_WORDS = /pagamento/i;
/** The advances implied by the statement balance must match a payment line within this many cents. */
export const PAYMENT_CROSSCHECK_CENTS = 2;
/** A recorded line is a changed copy of a statement line when the amounts differ by at most this many cents (a moved date keeps the amount). */
export const CHANGED_AMOUNT_CENTS = 5;
/** ...or, on the same day or within this share of the recorded amount, a repricing of the same line. */
export const CHANGED_AMOUNT_RATIO = 0.1;
/** Sheet rows one bank line may merge (2 to 4). */
export const MERGE_MIN_ROWS = 2;
export const MERGE_MAX_ROWS = 4;
/** Combinations looked at per bank line before stopping (more than one already means ambiguous). */
const MERGE_MAX_MATCHES = 20;
/** Days apart a neighbour-month row and a bank line may be. */
export const NEIGHBOUR_MAX_DAYS = 10;
/** Largest amount difference, in cents, the near-amount step accepts (1..5). */
export const NEAR_MAX_CENTS = 5;
/** Lines searched per sheet row in the group step (2^12 subsets at most). */
export const GROUP_MAX_CANDIDATES = 12;
/** Cells of the knapsack table the group step may spend counting a pool larger than its window. */
export const GROUP_COUNT_BUDGET = 5_000_000;
/** Work the whole merge step may spend (one unit = one candidate row tried); past it, lines get no merge proposal. */
export const MERGE_WORK_BUDGET = 5_000_000;
const MAX_NOTES_APPEND = 1000;

const STOP_WORDS = new Set(['parcela', 'nupay']);

/** Integer cents; the nudge absorbs binary drift such as 1.005 * 100 = 100.49999999999999. */
export function toCents(amount: number): number {
  const cents = Math.round(Math.abs(amount) * 100 + 1e-6);
  return amount < 0 ? -cents : cents;
}

/** Words of a description for "words in common": accent-free, lower case, longer than 2 letters, not numbers. */
export function wordsOf(text: string): Set<string> {
  const words = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter((w) => w.length > 2 && !/^\d+$/.test(w) && !STOP_WORDS.has(w)));
}

export function sharedWordCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0;
  for (const word of a) if (b.has(word)) count += 1;
  return count;
}

/** Deterministic id of a proposal: kind, sorted refs and target transaction (the confirm recomputes and compares). */
export function buildGroupId(kind: ProposalKind, refs: readonly string[], targetId: string | null): string {
  return `${kind}|${[...refs].sort().join(',')}|${targetId ?? ''}`;
}

/** Inverse of buildGroupId; null when the text is not a group id. */
export function parseGroupId(group: string): { kind: ProposalKind; refs: string[]; targetId: string | null } | null {
  const parts = group.split('|');
  if (parts.length !== 3) return null;
  const [kind, refsText, target] = parts as [string, string, string];
  if (!(PROPOSAL_KINDS as readonly string[]).includes(kind)) return null;
  const refs = refsText.split(',');
  if (refs.length === 0 || refs.some((ref) => ref.length === 0)) return null;
  return { kind: kind as ProposalKind, refs, targetId: target.length > 0 ? target : null };
}

/**
 * Subsets of `values` (2 elements or more) adding up to `target`, all integers. `count` is exact (at most 2^15
 * subsets are looked at); `best` is the subset that keeps the earliest values (the ones tried first), as a list
 * of indexes in ascending order, or null.
 * @throws Error when given more than SUM_MAX_CANDIDATES values (the caller bounds the search).
 */
export function subsetSumMatches(values: readonly number[], target: number): { count: number; best: number[] | null } {
  const k = values.length;
  if (k > SUM_MAX_CANDIDATES) throw new Error(`subsetSumMatches takes at most ${SUM_MAX_CANDIDATES} values`);
  if (k < 2) return { count: 0, best: null };
  const sums = new Float64Array(1 << k);
  let count = 0;
  let bestMask = -1;
  let bestRank = -1;
  for (let mask = 1; mask < 1 << k; mask++) {
    const low = mask & -mask;
    const index = 31 - Math.clz32(low);
    const sum = sums[mask ^ low]! + values[index]!;
    sums[mask] = sum;
    if (sum !== target || (mask & (mask - 1)) === 0) continue;
    count += 1;
    // Value 0 is the most wanted: rank = the mask read with bit 0 as the most significant one.
    let rank = 0;
    for (let bit = 0; bit < k; bit++) rank = rank * 2 + ((mask >> bit) & 1);
    if (rank > bestRank) {
      bestRank = rank;
      bestMask = mask;
    }
  }
  if (bestMask < 0) return { count: 0, best: null };
  const best: number[] = [];
  for (let bit = 0; bit < k; bit++) if ((bestMask >> bit) & 1) best.push(bit);
  return { count, best };
}

/**
 * How many subsets of two values or more of `values` add up to `target`, counted up to `cap` (a 0/1 knapsack over
 * the cents). Values equal to the target are only ever a subset of one, so they are left out; values above it never
 * fit. The table costs about values.length * target cells.
 */
export function countSubsetSums(values: readonly number[], target: number, cap = 2): number {
  const ways = new Uint8Array(target + 1);
  ways[0] = 1;
  let reach = 0;
  for (const value of values) {
    if (value >= target || value <= 0) continue;
    reach = Math.min(target, reach + value);
    for (let sum = reach; sum >= value; sum--) {
      const total = ways[sum]! + ways[sum - value]!;
      ways[sum] = total > cap ? cap : total;
    }
  }
  return ways[target]!;
}

/** "1.234,56" with a sign: what a card line did to the invoice (purchases negative, credits positive). */
function formatSigned(cents: number, negative: boolean): string {
  const abs = Math.abs(cents);
  const integer = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '-' : '+'}${integer},${String(abs % 100).padStart(2, '0')}`;
}

function dayMonth(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface LineState {
  line: ReconcileLine;
  index: number;
  cents: number;
  words: Set<string>;
  status: 'free' | 'reconciled' | 'proposed' | 'payment';
  group: string | null;
  transactionId: string | null;
  reconciledBy: 'ref' | 'legacy' | null;
  /** A payment line that is not the previous invoice's payment. */
  advance: boolean;
}

interface RowState {
  row: StoredCardRow;
  index: number;
  cents: number;
  words: Set<string>;
  used: boolean;
  installment: { number: number; total: number; prepaid: number } | null;
}

/** N/M of a stored row (its columns), with K from the "+K" its description keeps (sheet rows). */
function rowInstallment(row: StoredCardRow): RowState['installment'] {
  const parsed = parseInstallment(row.description);
  if (row.installmentNumber != null && row.totalInstallments != null) {
    const prepaid =
      parsed && parsed.number === row.installmentNumber && parsed.total === row.totalInstallments ? parsed.prepaid : 0;
    return { number: row.installmentNumber, total: row.totalInstallments, prepaid };
  }
  return parsed ? { number: parsed.number, total: parsed.total, prepaid: parsed.prepaid } : null;
}

function rowStates(rows: StoredCardRow[]): RowState[] {
  return rows.map((row, index) => ({
    row,
    index,
    cents: toCents(row.amount),
    words: wordsOf(row.description),
    used: false,
    installment: rowInstallment(row),
  }));
}

function legacyKey(date: string, cents: number, type: string, description: string): string {
  return `${date}|${cents}|${type}|${normalizeLabel(description)}`;
}

function unionWords(states: LineState[]): Set<string> {
  const words = new Set<string>();
  for (const state of states) for (const word of state.words) words.add(word);
  return words;
}

function byFileOrder(a: LineState, b: LineState): number {
  return a.index - b.index;
}

function byDateThenFileOrder(a: LineState, b: LineState): number {
  if (a.line.date !== b.line.date) return a.line.date < b.line.date ? -1 : 1;
  return a.index - b.index;
}

/** The OFX lines a plan or a sum covers, for the notes of the sheet row: "OFX: dd/mm memo -1,00; ...". */
function linesNote(states: LineState[]): string {
  const parts = [...states]
    .sort(byDateThenFileOrder)
    .map((s) => `${dayMonth(s.line.date)} ${s.line.memo} ${formatSigned(s.cents, s.line.type === 'EXPENSE')}`);
  return clampText(`OFX: ${parts.join('; ')}`, MAX_NOTES_APPEND);
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export function reconcileCardOfx(input: ReconcileInput): ReconcileResult {
  const lines: LineState[] = input.lines.map((line, index) => ({
    line,
    index,
    cents: toCents(line.amount),
    words: wordsOf(line.memo),
    status: 'free',
    group: null,
    transactionId: null,
    reconciledBy: null,
    advance: false,
  }));
  const linked = input.linkedTransactionIds;
  const sheet = rowStates(input.sheetRows.filter((row) => !linked.has(row.id)));
  const monthHasSheet = input.sheetRows.length > 0;
  const proposals: ReconcileProposal[] = [];
  const historyBefore = input.historyBefore ?? null;
  /** A purchase dated before the first window the sheet covers: history the sheet never saw. */
  const beforeSheetHistory = (date: string): boolean => historyBefore !== null && date < historyBefore;

  const propose = (
    kind: ProposalKind,
    states: LineState[],
    target: RowState | null,
    extra: Partial<Pick<ReconcileProposal, 'defaultSelected' | 'ambiguous' | 'result' | 'futureNumbers' | 'futureBaseRef' | 'tieBroken' | 'reason' | 'counterpart'>> & {
      absorbed?: RowState[];
    } = {},
  ): void => {
    const refs = states.map((s) => s.line.ref).sort();
    const absorbed = extra.absorbed ?? [];
    const targetKey = target ? [target.row.id, ...absorbed.map((a) => a.row.id).sort()].join('+') : null;
    const group = buildGroupId(kind, refs, targetKey);
    for (const state of states) {
      state.status = 'proposed';
      state.group = group;
    }
    if (target) target.used = true;
    for (const row of absorbed) row.used = true;
    proposals.push({
      group,
      kind,
      refs,
      defaultSelected: extra.defaultSelected ?? true,
      ambiguous: extra.ambiguous ?? false,
      target: target?.row ?? null,
      absorbed: absorbed.map((a) => a.row),
      result: extra.result ?? null,
      futureNumbers: extra.futureNumbers ?? [],
      futureBaseRef: extra.futureBaseRef ?? null,
      tieBroken: extra.tieBroken ?? false,
      reason: extra.reason ?? null,
      counterpart: extra.counterpart ?? null,
    });
  };

  // 1a. Lines whose ref is already recorded.
  for (const state of lines) {
    const transactionId = input.knownRefs.get(state.line.ref);
    if (transactionId !== undefined) {
      state.status = 'reconciled';
      state.transactionId = transactionId;
      state.reconciledBy = 'ref';
    }
  }

  // 0. The previous invoice's payment. With a statement balance (LEDGERBAL) the advances are implied exactly:
  // purchases - balance = the advances, so the main payment is the one payment line whose removal leaves that sum
  // (within 2 cents). Otherwise (no balance, no unique line, or a balance that does not fit, e.g. a refund on the
  // boundary day) the line closest to the reference, else the largest one, and an invoice with several payment lines
  // and no clear main is 'payment-ambiguous': its advances are proposed unselected.
  const paymentLines = lines.filter((s) => s.status === 'free' && s.line.kind === 'payment');
  const allPaymentLines = lines.filter((s) => s.line.kind === 'payment');
  let payment: LineState | null = null;
  let paymentAmbiguous = false;
  let paymentBasis: PaymentBasis = allPaymentLines.length > 1 ? 'ambiguous' : 'single';
  if (paymentLines.length > 0) {
    const reference = input.paymentReference != null && input.paymentReference > 0 ? toCents(input.paymentReference) : null;
    const byReference = paymentLines.reduce((best, candidate) => {
      if (reference === null) return candidate.cents > best.cents ? candidate : best;
      const d = Math.abs(candidate.cents - reference);
      const bestD = Math.abs(best.cents - reference);
      if (d !== bestD) return d < bestD ? candidate : best;
      return candidate.cents > best.cents ? candidate : best;
    });
    payment = byReference;
    let crossChecked = false;
    if (input.ledgerBalance != null && allPaymentLines.length > 1) {
      const nonPayment = lines.filter((s) => s.line.kind !== 'payment').reduce((t, s) => t + (s.line.type === 'EXPENSE' ? s.cents : -s.cents), 0);
      const implied = nonPayment - toCents(input.ledgerBalance);
      const total = allPaymentLines.reduce((t, s) => t + s.cents, 0);
      const fits = paymentLines.filter((s) => Math.abs(total - s.cents - implied) <= PAYMENT_CROSSCHECK_CENTS);
      // Equal amounts are interchangeable: take the first of them.
      if (fits.length > 0 && fits.every((s) => s.cents === fits[0]!.cents)) {
        payment = fits.find((s) => s === byReference) ?? fits[0]!;
        crossChecked = true;
        paymentBasis = 'ledger';
      }
    }
    if (!crossChecked && allPaymentLines.length > 1) {
      // Without the cross-check the reference must single the main payment out: an exact reference (within 2 cents),
      // or the chosen line more than twice any other (advances are small next to an invoice).
      const others = paymentLines.filter((s) => s !== payment).map((s) => s.cents);
      // A reference that is not exact is no evidence (and dominance does not rescue it): only a statement with no
      // reference at all (the first one) may fall back on a line being clearly larger than the others.
      const exact = reference !== null && Math.abs(payment.cents - reference) <= PAYMENT_CROSSCHECK_CENTS;
      const dominant = reference === null && others.every((c) => payment!.cents > 2 * c);
      paymentAmbiguous = !(exact || dominant);
      paymentBasis = exact ? 'reference' : dominant ? 'dominant' : 'ambiguous';
    }
    payment.status = 'payment';
    for (const state of paymentLines) if (state !== payment) state.advance = true;
  }

  // 1b. Legacy: what the generic importer stored (no ref) with the same day, amount, type and description.
  const legacyByKey = new Map<string, StoredCardRow[]>();
  for (const row of input.legacy) {
    if (linked.has(row.id)) continue;
    const key = legacyKey(row.date, toCents(row.amount), row.type, row.description);
    legacyByKey.set(key, [...(legacyByKey.get(key) ?? []), row]);
  }
  const takeLegacy = (state: LineState): StoredCardRow | null => {
    const key = legacyKey(state.line.date, state.cents, state.line.type, state.line.memo);
    const candidates = legacyByKey.get(key);
    const row = candidates?.shift() ?? null;
    return row;
  };
  for (const state of lines) {
    if (state.status !== 'free') continue;
    const row = takeLegacy(state);
    if (row) {
      state.status = 'reconciled';
      state.transactionId = row.id;
      state.reconciledBy = 'legacy';
    }
  }
  const paymentLegacy = payment ? takeLegacy(payment) : null;

  // FITID groups of the lines still free (payments apart), in order of first appearance.
  const fitGroups = new Map<string, LineState[]>();
  for (const state of lines) {
    if (state.status !== 'free' || state.line.kind === 'payment') continue;
    fitGroups.set(state.line.fitid, [...(fitGroups.get(state.line.fitid) ?? []), state]);
  }
  const freeOf = (group: LineState[]) => group.filter((s) => s.status === 'free');

  // 2. Prepaid plans: "N/M +K" = installments N..N+K of one FITID minus its discounts.
  for (const row of sheet) {
    if (row.used || row.row.type !== 'EXPENSE' || !row.installment || row.installment.prepaid <= 0) continue;
    const { number: first, total, prepaid } = row.installment;
    let best: { states: LineState[]; score: number } | null = null;
    for (const group of fitGroups.values()) {
      const free = freeOf(group);
      const parts = free.filter((s) => {
        const inst = s.line.kind === 'purchase' ? s.line.installment : null;
        return inst !== null && inst.total === total && inst.number >= first && inst.number <= first + prepaid;
      });
      const numbers = new Set(parts.map((s) => s.line.installment!.number));
      if (parts.length !== prepaid + 1 || numbers.size !== prepaid + 1) continue;
      const discounts = free.filter((s) => s.line.kind === 'discount');
      if (parts.length + discounts.length > MAX_GROUP_REFS) continue;
      const net = parts.reduce((t, s) => t + s.cents, 0) - discounts.reduce((t, s) => t + s.cents, 0);
      if (Math.abs(net - row.cents) > PLAN_TOLERANCE_CENTS) continue;
      const score = sharedWordCount(row.words, unionWords(parts));
      if (!best || score > best.score) best = { states: [...parts, ...discounts], score };
    }
    if (best) {
      propose('enrich-plan', best.states, row, { result: aggregateResult(best.states, row) });
    }
  }

  // 2b. Plans without "+K": a sheet expense equal to the net of every remaining line of one FITID.
  for (const row of sheet) {
    if (row.used || row.row.type !== 'EXPENSE') continue;
    let best: { states: LineState[]; score: number } | null = null;
    for (const group of fitGroups.values()) {
      const free = freeOf(group);
      if (free.length < 2 || free.length > MAX_GROUP_REFS) continue;
      const net = free.reduce((t, s) => t + (s.line.type === 'EXPENSE' ? s.cents : -s.cents), 0);
      if (net <= 0 || Math.abs(net - row.cents) > PLAN_TOLERANCE_CENTS) continue;
      const score = sharedWordCount(row.words, unionWords(free));
      if (!best || score > best.score) best = { states: free, score };
    }
    if (best) {
      propose('enrich-plan', best.states, row, { result: aggregateResult(best.states, row) });
    }
  }

  // 3. Exact, one to one: same type and amount, or one cent apart when both sides carry the same installment N/M
  // (installment rounding: the sheet row keeps its own amount). Equal N/M goes first, then the exact amount, then
  // words in common.
  const linesByAmount = new Map<string, LineState[]>();
  for (const state of lines) {
    const eligible = state.status === 'free' && (state.line.kind !== 'payment' || state.advance);
    if (!eligible) continue;
    const key = `${state.line.type}|${state.cents}`;
    linesByAmount.set(key, [...(linesByAmount.get(key) ?? []), state]);
  }
  const pairs: Array<{ row: RowState; state: LineState; inst: number; exact: number; shared: number }> = [];
  for (const row of sheet) {
    if (row.used) continue;
    for (let delta = -INSTALLMENT_ROUNDING_CENTS; delta <= INSTALLMENT_ROUNDING_CENTS; delta++) {
      for (const state of linesByAmount.get(`${row.row.type}|${row.cents + delta}`) ?? []) {
        const inst = state.line.installment;
        const sameInstallment =
          row.installment !== null && inst !== null && row.installment.number === inst.number && row.installment.total === inst.total;
        if (delta !== 0 && !sameInstallment) continue;
        pairs.push({ row, state, inst: sameInstallment ? 1 : 0, exact: delta === 0 ? 1 : 0, shared: sharedWordCount(row.words, state.words) });
      }
    }
  }
  const candidatesOfRow = new Map<RowState, number>();
  const candidatesOfLine = new Map<LineState, number>();
  for (const { row, state } of pairs) {
    candidatesOfRow.set(row, (candidatesOfRow.get(row) ?? 0) + 1);
    candidatesOfLine.set(state, (candidatesOfLine.get(state) ?? 0) + 1);
  }
  pairs.sort(
    (a, b) =>
      b.inst - a.inst || b.exact - a.exact || b.shared - a.shared || a.row.index - b.row.index || a.state.index - b.state.index,
  );
  for (const pair of pairs) {
    if (pair.row.used || pair.state.status !== 'free') continue;
    propose('enrich-exact', [pair.state], pair.row, {
      tieBroken: candidatesOfRow.get(pair.row)! > 1 || candidatesOfLine.get(pair.state)! > 1,
      result: {
        date: pair.state.line.date,
        description: pair.state.line.memo,
        notesAppend: clampText(`Planilha: ${pair.row.row.description}`, MAX_NOTES_APPEND),
      },
    });
  }

  // 4. Sums: a sheet expense equal to a subset of the remaining purchases. Smaller rows go first: few lines can
  // make a small total, while a large one could absorb the lines of a small aggregate.
  // The subset is searched among the best SUM_MAX_CANDIDATES lines, but it is only unique when no other subset of
  // the whole pool of remaining purchases makes the same total: that is counted exactly while the budget lasts, and
  // otherwise a pool larger than the window counts as ambiguous.
  let countBudget = SUM_COUNT_BUDGET;
  const bySmallestAmount = [...sheet].sort((a, b) => a.cents - b.cents || a.index - b.index);
  for (const row of bySmallestAmount) {
    if (row.used || row.row.type !== 'EXPENSE') continue;
    const pool = lines
      .filter((s) => s.status === 'free' && s.line.kind === 'purchase' && s.cents <= row.cents)
      .map((s) => ({ state: s, shared: sharedWordCount(row.words, s.words) }))
      .sort((a, b) => b.shared - a.shared || a.state.index - b.state.index)
      .map((c) => c.state);
    const candidates = pool.slice(0, SUM_MAX_CANDIDATES);
    if (candidates.length < 2 || candidates.reduce((t, s) => t + s.cents, 0) < row.cents) continue;
    const { count, best } = subsetSumMatches(
      candidates.map((s) => s.cents),
      row.cents,
    );
    if (!best) continue;
    let ambiguous = count > 1;
    if (!ambiguous && pool.length > candidates.length) {
      const cost = pool.length * row.cents;
      if (cost <= countBudget) {
        countBudget -= cost;
        ambiguous = countSubsetSums(pool.map((s) => s.cents), row.cents) > 1;
      } else {
        ambiguous = true;
      }
    }
    const states = best.map((i) => candidates[i]!);
    propose('enrich-sum', states, row, {
      ambiguous,
      defaultSelected: !ambiguous,
      reason: ambiguous ? 'ambiguous' : null,
      result: aggregateResult(states, row),
    });
  }

  // 4b. Merges: a purchase equal to the sum of 2 to 4 sheet expense rows (a purchase the sheet typed as several rows).
  const mergeBudget = { left: MERGE_WORK_BUDGET };
  let mergeBudgetExhausted = false;
  const mergeRows = sheet
    .filter((r) => !r.used && r.row.type === 'EXPENSE' && r.row.paid && !r.row.mergeBlocked && r.installment === null && r.cents > 0)
    .sort((a, b) => a.cents - b.cents || a.index - b.index);
  if (mergeRows.length >= MERGE_MIN_ROWS) {
    for (const state of lines) {
      if (state.status !== 'free' || state.line.kind !== 'purchase' || state.line.installment) continue;
      const pool = mergeRows.filter((r) => !r.used && r.cents < state.cents);
      if (pool.length < MERGE_MIN_ROWS) continue;
      const found = findRowMerges(pool, state.cents, mergeBudget);
      if (mergeBudget.left < 0) mergeBudgetExhausted = true;
      if (found.length === 0) continue;
      const scored = found
        .map((rows) => ({
          rows: [...rows].sort((a, b) => a.index - b.index),
          shared: fuzzySharedCount(state.words, unionRowWords(rows)),
        }))
        .sort((a, b) => b.shared - a.shared || compareIndexes(a.rows, b.rows));
      const best = scored[0]!.rows;
      const ambiguous = found.length > 1;
      const noWords = scored[0]!.shared === 0;
      const mixedCategories = new Set(best.map((r) => r.row.categoryName ?? null)).size > 1;
      const reason = ambiguous ? 'ambiguous' : noWords ? 'no-shared-words' : mixedCategories ? 'mixed-categories' : null;
      const [kept, ...absorbed] = best as [RowState, ...RowState[]];
      propose('enrich-merge', [state], kept, {
        ambiguous,
        defaultSelected: reason === null,
        reason,
        absorbed,
        result: {
          date: state.line.date,
          description: state.line.memo,
          notesAppend: mergeNote(best),
        },
      });
    }
  }

  // 5. Stored future installments: same N/M, amount within a cent.
  const futures = rowStates(
    input.futures.filter(
      (f) => !linked.has(f.id) && f.type === 'EXPENSE' && f.installmentNumber != null && f.totalInstallments != null,
    ),
  );
  const futuresByKey = new Map<string, RowState[]>();
  for (const future of futures) {
    const key = `${future.row.installmentNumber}/${future.row.totalInstallments}`;
    futuresByKey.set(key, [...(futuresByKey.get(key) ?? []), future]);
  }
  const futureCandidates = (state: LineState): RowState[] => {
    const inst = state.line.installment!;
    return (futuresByKey.get(`${inst.number}/${inst.total}`) ?? []).filter(
      (f) => !f.used && Math.abs(f.cents - state.cents) <= FUTURE_TOLERANCE_CENTS,
    );
  };
  const installmentGroups = new Map<string, LineState[]>();
  for (const state of lines) {
    if (state.status !== 'free' || state.line.kind !== 'purchase' || !state.line.installment) continue;
    installmentGroups.set(state.line.fitid, [...(installmentGroups.get(state.line.fitid) ?? []), state]);
  }
  for (const [fitid, group] of installmentGroups) {
    const ownPlan = `ofx:${fitidToken(fitid)}`;
    // How many lines of this purchase each stored plan could absorb: a prepayment consumes one plan, not several.
    const coverage = new Map<string, Set<number>>();
    for (const state of group) {
      for (const future of futureCandidates(state)) {
        const plan = future.row.installmentId ?? '';
        coverage.set(plan, (coverage.get(plan) ?? new Set()).add(state.index));
      }
    }
    const ordered = [...group].sort(
      (a, b) => a.line.installment!.number - b.line.installment!.number || a.index - b.index,
    );
    for (const state of ordered) {
      const ranked = futureCandidates(state)
        .map((future) => ({
          future,
          own: future.row.installmentId === ownPlan ? 1 : 0,
          cover: coverage.get(future.row.installmentId ?? '')?.size ?? 0,
          shared: sharedWordCount(state.words, future.words),
        }))
        .sort(
          (a, b) =>
            b.own - a.own ||
            b.cover - a.cover ||
            b.shared - a.shared ||
            (a.future.row.date < b.future.row.date ? -1 : a.future.row.date > b.future.row.date ? 1 : 0) ||
            a.future.index - b.future.index,
        );
      const choice = ranked[0]?.future;
      if (!choice) continue;
      propose('consume-future', [state], choice, {
        result: {
          date: state.line.date,
          description: state.line.memo,
          notesAppend: clampText(`Parcela futura: ${choice.row.description}`, MAX_NOTES_APPEND),
        },
      });
    }
  }

  // 6. Reversals: a purchase and a refund of the same amount and a similar merchant.
  for (const refund of lines) {
    if (refund.status !== 'free' || refund.line.kind !== 'refund') continue;
    const ranked = lines
      .filter((s) => s.status === 'free' && s.line.kind === 'purchase' && s.cents === refund.cents)
      .map((s) => ({
        state: s,
        sameFitid: s.line.fitid === refund.line.fitid ? 1 : 0,
        shared: sharedWordCount(s.words, refund.words),
      }))
      .filter((c) => c.sameFitid === 1 || c.shared > 0)
      .sort((a, b) => b.sameFitid - a.sameFitid || b.shared - a.shared || a.state.index - b.state.index);
    const purchase = ranked[0]?.state;
    if (purchase) propose('reversal', [purchase, refund], null, { defaultSelected: false });
  }

  // 6b. Neighbour months: the same purchase typed in the adjacent invoice month of the sheet.
  const neighbours = rowStates(
    (input.neighbourRows ?? []).filter((r) => !linked.has(r.id) && r.paid && !r.mergeBlocked && r.installmentNumber == null),
  );
  if (neighbours.length > 0) {
    const pairsN: Array<{ row: RowState; state: LineState; shared: number; days: number }> = [];
    for (const state of lines) {
      if (state.status !== 'free' || state.line.kind === 'payment' || state.line.installment) continue;
      for (const row of neighbours) {
        if (row.row.type !== state.line.type || row.cents !== state.cents) continue;
        const shared = fuzzySharedCount(state.words, row.words);
        const days = dayDistance(state.line.date, row.row.date);
        if (shared > 0 && days <= NEIGHBOUR_MAX_DAYS) pairsN.push({ row, state, shared, days });
      }
    }
    const rowsOfLine = new Map<LineState, number>();
    const linesOfRow = new Map<RowState, number>();
    for (const { row, state } of pairsN) {
      rowsOfLine.set(state, (rowsOfLine.get(state) ?? 0) + 1);
      linesOfRow.set(row, (linesOfRow.get(row) ?? 0) + 1);
    }
    pairsN.sort((a, b) => b.shared - a.shared || a.days - b.days || a.row.index - b.row.index || a.state.index - b.state.index);
    for (const pair of pairsN) {
      if (pair.row.used || pair.state.status !== 'free') continue;
      const unique = rowsOfLine.get(pair.state) === 1 && linesOfRow.get(pair.row) === 1;
      const month = /^maxfin:(\d{4}-\d{2}):/.exec(pair.row.row.sourceRef ?? '')?.[1] ?? '';
      const imported = input.neighbourStatementMonths?.has(month) ?? false;
      const strong = strongSignal(pair.row.row.description, pair.state.line.memo, null);
      const reason = !unique ? 'neighbour-ambiguous' : !strong ? 'neighbour-weak' : !imported ? 'neighbour-month-not-imported' : null;
      propose('enrich-neighbour', [pair.state], pair.row, {
        ambiguous: !unique,
        defaultSelected: reason === null,
        reason,
        result: {
          date: pair.state.line.date,
          description: pair.state.line.memo,
          notesAppend: clampText(`Planilha: ${pair.row.row.description}`, MAX_NOTES_APPEND),
        },
      });
    }
  }

  // 6c. Groups: a sheet row against several lines of the same merchant (bounded subset sum over that merchant only).
  let groupBudget = GROUP_COUNT_BUDGET;
  for (const row of [...sheet].sort((a, b) => a.cents - b.cents || a.index - b.index)) {
    if (row.used || row.row.type !== 'EXPENSE' || row.row.mergeBlocked || row.installment !== null) continue;
    const tokens = merchantTokens(row.row.description);
    if (tokens.size === 0) continue;
    const pool = lines
      .filter((s) => s.status === 'free' && s.line.kind === 'purchase' && !s.line.installment && s.cents < row.cents)
      .map((s) => ({ state: s, shared: fuzzySharedCount(tokens, merchantTokens(s.line.memo)) }))
      .filter((c) => c.shared > 0)
      .sort((a, b) => b.shared - a.shared || a.state.index - b.state.index)
      .map((c) => c.state);
    const candidates = pool.slice(0, GROUP_MAX_CANDIDATES);
    if (candidates.length < 2 || candidates.reduce((t, s) => t + s.cents, 0) < row.cents) continue;
    const { count, best } = subsetSumMatches(
      candidates.map((s) => s.cents),
      row.cents,
    );
    if (!best) continue;
    let reason: string | null = count > 1 ? 'ambiguous' : null;
    if (reason === null && pool.length > candidates.length) {
      const cost = pool.length * row.cents;
      if (cost <= groupBudget) {
        groupBudget -= cost;
        if (countSubsetSums(pool.map((s) => s.cents), row.cents) > 1) reason = 'ambiguous';
      } else reason = 'pool-too-large';
    }
    const states = best.map((i) => candidates[i]!);
    propose('enrich-group', states, row, {
      ambiguous: reason === 'ambiguous',
      defaultSelected: reason === null,
      reason,
      result: aggregateResult(states, row),
    });
  }

  // 6d. Near amounts: the same purchase typed (or charged) a few cents apart.
  const nearPairs: Array<{ row: RowState; state: LineState; diff: number; strong: boolean }> = [];
  for (const row of sheet) {
    if (row.used || !row.row.paid || row.row.mergeBlocked || (row.installment?.prepaid ?? 0) > 0) continue;
    for (const state of lines) {
      if (state.status !== 'free' || state.line.kind === 'payment' || state.line.type !== row.row.type) continue;
      const diff = Math.abs(state.cents - row.cents);
      if (diff < 1 || diff > NEAR_MAX_CENTS) continue;
      const inst = state.line.installment;
      const sameInstallment = row.installment !== null && inst !== null && row.installment.number === inst.number && row.installment.total === inst.total;
      const strong = strongSignal(row.row.description, state.line.memo, sameInstallment);
      nearPairs.push({ row, state, diff, strong });
    }
  }
  const nearOfRow = new Map<RowState, number>();
  const nearOfLine = new Map<LineState, number>();
  for (const { row, state } of nearPairs) {
    nearOfRow.set(row, (nearOfRow.get(row) ?? 0) + 1);
    nearOfLine.set(state, (nearOfLine.get(state) ?? 0) + 1);
  }
  nearPairs.sort((a, b) => Number(b.strong) - Number(a.strong) || a.diff - b.diff || a.row.index - b.row.index || a.state.index - b.state.index);
  for (const pair of nearPairs) {
    if (pair.row.used || pair.state.status !== 'free') continue;
    const unique = nearOfRow.get(pair.row) === 1 && nearOfLine.get(pair.state) === 1;
    const reason = !unique ? 'near-ambiguous' : pair.strong ? null : 'near-amount';
    propose('enrich-near', [pair.state], pair.row, {
      ambiguous: !unique,
      defaultSelected: reason === null,
      reason,
      result: {
        date: pair.state.line.date,
        description: pair.state.line.memo,
        notesAppend: clampText(`Planilha: ${pair.row.row.description} ${formatCents(pair.row.cents)}`, MAX_NOTES_APPEND),
      },
    });
  }

  // 7. The rest of the OFX is new, one proposal per purchase (FITID). Advances left are information only.
  const leftovers = new Map<string, LineState[]>();
  for (const state of lines) {
    if (state.status !== 'free' || state.line.kind === 'payment') continue;
    leftovers.set(state.line.fitid, [...(leftovers.get(state.line.fitid) ?? []), state]);
  }
  for (const [fitid, group] of leftovers) {
    const plan = monthHasSheet ? null : futurePlan(fitid, group, lines, input.planNumbers);
    group.sort(byFileOrder);
    const sheetResidue = sheet.some((r) => !r.used);
    const residueRows: StoredCardRow[] = [
      ...sheet.filter((r) => !r.used).map((r) => r.row),
      // Card rows the generic importer stored without ref that no line took also count as look-alikes.
      ...[...legacyByKey.values()].flat(),
    ];
    // A purchase with more lines than a group id can list (never seen in a real invoice) comes in several groups.
    for (let start = 0; start < group.length; start += MAX_GROUP_REFS) {
      const part = group.slice(start, start + MAX_GROUP_REFS);
      const history = monthHasSheet && part.every((s) => beforeSheetHistory(s.line.date));
      // History is imported (the user wants it) unless a row left over on the card looks like one of its lines (same
      // type, exact amount or within max(R$ 5, 10%)): then it may be the same purchase typed with another date.
      const counterpart = history ? (residueRows.find((row) => part.some((s) => plausibleCounterpart(s, row))) ?? null) : null;
      // Selected: a month without sheet, history without a look-alike, or no sheet row left that could explain the
      // line (every row found its bank line, so what is left of the OFX is missing from Recta).
      let selected = !monthHasSheet || (history && counterpart === null) || !sheetResidue;
      let reason: string | null = selected ? null : 'sheet-residue';
      let heldCounterpart: StoredCardRow | null = selected ? null : counterpart;
      // The same purchase (FITID and installment number) is already tied to a row of this period under another ref: the
      // bank changed its amount, date or memo. A second copy would double it, so it is held back for the user.
      const changed = (input.vanished ?? []).find((v) => part.some((s) => isChangedCopy(v, s)));
      if (changed) {
        selected = false;
        reason = 'changed-in-statement';
        heldCounterpart = changed.row;
      }
      propose('create', part, null, {
        defaultSelected: selected,
        reason,
        counterpart: heldCounterpart,
        futureNumbers: plan?.numbers ?? [],
        futureBaseRef: plan?.baseRef ?? null,
      });
    }
  }
  // 8. Advance payments no sheet credit took: a credit on the card (the payment reduces the debt), one per line. Held
  // back (unselected) when it may be a payment already typed in the sheet (a left-over or reviewed credit of the month
  // that names a payment, or one within 5 cents of it), when the bank changed a recorded one (same FITID, another
  // ref), or when the main payment could not be told apart from the advances.
  const unpairedAdvances: ReconcileLine[] = [];
  const ofxLinked = new Set<string>();
  for (const [ref, id] of input.knownRefs) if (ref.startsWith('ofx:')) ofxLinked.add(id);
  const usedRowIds = new Set(sheet.filter((r) => r.used).map((r) => r.row.id));
  const creditRows = input.sheetRows.filter((r) => r.type === 'INCOME' && !usedRowIds.has(r.id) && !ofxLinked.has(r.id));
  for (const state of lines) {
    if (state.status !== 'free' || !state.advance) continue;
    unpairedAdvances.push(state.line);
    const changed = (input.vanished ?? []).find((v) => v.row.type === 'INCOME' && isChangedCopy(v, state));
    const lookAlike = creditRows.find((r) => PAYMENT_WORDS.test(r.description) || Math.abs(toCents(r.amount) - state.cents) <= ADVANCE_LOOKALIKE_CENTS);
    const reason = changed ? 'changed-in-statement' : lookAlike ? 'sheet-credit-near' : paymentAmbiguous ? 'payment-ambiguous' : null;
    propose('advance-payment', [state], null, {
      defaultSelected: reason === null,
      reason,
      counterpart: changed?.row ?? lookAlike ?? null,
    });
  }

  return {
    lines: lines.map((s) => ({
      status: s.status === 'free' ? 'payment' : s.status,
      group: s.group,
      transactionId: s.transactionId,
      reconciledBy: s.reconciledBy,
    })),
    proposals,
    sheetOnly: sheet.filter((row) => !row.used).map((row) => row.row),
    payment: payment ? { line: payment.line, legacyDuplicateId: paymentLegacy?.id ?? null } : null,
    unpairedAdvances,
    paymentBasis,
    monthHasSheet,
    mergeBudgetExhausted,
  };
}

/** A row and a line could be the same purchase: same type, amount equal or within max(R$ 5, 10% of the row). */
export function plausibleCounterpart(line: { cents: number; line: { type: 'INCOME' | 'EXPENSE' } }, row: StoredCardRow): boolean {
  if (line.line.type !== row.type) return false;
  const rowCents = toCents(row.amount);
  return Math.abs(line.cents - rowCents) <= Math.max(500, Math.round(rowCents * 0.1));
}

/** Two words are alike when equal or when both are 4+ letters long and start the same 4 letters (zorbit/zorbyt). */
function alike(a: string, b: string): boolean {
  return a === b || (a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4));
}

/** Words of `a` with a like word in `b`. */
export function fuzzySharedCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0;
  for (const word of a) {
    for (const other of b) {
      if (alike(word, other)) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

/**
 * Generic words that name a kind of shop, not a shop: never a signal that two texts are the same store (and never a
 * group token). A shared 5+ letter word outside this list, an alias or the same installment N/M are the strong signals.
 */
export const GENERIC_WORDS = new Set([
  'posto', 'mercado', 'padaria', 'loja', 'restaurante', 'farmacia', 'supermercado',
  'acougue', 'hamburgueria', 'sorveteria', 'drogaria', 'oficina', 'bar', 'cafe', 'ltda', 'comercio',
  'pagamento', 'compra', 'parcela', 'nupay', 'center', 'shopping', 'store', 'online',
]);

/**
 * "Same store" strong enough to select a pairing whose amounts or months do not match exactly: same installment N/M,
 * an alias, or an exact shared word of 5+ letters that is not a generic shop word. The 4-letter fuzzy prefix is NOT
 * enough here (it stays for the merge and group proposals, which are protected by their uniqueness).
 */
export function strongSignal(a: string, b: string, sameInstallment: boolean | null): boolean {
  if (sameInstallment) return true;
  if (aliasAlike(a, b)) return true;
  const wordsA = wordsOf(a);
  for (const word of wordsOf(b)) if (word.length >= 5 && !GENERIC_WORDS.has(word) && wordsA.has(word)) return true;
  return false;
}

/** Tiny alias table: names a bank and a sheet write differently for the same store. Keep it short and tested. */
const ALIASES: string[][] = [
  ['ifood', 'ifd'],
  ['mercado livre', 'meli+'],
  ['uber', 'dluber'],
];

function hasAlias(text: string, rawMember: string): boolean {
  const member = rawMember.replace(/\s+/g, '');
  if (member.endsWith('+')) return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().includes(member);
  const compact = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (member.length >= 5) return compact.includes(member);
  return merchantTokens(text).has(member) || new Set(text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[a-z0-9]+/g) ?? []).has(member);
}

/** True when the two texts name the same store through one alias group (ifood ~ ifd, mercado livre ~ meli+...). */
export function aliasAlike(a: string, b: string): boolean {
  return ALIASES.some((group) => group.some((m) => hasAlias(a, m)) && group.some((m) => hasAlias(b, m)));
}

const MERCHANT_STOP = new Set(['com', ...GENERIC_WORDS]);

/** Merchant tokens of a text: accent-free lower case, 3+ letters or 2+ digits, no generic words. */
export function merchantTokens(text: string): Set<string> {
  const raw = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(raw.filter((t) => (/^\d+$/.test(t) ? t.length >= 2 : t.length >= 3) && !MERCHANT_STOP.has(t)));
}

/**
 * A recorded row (tied to an OFX ref the file does not list) that is the same line as `state` with a changed amount or
 * date: same FITID, type and installment number, and an amount within 5 cents (a moved date keeps the amount). Lines that merely share a FITID (the purchase, its discount and a later refund of one plan) do not count.
 */
function isChangedCopy(v: { row: StoredCardRow; fitids: string[] }, state: LineState): boolean {
  if (!v.fitids.includes(fitidToken(state.line.fitid))) return false;
  if (v.row.type !== state.line.type) return false;
  if ((v.row.installmentNumber ?? null) !== (state.line.installment?.number ?? null)) return false;
  const diff = Math.abs(toCents(v.row.amount) - state.cents);
  if (diff <= CHANGED_AMOUNT_CENTS) return true;
  // Repriced (exchange or IOF adjustment): the same day, or within 10%. A later partial refund of the same FITID has
  // another date and a very different amount.
  return v.row.date === state.line.date || diff <= Math.round(toCents(v.row.amount) * CHANGED_AMOUNT_RATIO);
}

/** Days between two YYYY-MM-DD dates. */
function dayDistance(a: string, b: string): number {
  const toDay = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000;
  return Math.abs(toDay(a) - toDay(b));
}

function compareIndexes(a: RowState[], b: RowState[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i]!.index !== b[i]!.index) return a[i]!.index - b[i]!.index;
  return a.length - b.length;
}

function unionRowWords(rows: RowState[]): Set<string> {
  const words = new Set<string>();
  for (const row of rows) for (const word of row.words) words.add(word);
  return words;
}

/** "36,86" (unsigned). */
function formatCents(cents: number): string {
  return formatSigned(cents, false).slice(1);
}

/** Notes of the row that stays after a merge: what the absorbed rows said, so the detail is not lost. */
function mergeNote(rows: RowState[]): string {
  const parts = rows.map((r) => `${r.row.description} ${formatCents(r.cents)}`);
  return clampText(`Planilha (soma de ${rows.length} linhas): ${parts.join('; ')}`, MAX_NOTES_APPEND);
}

/**
 * Combinations of 2 to MERGE_MAX_ROWS rows (all of `pool`, sorted by amount) adding up to `target` cents, at most
 * MERGE_MAX_MATCHES of them (reaching that already means ambiguous). The last row of a combination is found by a
 * lookup, so the search costs about pool^(max-1) steps; `budget` bounds the total, and an exhausted budget yields no
 * combination at all (never a half-searched, possibly non-unique one).
 */
function findRowMerges(pool: RowState[], target: number, budget: { left: number }): RowState[][] {
  const byCents = new Map<number, number[]>();
  pool.forEach((row, position) => byCents.set(row.cents, [...(byCents.get(row.cents) ?? []), position]));
  const found: RowState[][] = [];
  let exhausted = false;
  const walk = (start: number, remaining: number, chosen: RowState[]): boolean => {
    if (chosen.length >= 1) {
      for (const position of byCents.get(remaining) ?? []) {
        if (position < start) continue;
        found.push([...chosen, pool[position]!]);
        if (found.length >= MERGE_MAX_MATCHES) return true;
      }
    }
    if (chosen.length + 2 > MERGE_MAX_ROWS) return false;
    for (let position = start; position < pool.length; position++) {
      const row = pool[position]!;
      if (row.cents >= remaining) break;
      budget.left -= 1;
      if (budget.left < 0) {
        exhausted = true;
        return true;
      }
      if (walk(position + 1, remaining - row.cents, [...chosen, row])) return true;
    }
    return false;
  };
  walk(0, target, []);
  return exhausted ? [] : found;
}

/** The sheet row keeps its description and gets the date of the first line and the list of lines in its notes. */
function aggregateResult(states: LineState[], row: RowState): ReconcileProposal['result'] {
  const first = [...states].sort(byDateThenFileOrder)[0]!;
  return { date: first.line.date, description: row.row.description, notesAppend: linesNote(states) };
}

/**
 * Future installments of a new purchase (months without sheet rows): N+1..M after the highest installment of the
 * purchase in the file, skipping numbers its `ofx:<FITID>` plan already stores. None when part of the purchase is
 * represented elsewhere (reconciled, matched or consuming stored futures): its plan already exists.
 */
function futurePlan(
  fitid: string,
  group: LineState[],
  all: LineState[],
  planNumbers: ReadonlyMap<string, ReadonlySet<number>>,
): { numbers: number[]; baseRef: string } | null {
  const members = new Set(group);
  if (all.some((s) => s.line.fitid === fitid && !members.has(s))) return null;
  const installments = group.filter((s) => s.line.kind === 'purchase' && s.line.installment);
  if (installments.length === 0) return null;
  const base = installments.reduce((best, s) =>
    s.line.installment!.number >= best.line.installment!.number ? s : best,
  );
  const { number: last, total } = base.line.installment!;
  const stored = planNumbers.get(`ofx:${fitidToken(fitid)}`) ?? new Set<number>();
  const numbers: number[] = [];
  for (let n = last + 1; n <= total; n++) if (!stored.has(n)) numbers.push(n);
  return { numbers, baseRef: base.line.ref };
}
