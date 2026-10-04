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
 *     sharing words with the row first, then in file order; smaller rows first); more than one subset makes the
 *     proposal ambiguous (unselected);
 *  5. stored future installment (sheet or earlier OFX), same N/M, amount within 1 cent: the real line consumes it;
 *     a prepayment's lines N+1..N+K consume the futures with those numbers (its discount is left to step 7);
 *  6. reversal: a purchase and a refund of the same amount and a similar merchant (unselected);
 *  7. the rest of the OFX is new (grouped by FITID, selected only in months without sheet rows); what is left of
 *     the month's sheet is reported, never deleted.
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
}

export type ProposalKind = 'enrich-exact' | 'enrich-plan' | 'enrich-sum' | 'consume-future' | 'create' | 'reversal';

export const PROPOSAL_KINDS: readonly ProposalKind[] = [
  'enrich-exact',
  'enrich-plan',
  'enrich-sum',
  'consume-future',
  'create',
  'reversal',
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
}

export interface ReconcileProposal {
  /** `kind|sorted refs joined by ','|target id` (see buildGroupId). */
  group: string;
  kind: ProposalKind;
  /** Sorted. */
  refs: string[];
  defaultSelected: boolean;
  ambiguous: boolean;
  /** Sheet row (enrich) or stored future (consume) the proposal writes to; null for create and reversal. */
  target: StoredCardRow | null;
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
  /** Payment lines that are not the previous invoice's payment and paired with no sheet credit. */
  unpairedAdvances: ReconcileLine[];
  monthHasSheet: boolean;
}

/** A +K plan or a FITID net may differ from the sheet by rounding of the prepayment discount. */
export const PLAN_TOLERANCE_CENTS = 2;
/** A sheet installment and the bank's one may differ by a cent of rounding when both carry the same N/M. */
export const INSTALLMENT_ROUNDING_CENTS = 1;
/** A stored future installment is the real one within one cent (its amount was copied or estimated). */
export const FUTURE_TOLERANCE_CENTS = 1;
/** Candidate purchases searched per sheet row in the sum step (2^15 subsets at most). */
export const SUM_MAX_CANDIDATES = 15;
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

  const propose = (
    kind: ProposalKind,
    states: LineState[],
    target: RowState | null,
    extra: Partial<Pick<ReconcileProposal, 'defaultSelected' | 'ambiguous' | 'result' | 'futureNumbers' | 'futureBaseRef' | 'tieBroken'>> = {},
  ): void => {
    const refs = states.map((s) => s.line.ref).sort();
    const group = buildGroupId(kind, refs, target?.row.id ?? null);
    for (const state of states) {
      state.status = 'proposed';
      state.group = group;
    }
    if (target) target.used = true;
    proposals.push({
      group,
      kind,
      refs,
      defaultSelected: extra.defaultSelected ?? true,
      ambiguous: extra.ambiguous ?? false,
      target: target?.row ?? null,
      result: extra.result ?? null,
      futureNumbers: extra.futureNumbers ?? [],
      futureBaseRef: extra.futureBaseRef ?? null,
      tieBroken: extra.tieBroken ?? false,
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

  // 0. The previous invoice's payment: the payment line closest to the reference, else the largest one.
  const paymentLines = lines.filter((s) => s.status === 'free' && s.line.kind === 'payment');
  let payment: LineState | null = null;
  if (paymentLines.length > 0) {
    const reference = input.paymentReference != null && input.paymentReference > 0 ? toCents(input.paymentReference) : null;
    payment = paymentLines.reduce((best, candidate) => {
      if (reference === null) return candidate.cents > best.cents ? candidate : best;
      const d = Math.abs(candidate.cents - reference);
      const bestD = Math.abs(best.cents - reference);
      if (d !== bestD) return d < bestD ? candidate : best;
      return candidate.cents > best.cents ? candidate : best;
    });
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
      if (free.length < 2) continue;
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
  const bySmallestAmount = [...sheet].sort((a, b) => a.cents - b.cents || a.index - b.index);
  for (const row of bySmallestAmount) {
    if (row.used || row.row.type !== 'EXPENSE') continue;
    const candidates = lines
      .filter((s) => s.status === 'free' && s.line.kind === 'purchase' && s.cents <= row.cents)
      .map((s) => ({ state: s, shared: sharedWordCount(row.words, s.words) }))
      .sort((a, b) => b.shared - a.shared || a.state.index - b.state.index)
      .slice(0, SUM_MAX_CANDIDATES)
      .map((c) => c.state);
    if (candidates.length < 2 || candidates.reduce((t, s) => t + s.cents, 0) < row.cents) continue;
    const { count, best } = subsetSumMatches(
      candidates.map((s) => s.cents),
      row.cents,
    );
    if (!best) continue;
    const states = best.map((i) => candidates[i]!);
    propose('enrich-sum', states, row, {
      ambiguous: count > 1,
      defaultSelected: count === 1,
      result: aggregateResult(states, row),
    });
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

  // 7. The rest of the OFX is new, one proposal per purchase (FITID). Advances left are information only.
  const leftovers = new Map<string, LineState[]>();
  for (const state of lines) {
    if (state.status !== 'free' || state.line.kind === 'payment') continue;
    leftovers.set(state.line.fitid, [...(leftovers.get(state.line.fitid) ?? []), state]);
  }
  for (const [fitid, group] of leftovers) {
    const plan = monthHasSheet ? null : futurePlan(fitid, group, lines, input.planNumbers);
    propose('create', group.sort(byFileOrder), null, {
      defaultSelected: !monthHasSheet,
      futureNumbers: plan?.numbers ?? [],
      futureBaseRef: plan?.baseRef ?? null,
    });
  }
  const unpairedAdvances: ReconcileLine[] = [];
  for (const state of lines) {
    if (state.status === 'free' && state.advance) {
      state.status = 'payment';
      unpairedAdvances.push(state.line);
    }
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
    monthHasSheet,
  };
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
