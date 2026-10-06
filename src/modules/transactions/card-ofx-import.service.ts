/**
 * Card invoice OFX importer (phase 3 of the MaxFin importer): preview and confirm.
 *
 * The preview parses the invoice, loads what the card already stores (the month's sheet rows, stored future
 * installments, rows the generic importer stored, refs already recorded) and returns the reconciliation proposals
 * of ofx-reconcile.ts. The confirm never trusts the client's ids: it validates the echoed lines against their own
 * content, recomputes the reconciliation on fresh data and applies only the selected groups that still exist,
 * recording every OFX ref it uses in transaction_external_refs so a re-import shows everything reconciled.
 */
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { effectiveClosingDay } from '../accounts/closing-day.js';
import { BadRequestError, NotFoundError } from '../../shared/errors/app-error.js';
import { AccountType, CategoryName, CategoryType, TransactionType, getCategoriesByType } from '../../shared/enums/index.js';
import { isCustomCategoryName, toCustomCategoryId } from '../../shared/utils/categoryHelpers.js';
import { clampText } from './parsers/maxfin.parser.js';
import type { MaxFinMonth } from './parsers/maxfin.types.js';
import {
  cardOfxContentKey,
  cardOfxLineType,
  cardOfxRef,
  classifyCardOfxLine,
  fitidToken,
  installmentFromMemo,
  merchantFromMemo,
  parseCardOfx,
  type CardOfxStatementLine,
} from './parsers/ofx-card.parser.js';
import {
  addMonths,
  firstDayOfMonth,
  invoiceTechnicalId,
  isFutureDraftRef,
  monthKey,
  normalizeLabel,
  parseLocalDateString,
  storedDateString,
  suggestCategory,
  type CategorySuggestion,
  type CustomCategoryRef,
} from './maxfin-import.helpers.js';
import {
  buildCategoryResolver,
  isUniqueViolation,
  loadCustomCategories,
  suggestionToDto,
  type AuthorizeHousehold,
} from './maxfin-import.service.js';
import type { MaxFinCategoryMapEntry, MaxFinCategoryMapInput } from './maxfin-import.types.js';
import { computeClosing } from './card-ofx-closing.js';
import {
  parseGroupId,
  reconcileCardOfx,
  toCents,
  type ReconcileProposal,
  type ReconcileResult,
  type StoredCardRow,
} from './ofx-reconcile.js';
import {
  createTransaction,
  deleteTransaction,
  payCreditCardInvoice,
  undoCreditCardPayment,
  updateTransaction,
} from './transactions.service.js';
import type {
  CardOfxConfirmLine,
  CardOfxConfirmRequest,
  CardOfxConfirmResponse,
  CardOfxLine,
  CardOfxOptionsInput,
  CardOfxPayment,
  CardOfxPreviewResponse,
  CardOfxProposal,
  CardOfxTransactionRef,
} from './card-ofx-import.types.js';

/** Lines one invoice may hold (the confirm accepts as many). */
export const MAX_CARD_OFX_LINES = 1000;
/** BALAMT and the lines may differ by the bank's rounding; beyond this the preview says so. */
const BALANCE_WARNING_CENTS = 5;
const MAX_DESCRIPTION = 255;
const MAX_NOTES = 1000;
/** Bounds of the category-history lookup (merchants in one OR, rows read). */
const MAX_HISTORY_MERCHANTS = 200;
const MAX_HISTORY_ROWS = 2000;

// ---------------------------------------------------------------------------
// Card account and invoice month
// ---------------------------------------------------------------------------

export interface ResolvedCardAccount {
  id: string;
  name: string;
  type: AccountType;
  householdId: string;
  dueDay: number | null;
  closingDay: number | null;
}

/**
 * Load the card, authorize its household (the routes pass requireEditor) and only then check that it is a credit
 * card, so a caller outside the household learns nothing about the account.
 * @throws NotFoundError (404) when the account does not exist or is inactive; BadRequestError (400) when it is not
 * a credit card.
 */
export async function resolveCardAccount(accountId: string, authorize?: AuthorizeHousehold): Promise<ResolvedCardAccount> {
  const account = await prisma.account.findFirst({
    where: { id: accountId, isActive: true },
    select: { id: true, name: true, type: true, householdId: true, dueDay: true, closingDay: true },
  });
  if (!account) throw new NotFoundError('Account');
  if (authorize) await authorize(account.householdId);
  if (account.type !== AccountType.CREDIT) {
    throw new BadRequestError(`Account "${account.name}" is not a credit card: the card invoice import needs a CREDIT account.`);
  }
  return {
    id: account.id,
    name: account.name,
    type: account.type as AccountType,
    householdId: account.householdId,
    dueDay: account.dueDay ?? null,
    // Explicit closing day, or due day - 7 when the card has none
    closingDay: effectiveClosingDay(account),
  };
}

/**
 * Invoice month = due month. The statement closes on DTEND; it is due in the same month when the card's due day
 * comes after its closing day (DTEND's day when the card has none), otherwise in the next month. Without a due
 * day the closing month is used (`guessed`).
 */
export function invoiceMonthFromStatement(
  closing: string,
  card: Pick<ResolvedCardAccount, 'dueDay' | 'closingDay'>,
): { month: MaxFinMonth; guessed: boolean } {
  const closingMonth: MaxFinMonth = { year: Number(closing.slice(0, 4)), month: Number(closing.slice(5, 7)) };
  if (card.dueDay == null) return { month: closingMonth, guessed: true };
  const closingDay = card.closingDay ?? Number(closing.slice(8, 10));
  return { month: card.dueDay > closingDay ? closingMonth : addMonths(closingMonth, 1), guessed: false };
}

// ---------------------------------------------------------------------------
// Small pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** True for the sourceRef of a future installment generated from an OFX line (`<line ref>:f<i>`). */
export function isOfxFutureRef(sourceRef: string | null | undefined): boolean {
  return !!sourceRef && /^ofx:[^:]+:[0-9a-f]{8}:f\d+$/.test(sourceRef);
}

/** "R$ 1.234,56" (negative values keep their sign). */
export function formatBRL(amount: number): string {
  const cents = toCents(amount);
  const abs = Math.abs(cents);
  const integer = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cents < 0 ? '-' : ''}R$ ${integer},${String(abs % 100).padStart(2, '0')}`;
}

/** A date-only bound for @db.Date columns (stored as UTC midnight): the day itself, whatever the server's time zone. */
function utcDay(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function formatDay(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
}

/** Existing notes + " · " + the appended text, cut to the 1000 characters a transaction holds. */
export function joinNotes(existing: string | null, append: string | null): string | null {
  if (!append) return existing;
  const base = existing?.trim();
  return clampText(base ? `${base} · ${append}` : append, MAX_NOTES);
}

/** The memo of installment `number` of the plan ("Loja - Parcela 3/10" -> "Loja - Parcela 4/10"). */
export function futureInstallmentMemo(memo: string, number: number, total: number): string {
  const pattern = /(parcela\s+)\d{1,3}(\s*\/\s*)\d{1,3}/i;
  if (!pattern.test(memo)) return `${merchantFromMemo(memo)} - Parcela ${number}/${total}`;
  return memo.replace(pattern, (_whole, before: string, slash: string) => `${before}${number}${slash}${total}`);
}

/** Plan id of the installments created from an OFX purchase. */
export function ofxPlanId(fitid: string): string {
  return `ofx:${fitidToken(fitid)}`;
}

/** Category-map key of a merchant (the monthly sheet's normalization: accents, case and spaces ignored). */
function mapKey(type: 'INCOME' | 'EXPENSE', key: string): string {
  return `${type}|${normalizeLabel(key)}`;
}

/** Merchant of a stored description for the category history: bank suffixes and the sheet's "N/M +K" dropped. */
function merchantKey(description: string): string {
  const withoutSheetInstallment = description.replace(/\s+\d{1,2}\s*\/\s*\d{1,2}(\s*\+\s*\d{1,2})?\s*$/, '');
  return normalizeLabel(merchantFromMemo(withoutSheetInstallment));
}

/** Net of lines in cents: purchases count up, credits (refunds, discounts) down. */
function netCents(lines: Array<{ type: 'INCOME' | 'EXPENSE'; amount: number }>): number {
  return lines.reduce((total, l) => total + (l.type === 'EXPENSE' ? toCents(l.amount) : -toCents(l.amount)), 0);
}

// ---------------------------------------------------------------------------
// Loading what the card stores
// ---------------------------------------------------------------------------

export const CARD_ROW_SELECT = {
  id: true,
  description: true,
  amount: true,
  type: true,
  date: true,
  sourceRef: true,
  notes: true,
  paid: true,
  installmentId: true,
  installmentNumber: true,
  totalInstallments: true,
  categoryName: true,
  isSplit: true,
  recurringTransactionId: true,
  attachmentUrl: true,
} as const;

interface CardRowRecord {
  id: string;
  description: string | null;
  amount: { toNumber(): number };
  type: string;
  date: Date;
  sourceRef: string | null;
  notes: string | null;
  paid: boolean;
  installmentId: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
  categoryName?: string | null;
  isSplit?: boolean | null;
  recurringTransactionId?: string | null;
  attachmentUrl?: string | null;
}

function toStoredRow(t: CardRowRecord): StoredCardRow | null {
  if (t.type !== TransactionType.INCOME && t.type !== TransactionType.EXPENSE) return null;
  return {
    id: t.id,
    description: t.description ?? '',
    amount: t.amount.toNumber(),
    type: t.type as 'INCOME' | 'EXPENSE',
    date: storedDateString(t.date),
    sourceRef: t.sourceRef,
    notes: t.notes,
    paid: t.paid,
    installmentId: t.installmentId,
    installmentNumber: t.installmentNumber,
    totalInstallments: t.totalInstallments,
    categoryName: t.categoryName ?? null,
    // Shares and settlements are added by markMergeBlocked.
    mergeBlocked: !!t.isSplit || !!t.recurringTransactionId || !!t.attachmentUrl,
  };
}

/** Rows with shares of other people or a settlement are never merged (deleting one would lose that link). */
export async function markMergeBlocked(rows: StoredCardRow[]): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  const [shares, settlements] = await Promise.all([
    prisma.transactionShare.findMany({ where: { transactionId: { in: ids } }, select: { transactionId: true } }),
    prisma.settlement.findMany({ where: { transactionId: { in: ids } }, select: { transactionId: true } }),
  ]);
  const blocked = new Set<string>([...shares, ...settlements].map((r) => r.transactionId).filter((id): id is string => !!id));
  for (const row of rows) if (blocked.has(row.id)) row.mergeBlocked = true;
}

export function storedRows(records: CardRowRecord[]): StoredCardRow[] {
  return records.map(toStoredRow).filter((row): row is StoredCardRow => row !== null);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sheet line number of `maxfin:<month>:credit:<line>`, to keep the sheet order. */
function sheetLine(sourceRef: string | null): number {
  const match = /:(\d+)$/.exec(sourceRef ?? '');
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export interface RecordedPayment {
  id: string;
  amount: number;
  date: Date;
  accountId: string | null;
  description: string | null;
}

interface CardContext {
  input: Parameters<typeof reconcileCardOfx>[0];
  /** Payments recorded for the previous invoice, latest first. */
  recordedPayments: RecordedPayment[];
  /**
   * The previous invoice is older than the first sheet month of the card and has no recorded payment: Recta holds
   * none of its purchases, so a payment for it would be recorded against nothing.
   */
  paymentBeforeSheet: boolean;
  /** See ReconcileInput.vanished. */
  vanished: Array<{ row: StoredCardRow; fitids: string[] }>;
  /** Rows tied to OFX lines strictly inside the statement's period (preview only) that the file no longer lists. */
  gone: Array<{ row: StoredCardRow; fitids: string[] }>;
}

/** Earliest invoice month ('YYYY-MM') with sheet rows (not generated futures) on the card; null when there is none. */
export async function loadEarliestSheetMonth(householdId: string, cardId: string): Promise<string | null> {
  const rows = await prisma.transaction.findMany({
    where: { householdId, accountId: cardId, sourceRef: { startsWith: 'maxfin:', contains: ':credit:' } },
    select: { sourceRef: true },
  });
  let earliest: string | null = null;
  for (const row of rows) {
    if (isFutureDraftRef(row.sourceRef)) continue;
    const match = /^maxfin:(\d{4}-\d{2}):credit:\d+$/.exec(row.sourceRef ?? '');
    if (match && (earliest === null || match[1]! < earliest)) earliest = match[1]!;
  }
  return earliest;
}

async function loadCardContext(
  card: ResolvedCardAccount,
  month: MaxFinMonth,
  lines: CardOfxStatementLine[],
  period?: { start: string; end: string },
): Promise<CardContext> {
  const { householdId } = card;
  const key = monthKey(month);
  const previous = addMonths(month, -1);
  const refs = lines.map((l) => l.ref);

  const sheetRows = storedRows(
    await prisma.transaction.findMany({
      where: { householdId, accountId: card.id, sourceRef: { startsWith: `maxfin:${key}:credit:` } },
      select: CARD_ROW_SELECT,
    }),
  )
    .filter((row) => !isFutureDraftRef(row.sourceRef))
    .sort((a, b) => sheetLine(a.sourceRef) - sheetLine(b.sourceRef));
  await markMergeBlocked(sheetRows);

  // Sheet rows of the adjacent invoice months (+-1): candidates of the neighbour step (the sheet may have typed a
  // purchase in the wrong month).
  const neighbourRows = storedRows(
    await prisma.transaction.findMany({
      where: {
        householdId,
        accountId: card.id,
        OR: [
          { sourceRef: { startsWith: `maxfin:${monthKey(previous)}:credit:` } },
          { sourceRef: { startsWith: `maxfin:${monthKey(addMonths(month, 1))}:credit:` } },
        ],
      },
      select: CARD_ROW_SELECT,
    }),
  )
    .filter((row) => !isFutureDraftRef(row.sourceRef))
    .sort((a, b) => compareText(a.sourceRef ?? '', b.sourceRef ?? '') || sheetLine(a.sourceRef) - sheetLine(b.sourceRef));
  await markMergeBlocked(neighbourRows);

  const futures = storedRows(
    await prisma.transaction.findMany({
      where: {
        householdId,
        accountId: card.id,
        date: { gte: firstDayOfMonth(month) },
        installmentNumber: { not: null },
        sourceRef: { contains: ':f' },
      },
      select: CARD_ROW_SELECT,
    }),
  )
    .filter((row) => isFutureDraftRef(row.sourceRef) || isOfxFutureRef(row.sourceRef))
    .sort((a, b) => compareText(a.date, b.date) || compareText(a.sourceRef ?? '', b.sourceRef ?? ''));

  const days = lines.map((l) => l.date).sort();
  const legacyStart = parseLocalDateString(days[0]!);
  const legacyEnd = parseLocalDateString(days[days.length - 1]!);
  legacyEnd.setHours(23, 59, 59, 999);
  const legacy = storedRows(
    await prisma.transaction.findMany({
      where: { householdId, accountId: card.id, sourceRef: null, date: { gte: legacyStart, lte: legacyEnd } },
      select: CARD_ROW_SELECT,
      // A total order, so the preview and the confirm pair identical legacy rows the same way.
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    }),
  );

  // Refs already used: transactions an earlier import created from them, and the external refs table (which
  // also tells which candidate rows already represent OFX lines).
  const createdFromRefs = await prisma.transaction.findMany({
    where: { householdId, sourceRef: { in: refs } },
    select: { id: true, sourceRef: true },
  });
  const candidateIds = [...sheetRows, ...neighbourRows, ...futures, ...legacy].map((row) => row.id);
  const externalRefs = await prisma.transactionExternalRef.findMany({
    where: { householdId, OR: [{ ref: { in: refs } }, { transactionId: { in: candidateIds } }] },
    select: { ref: true, transactionId: true },
  });
  const knownRefs = new Map<string, string>();
  for (const t of createdFromRefs) if (t.sourceRef) knownRefs.set(t.sourceRef, t.id);
  for (const r of externalRefs) knownRefs.set(r.ref, r.transactionId);
  const linkedTransactionIds = new Set(externalRefs.map((r) => r.transactionId));
  const ofxLinkedIds = new Set(externalRefs.filter((r) => r.ref.startsWith('ofx:')).map((r) => r.transactionId));

  // Rows tied to OFX refs the file does not list. Never touched: they hold back look-alike new purchases (the same
  // FITID and installment number under another ref: the statement changed the amount, date or memo) and feed a warning.
  const fileRefs = new Set(refs);
  const rowsByIds = async (ids: string[], range?: { gte: Date; lte: Date }) =>
    new Map(
      (
        await prisma.transaction.findMany({
          where: { householdId, accountId: card.id, attachmentUrl: null, id: { in: ids }, ...(range ? { date: range } : {}) },
          select: CARD_ROW_SELECT,
        })
      ).map((t) => [t.id, t] as const),
    );
  const groupRefs = (tied: Array<{ ref: string; transactionId: string }>, records: Map<string, CardRowRecord>) => {
    const byRow = new Map<string, { record: CardRowRecord; refs: string[] }>();
    for (const t of tied) {
      const record = records.get(t.transactionId);
      if (!record) continue;
      const entry = byRow.get(record.id) ?? { record, refs: [] };
      entry.refs.push(t.ref);
      byRow.set(record.id, entry);
    }
    const out: Array<{ row: StoredCardRow; fitids: string[] }> = [];
    for (const { record, refs: rowRefs } of byRow.values()) {
      if (rowRefs.some((r) => fileRefs.has(r))) continue;
      const row = toStoredRow(record);
      if (row) out.push({ row, fitids: rowRefs.map((r) => r.split(':')[1] ?? '') });
    }
    return out;
  };
  const tokens = Array.from(new Set(lines.filter((l) => l.kind !== 'payment').map((l) => fitidToken(l.fitid))));
  const vanished: CardContext['vanished'] = [];
  // Only inside the statement's own period (boundary days included): the lines of one plan (purchase, discount, refund)
  // share a FITID across statements, so the same FITID elsewhere in time is not the same line.
  if (tokens.length > 0 && period) {
    const periodRange = { gte: parseLocalDateString(period.start), lte: parseLocalDateString(period.end) };
    periodRange.lte.setHours(23, 59, 59, 999);
    const sameFitid = await prisma.transactionExternalRef.findMany({
      where: { householdId, OR: tokens.map((t) => ({ ref: { startsWith: `ofx:${t}:` } })) },
      select: { ref: true, transactionId: true },
    });
    vanished.push(...groupRefs(sameFitid, await rowsByIds(Array.from(new Set(sameFitid.map((r) => r.transactionId))), periodRange)));
  }
  // What the warning lists: rows strictly inside the statement's period (the boundary days belong to two statements).
  const gone: CardContext['vanished'] = [];
  if (period) {
    const first = parseLocalDateString(period.start);
    first.setDate(first.getDate() + 1);
    const last = parseLocalDateString(period.end);
    last.setDate(last.getDate() - 2);
    last.setHours(23, 59, 59, 999);
    const inside = await prisma.transaction.findMany({
      where: { householdId, accountId: card.id, attachmentUrl: null, date: { gte: first, lte: last } },
      select: CARD_ROW_SELECT,
    });
    const tied = await prisma.transactionExternalRef.findMany({
      where: { householdId, ref: { startsWith: 'ofx:' }, transactionId: { in: inside.map((t) => t.id) } },
      select: { ref: true, transactionId: true },
    });
    gone.push(...groupRefs(tied, new Map(inside.map((t) => [t.id, t] as const))));
  }

  const planIds = Array.from(new Set(lines.filter((l) => l.installment).map((l) => ofxPlanId(l.fitid))));
  const planNumbers = new Map<string, Set<number>>();
  if (planIds.length > 0) {
    const planRows = await prisma.transaction.findMany({
      where: { householdId, accountId: card.id, installmentId: { in: planIds } },
      select: { installmentId: true, installmentNumber: true },
    });
    for (const row of planRows) {
      if (!row.installmentId || row.installmentNumber == null) continue;
      planNumbers.set(row.installmentId, (planNumbers.get(row.installmentId) ?? new Set()).add(row.installmentNumber));
    }
  }

  const recordedPayments: RecordedPayment[] = (
    await prisma.transaction.findMany({
      where: { householdId, attachmentUrl: invoiceTechnicalId(card.id, previous) },
      select: { id: true, amount: true, date: true, accountId: true, description: true },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    })
  ).map((p) => ({ id: p.id, amount: p.amount.toNumber(), date: p.date, accountId: p.accountId, description: p.description }));

  // Which "Pagamento recebido" pays the previous invoice: the one closest to its recorded payment, else to the
  // total of its sheet rows on this card (only needed when the invoice holds several payments).
  let paymentReference: number | null = null;
  if (recordedPayments.length > 0) {
    paymentReference = recordedPayments.reduce((total, p) => total + toCents(p.amount), 0) / 100;
  } else if (lines.filter((l) => l.kind === 'payment').length > 1) {
    const previousSheet = storedRows(
      await prisma.transaction.findMany({
        where: { householdId, accountId: card.id, sourceRef: { startsWith: `maxfin:${monthKey(previous)}:credit:` } },
        select: CARD_ROW_SELECT,
      }),
    ).filter((row) => !isFutureDraftRef(row.sourceRef));
    const net = netCents(previousSheet);
    paymentReference = net > 0 ? net / 100 : null;
  }

  const earliestSheetMonth = await loadEarliestSheetMonth(householdId, card.id);
  // History = purchases dated before the calendar month of the first sheet month (the sheet never covered them).
  const historyBefore = earliestSheetMonth ? `${earliestSheetMonth}-01` : null;

  return {
    input: {
      lines,
      sheetRows,
      futures,
      legacy,
      knownRefs,
      linkedTransactionIds,
      planNumbers,
      paymentReference,
      historyBefore,
      neighbourRows,
      vanished,
      neighbourStatementMonths: new Set(
        neighbourRows
          .filter((row) => ofxLinkedIds.has(row.id))
          .map((row) => /^maxfin:(\d{4}-\d{2}):/.exec(row.sourceRef ?? '')?.[1])
          .filter((m): m is string => !!m),
      ),
    },
    recordedPayments,
    vanished,
    gone,
    paymentBeforeSheet: recordedPayments.length === 0 && earliestSheetMonth !== null && monthKey(previous) < earliestSheetMonth,
  };
}

// ---------------------------------------------------------------------------
// Payment of the previous invoice
// ---------------------------------------------------------------------------

/** ok: the recorded payment(s) match the bank; adjust: amount (or the single payment's date) differs; create: none. */
export function paymentProposal(line: Pick<CardOfxStatementLine, 'amount' | 'date'>, recorded: RecordedPayment[]): CardOfxPayment['proposal'] {
  if (recorded.length === 0) return 'create';
  const sum = recorded.reduce((total, p) => total + toCents(p.amount), 0);
  if (sum !== toCents(line.amount)) return 'adjust';
  if (recorded.length === 1 && storedDateString(recorded[0]!.date) !== line.date) return 'adjust';
  return 'ok';
}

/** Several recorded payments from different accounts become one payment from one account when adjusted. */
export function collapseWarning(recorded: RecordedPayment[], invoiceMonthKey: string): string | null {
  const accounts = new Set(recorded.map((p) => p.accountId));
  if (accounts.size < 2) return null;
  return `A fatura de ${invoiceMonthKey} tem pagamentos registrados de ${accounts.size} contas diferentes: o ajuste os troca por um só, pago de uma única conta.`;
}

function paymentDto(
  result: ReconcileResult,
  recorded: RecordedPayment[],
  month: MaxFinMonth,
  usableSource: string | null,
  beforeSheet: boolean,
): CardOfxPayment | null {
  if (!result.payment) return null;
  const { line } = result.payment;
  const latest = recorded[0];
  return {
    ref: line.ref,
    amount: line.amount,
    date: line.date,
    invoiceMonthKey: monthKey(addMonths(month, -1)),
    recorded: latest
      ? {
          transactionId: latest.id,
          amount: recorded.reduce((total, p) => total + toCents(p.amount), 0) / 100,
          date: storedDateString(latest.date),
          sourceAccountId: usableSource,
        }
      : null,
    proposal: beforeSheet ? 'ok' : paymentProposal(line, recorded),
  };
}

/** An account an invoice can be paid from: active, of the household, not a credit card. */
export async function payingAccount(accountId: string, householdId: string): Promise<'ok' | 'missing' | 'credit'> {
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId, isActive: true },
    select: { type: true },
  });
  if (!account) return 'missing';
  return account.type === AccountType.CREDIT ? 'credit' : 'ok';
}

function paymentDescription(invoiceMonth: MaxFinMonth): string {
  return `Pagamento de fatura - ${String(invoiceMonth.month).padStart(2, '0')}/${invoiceMonth.year} (OFX)`;
}

// ---------------------------------------------------------------------------
// Categories of the lines that become transactions
// ---------------------------------------------------------------------------

/** Suggestion from the category of the household's latest transaction of that type and merchant, if it still fits. */
function historySuggestion(
  categoryName: string | undefined,
  type: 'INCOME' | 'EXPENSE',
  customs: CustomCategoryRef[],
): CategorySuggestion | null {
  if (!categoryName) return null;
  if (isCustomCategoryName(categoryName)) {
    const id = toCustomCategoryId(categoryName);
    const custom = customs.find((c) => c.id === id && c.type === type);
    return custom ? { kind: 'custom', categoryId: custom.id, categoryName, name: custom.name } : null;
  }
  const allowed = getCategoriesByType(type === 'INCOME' ? CategoryType.INCOME : CategoryType.EXPENSE) as string[];
  const fallback = type === 'INCOME' ? CategoryName.OTHER_INCOME : CategoryName.OTHER_EXPENSES;
  // "Other" says nothing about the merchant: let the label rules try.
  if (!allowed.includes(categoryName) || categoryName === fallback) return null;
  return { kind: 'system', categoryName: categoryName as CategoryName };
}

/**
 * One suggestion per (type, merchant): the category of the latest household transaction with that merchant, else
 * the monthly sheet's label rule (system category, existing custom category) and else the default category. A
 * merchant never suggests creating a category (one category per store would flood the list).
 */
export async function suggestMerchantCategories(
  householdId: string,
  items: Array<{ type: 'INCOME' | 'EXPENSE'; merchant: string }>,
): Promise<Map<string, CategorySuggestion>> {
  const suggestions = new Map<string, CategorySuggestion>();
  if (items.length === 0) return suggestions;
  const customs = await loadCustomCategories(householdId);
  const merchants = Array.from(new Set(items.map((item) => item.merchant.trim()).filter((m) => m.length > 0)));
  const history =
    merchants.length === 0
      ? []
      : await prisma.transaction.findMany({
          where: {
            householdId,
            type: { in: [TransactionType.INCOME, TransactionType.EXPENSE] },
            categoryName: { not: null },
            OR: merchants.slice(0, MAX_HISTORY_MERCHANTS).map((m) => ({ description: { contains: m, mode: 'insensitive' as const } })),
          },
          select: { description: true, categoryName: true, type: true },
          orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
          take: MAX_HISTORY_ROWS,
        });
  const latest = new Map<string, string>();
  for (const t of history) {
    const key = `${t.type}|${merchantKey(t.description ?? '')}`;
    if (!latest.has(key) && t.categoryName) latest.set(key, t.categoryName);
  }
  for (const { type, merchant } of items) {
    const key = mapKey(type, merchant);
    if (suggestions.has(key)) continue;
    const fromHistory = historySuggestion(latest.get(`${type}|${merchantKey(merchant)}`), type, customs);
    if (fromHistory) {
      suggestions.set(key, fromHistory);
      continue;
    }
    const byLabel = suggestCategory(merchant, type, customs);
    suggestions.set(
      key,
      byLabel.kind === 'create'
        ? { kind: 'default', categoryName: type === 'INCOME' ? CategoryName.OTHER_INCOME : CategoryName.OTHER_EXPENSES }
        : byLabel,
    );
  }
  return suggestions;
}

function suggestionCategoryName(suggestion: CategorySuggestion | undefined, type: 'INCOME' | 'EXPENSE'): string {
  if (suggestion && suggestion.kind !== 'create') return suggestion.categoryName;
  return type === 'INCOME' ? CategoryName.OTHER_INCOME : CategoryName.OTHER_EXPENSES;
}

/** Category map of the merchants of the create proposals, one entry per (type, merchant). */
async function buildCardCategoryMap(householdId: string, lines: CardOfxStatementLine[]): Promise<MaxFinCategoryMapEntry[]> {
  const entries = new Map<string, { key: string; type: 'INCOME' | 'EXPENSE'; count: number }>();
  for (const l of lines) {
    const key = mapKey(l.type, l.merchant);
    const entry = entries.get(key) ?? { key: l.merchant, type: l.type, count: 0 };
    entry.count += 1;
    entries.set(key, entry);
  }
  const suggestions = await suggestMerchantCategories(
    householdId,
    [...entries.values()].map((e) => ({ type: e.type, merchant: e.key })),
  );
  return [...entries.entries()]
    .sort(([a, ea], [b, eb]) => (ea.type !== eb.type ? (ea.type === 'INCOME' ? -1 : 1) : a < b ? -1 : a > b ? 1 : 0))
    .map(([key, e]) => ({
      key: e.key,
      type: e.type,
      count: e.count,
      sections: ['credit'],
      suggestion: suggestionToDto(suggestions.get(key) ?? { kind: 'default', categoryName: CategoryName.OTHER_EXPENSES }),
    }));
}

interface LineCategories {
  categoryNameFor(line: CardOfxStatementLine): string;
  created: CardOfxConfirmResponse['createdCategories'];
}

/**
 * Categories of the lines confirm creates: the client's map for the merchants it covers (categories to create are
 * found or created like in the monthly sheet), the preview's suggestion for the others (reversal pairs, a map
 * left out). Only entries used by these lines are resolved, so an unused 'create' entry creates nothing.
 */
async function resolveLineCategories(
  householdId: string,
  mapInput: MaxFinCategoryMapInput[],
  lines: CardOfxStatementLine[],
): Promise<LineCategories> {
  if (lines.length === 0) return { created: [], categoryNameFor: (l) => suggestionCategoryName(undefined, l.type) };
  const used = new Set(lines.map((l) => mapKey(l.type, l.merchant)));
  const entries = mapInput.filter((e) => used.has(mapKey(e.type, e.key)));
  const resolver = await buildCategoryResolver(householdId, entries);
  const mapped = new Set(entries.map((e) => mapKey(e.type, e.key)));
  const unmapped = lines.filter((l) => !mapped.has(mapKey(l.type, l.merchant)));
  const suggestions = await suggestMerchantCategories(householdId, unmapped.map((l) => ({ type: l.type, merchant: l.merchant })));
  return {
    created: resolver.created,
    categoryNameFor(line) {
      const key = mapKey(line.type, line.merchant);
      return mapped.has(key) ? resolver.categoryNameFor(line.merchant, line.type) : suggestionCategoryName(suggestions.get(key), line.type);
    },
  };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function toTransactionRef(row: StoredCardRow): CardOfxTransactionRef {
  return {
    transactionId: row.id,
    description: row.description,
    amount: row.amount,
    type: row.type,
    date: row.date,
    sourceRef: row.sourceRef,
  };
}

function toProposalDto(p: ReconcileProposal): CardOfxProposal {
  return {
    group: p.group,
    kind: p.kind,
    refs: p.refs,
    defaultSelected: p.defaultSelected,
    ambiguous: p.ambiguous,
    target: p.target ? toTransactionRef(p.target) : null,
    absorbed: p.absorbed.map(toTransactionRef),
    reason: p.reason,
    counterpart: p.counterpart ? toTransactionRef(p.counterpart) : null,
    result: p.result,
    futureInstallments: p.futureNumbers.length,
  };
}

export interface BuildCardOfxPreviewParams {
  /** Resolved (and authorized) by the route. */
  account: ResolvedCardAccount;
  buffer: Buffer;
  options?: CardOfxOptionsInput;
}

export async function buildCardOfxPreview(params: BuildCardOfxPreviewParams): Promise<CardOfxPreviewResponse> {
  const { account } = params;
  const statement = parseCardOfx(params.buffer);
  if (statement.lines.length === 0) {
    throw new BadRequestError('No readable transactions found in the card invoice.');
  }
  if (statement.lines.length > MAX_CARD_OFX_LINES) {
    throw new BadRequestError(
      `The invoice holds ${statement.lines.length} transactions; at most ${MAX_CARD_OFX_LINES} are imported at once.`,
    );
  }
  const warnings = [...statement.warnings];
  if (statement.skipped.length > 0) {
    const reasons = statement.skipped.slice(0, 5).map((s) => `#${s.position}: ${s.reason}`);
    warnings.push(`${statement.skipped.length} lançamento(s) do OFX não puderam ser lidos (${reasons.join('; ')}).`);
  }

  const days = statement.lines.map((l) => l.date).sort();
  const period = { start: statement.period.start ?? days[0]!, end: statement.period.end ?? days[days.length - 1]! };
  if (!statement.period.end) {
    warnings.push(`O OFX não traz o fim do período (DTEND): o fechamento foi tomado da última data (${formatDay(period.end)}).`);
  }

  let month: MaxFinMonth;
  let monthSource: CardOfxPreviewResponse['monthSource'];
  if (params.options?.monthOverride) {
    month = params.options.monthOverride;
    monthSource = 'override';
  } else {
    const derived = invoiceMonthFromStatement(period.end, account);
    month = derived.month;
    monthSource = 'statement';
    if (derived.guessed) {
      warnings.push(
        `O cartão "${account.name}" não tem dia de vencimento configurado: a fatura foi tomada como a do mês do fechamento (${formatDay(period.end)}); corrija o mês se precisar.`,
      );
    }
  }
  if (!account.closingDay) {
    warnings.push(
      `O cartão "${account.name}" não tem dia de fechamento nem de vencimento configurado: no Recta as faturas seguem o mês calendário, e a data real de uma compra pode levá-la para outra fatura.`,
    );
  }

  const purchasesAndCredits = statement.lines.filter((l) => l.kind !== 'payment');
  const ofxTotalCents = netCents(purchasesAndCredits);
  if (statement.balance !== null && Math.abs(-toCents(statement.balance) - ofxTotalCents) > BALANCE_WARNING_CENTS) {
    warnings.push(
      `O saldo da fatura no OFX (${formatBRL(-statement.balance)}) difere do total das linhas (${formatBRL(ofxTotalCents / 100)}).`,
    );
  }

  const context = await loadCardContext(account, month, statement.lines, period);
  const result = reconcileCardOfx(context.input);
  const lineByRef = new Map(statement.lines.map((l) => [l.ref, l]));

  const lines: CardOfxLine[] = statement.lines.map((l, i) => ({
    ...l,
    status: result.lines[i]!.status,
    group: result.lines[i]!.group,
  }));
  const proposals = result.proposals.map(toProposalDto);
  const creates = result.proposals.filter((p) => p.kind === 'create');
  const createLines = creates.flatMap((p) => p.refs.map((ref) => lineByRef.get(ref)!));

  if (result.payment && context.paymentBeforeSheet) {
    const { line } = result.payment;
    warnings.push(
      `O pagamento de ${formatBRL(line.amount)} em ${formatDay(line.date)} quita a fatura de ${monthKey(addMonths(month, -1))}, anterior à planilha: o Recta não tem as compras dela, então o pagamento não será registrado.`,
    );
  }
  if (result.mergeBudgetExhausted) {
    warnings.push('A busca por linhas da planilha que somam uma compra do banco foi interrompida por excesso de combinações: algumas compras ficaram sem proposta de mesclagem.');
  }
  const heldLinks = result.proposals.filter((p) => (p.kind === 'enrich-neighbour' || p.kind === 'enrich-group' || p.kind === 'enrich-near') && !p.defaultSelected);
  if (heldLinks.length > 0) {
    warnings.push(
      `${heldLinks.length} pareamento(s) por mês vizinho, grupo do mesmo estabelecimento ou valor próximo vieram desmarcados (ambíguos, sem palavra em comum ou com lista grande demais): confira antes de aplicar.`,
    );
  }
  const adoptions = result.proposals.filter((p) => p.kind === 'enrich-near' && p.defaultSelected);
  if (adoptions.length > 0) {
    const paid = await prisma.transaction.findMany({
      where: { householdId: account.householdId, attachmentUrl: invoiceTechnicalId(account.id, month) },
      select: { amount: true },
    });
    if (paid.length > 0) {
      const sum = paid.reduce((total, p) => total + toCents(p.amount.toNumber()), 0) / 100;
      warnings.push(
        `${adoptions.length} linha(s) vão adotar o valor do banco (centavos de diferença), mas a fatura de ${monthKey(month)} já tem pagamento registrado (${formatBRL(sum)}): confira se o pagamento ainda bate com a fatura.`,
      );
    }
  }
  const heldMerges = result.proposals.filter((p) => p.kind === 'enrich-merge' && !p.defaultSelected);
  if (heldMerges.length > 0) {
    warnings.push(
      `${heldMerges.length} mesclagem(ns) de linhas da planilha vieram desmarcadas (ambígua, sem palavras em comum com a compra, ou categorias diferentes): confira antes de aplicar.`,
    );
  }
  const lookAlikes = result.proposals.filter((p) => p.kind === 'create' && p.counterpart && p.reason !== 'changed-in-statement');
  if (lookAlikes.length > 0) {
    const rows = new Map(lookAlikes.map((p) => [p.counterpart!.id, p.counterpart!]));
    const listed = [...rows.values()].map((row) => `${row.description} (${formatBRL(row.amount)})`).join('; ');
    warnings.push(
      `${lookAlikes.length} compra(s) anterior(es) à planilha ficaram desmarcadas porque lembram linhas sem par do cartão: ${listed}. Se forem as mesmas compras, resolva a linha da planilha antes; se não, marque-as.`,
    );
  }
  if (result.proposals.some((p) => p.kind === 'create' && p.reason === 'sheet-residue')) {
    warnings.push(
      'Há compras novas desmarcadas porque ainda sobram linhas da planilha sem par no OFX (elas podem ser as mesmas compras com outro valor ou data): resolva as sobras antes de importar.',
    );
  }
  if (result.payment?.legacyDuplicateId) {
    const { line } = result.payment;
    warnings.push(
      `Já existe no cartão um crédito "${line.memo}" de ${formatBRL(line.amount)} em ${formatDay(line.date)} (importação genérica): com o pagamento da fatura ele conta duas vezes; apague esse lançamento.`,
    );
  }
  const held = result.proposals.filter((p) => p.kind === 'create' && p.reason === 'changed-in-statement');
  if (held.length > 0) {
    warnings.push(
      `${held.length} compra(s) mudaram de valor, data ou descrição no OFX em relação ao que já foi importado e vieram desmarcadas para não duplicar: ` +
        `${held.map((p) => `${p.counterpart!.description} (${formatBRL(p.counterpart!.amount)} em ${formatDay(p.counterpart!.date)} no Recta; ${formatBRL(lineByRef.get(p.refs[0]!)!.amount)} em ${formatDay(lineByRef.get(p.refs[0]!)!.date)} no OFX)`).slice(0, 5).join('; ')}. ` +
        'Corrija o lançamento existente à mão (ou apague-o) antes de marcar a nova compra.',
    );
  }
  const heldIds = new Set(held.map((p) => p.counterpart!.id));
  const gone = context.gone.filter((v) => !heldIds.has(v.row.id));
  if (gone.length > 0) {
    const sum = netCents(gone.map((v) => ({ type: v.row.type, amount: v.row.amount }))) / 100;
    warnings.push(
      `${gone.length} lançamento(s) importado(s) de um OFX deste período não aparece(m) mais neste arquivo (saldo líquido ${formatBRL(sum)}): ` +
        `${gone.slice(0, 5).map((v) => `${v.row.description} (${formatBRL(v.row.amount)} em ${formatDay(v.row.date)})`).join('; ')}. ` +
        'O Recta não apaga nada sozinho: se a compra foi cancelada, apague o lançamento.',
    );
  }
  const advanceProposals = result.proposals.filter((p) => p.kind === 'advance-payment');
  const heldAdvances = advanceProposals.filter((p) => !p.defaultSelected);
  if (heldAdvances.length > 0) {
    const listed = heldAdvances.map((p) => `${formatBRL(lineByRef.get(p.refs[0]!)!.amount)} em ${formatDay(lineByRef.get(p.refs[0]!)!.date)}`).join('; ');
    warnings.push(
      `${heldAdvances.length} pagamento(s) antecipado(s) vieram desmarcados porque sobra na planilha um crédito de valor quase igual (${listed}): se for o mesmo pagamento, resolva a linha da planilha antes; se não, marque-o.`,
    );
  }
  const latestPayment = context.recordedPayments[0];
  const usableSource = latestPayment ? await usableRecordedSource(latestPayment, account.householdId) : null;
  if (result.payment && latestPayment && !usableSource && paymentProposal(result.payment.line, context.recordedPayments) === 'adjust') {
    warnings.push(
      `O pagamento registrado da fatura de ${monthKey(addMonths(month, -1))} saiu de uma conta que não está mais disponível: escolha a conta de origem para o ajuste.`,
    );
  }
  const collapse = result.payment && collapseWarning(context.recordedPayments, monthKey(addMonths(month, -1)));
  if (collapse && paymentProposal(result.payment!.line, context.recordedPayments) === 'adjust') warnings.push(collapse);
  if (context.recordedPayments.length > 1 && result.payment) {
    const sum = context.recordedPayments.reduce((total, p) => total + toCents(p.amount), 0) / 100;
    warnings.push(
      `A fatura de ${monthKey(addMonths(month, -1))} tem ${context.recordedPayments.length} pagamentos registrados (soma ${formatBRL(sum)}); o ajuste os troca por um só, com o valor e a data do OFX.`,
    );
  }
  if (result.monthHasSheet && (creates.length > 0 || result.sheetOnly.length > 0)) {
    const leftoverLines = result.proposals
      .filter((p) => p.kind === 'create' || p.kind === 'reversal')
      .flatMap((p) => p.refs.map((ref) => lineByRef.get(ref)!));
    warnings.push(
      `Sobram ${formatBRL(netCents(result.sheetOnly) / 100)} na planilha e ${formatBRL(netCents(leftoverLines) / 100)} no OFX. ` +
        'As compras novas de meses cobertos pela planilha vêm desmarcadas porque a planilha pode agrupar compras de outro jeito: confira antes de importar para não duplicar.',
    );
  }

  const storedInPeriod = storedRows(
    await prisma.transaction.findMany({
      where: {
        householdId: account.householdId,
        accountId: account.id,
        attachmentUrl: null,
        date: { gte: utcDay(period.start), lte: utcDay(period.end) },
      },
      select: CARD_ROW_SELECT,
    }),
  );
  const closing = computeClosing({
    period,
    endInclusive: statement.lines.some((l) => l.kind !== 'payment' && l.date === period.end),
    ofxTotalCents,
    lines: statement.lines,
    result,
    stored: storedInPeriod,
  });

  return {
    accountId: account.id,
    householdId: account.householdId,
    month,
    monthKey: monthKey(month),
    monthSource,
    period,
    ofxTotal: ofxTotalCents / 100,
    lines,
    proposals,
    sheetOnly: result.sheetOnly.map(toTransactionRef),
    payment: paymentDto(result, context.recordedPayments, month, usableSource, context.paymentBeforeSheet),
    closing,
    categoryMap: await buildCardCategoryMap(account.householdId, createLines),
    totals: {
      lines: lines.length,
      reconciled: lines.filter((l) => l.status === 'reconciled').length,
      proposals: proposals.length,
      create: creates.length,
      sheetOnly: result.sheetOnly.length,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Confirm: validation
// ---------------------------------------------------------------------------

/** 'YYYY-MM' -> month. @throws BadRequestError on anything else. */
export function parseMonthKey(key: string): MaxFinMonth {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key);
  if (!match) throw new BadRequestError(`Invalid monthKey "${key}" (expected YYYY-MM)`);
  return { year: Number(match[1]), month: Number(match[2]) };
}

/**
 * The client echoes the preview's lines; everything about a line is derived from its fitid, date, signed amount
 * and memo, so derive it again and reject what does not match (a client bug or a tampered request), before any
 * write. Identical lines must carry the refs the parser numbers them with.
 */
export function validateConfirmLines(lines: CardOfxConfirmLine[]): CardOfxStatementLine[] {
  const byContent = new Map<string, { refs: string[]; line: CardOfxConfirmLine }>();
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.ref)) throw new BadRequestError(`Duplicate ref in lines: ${l.ref}`);
    seen.add(l.ref);
    try {
      parseLocalDateString(l.date);
    } catch {
      throw new BadRequestError(`Line ${l.ref}: invalid date "${l.date}"`);
    }
    const signed = l.type === 'EXPENSE' ? -l.amount : l.amount;
    const kind = classifyCardOfxLine(l.memo, signed);
    const installment = installmentFromMemo(l.memo);
    const consistent =
      toCents(l.amount) > 0 &&
      kind === l.kind &&
      cardOfxLineType(kind) === l.type &&
      merchantFromMemo(l.memo) === l.merchant &&
      (installment === null
        ? l.installment === null
        : l.installment !== null && l.installment.number === installment.number && l.installment.total === installment.total);
    if (!consistent) throw new BadRequestError(`Line ${l.ref} does not match its memo, amount and type`);
    const key = cardOfxContentKey(l.fitid, l.memo, signed, l.date);
    const entry = byContent.get(key) ?? { refs: [], line: l };
    entry.refs.push(l.ref);
    byContent.set(key, entry);
  }
  for (const { refs, line } of byContent.values()) {
    const signed = line.type === 'EXPENSE' ? -line.amount : line.amount;
    const expected = refs.map((_, i) => cardOfxRef(line.fitid, line.memo, signed, line.date, i + 1)).sort();
    const sent = [...refs].sort();
    if (expected.some((ref, i) => ref !== sent[i])) {
      throw new BadRequestError(`Line ${refs[0]} does not carry the ref of its content`);
    }
  }
  return lines.map((l) => ({
    ref: l.ref,
    fitid: l.fitid,
    date: l.date,
    amount: toCents(l.amount) / 100,
    type: l.type,
    kind: l.kind,
    memo: l.memo,
    merchant: l.merchant,
    installment: l.installment ? { number: l.installment.number, total: l.installment.total } : null,
  }));
}

/** Group ids the client selected; each must be a group id whose refs all came in the lines. */
export function parseSelectedGroups(groups: string[], lineRefs: ReadonlySet<string>): string[] {
  const unique = Array.from(new Set(groups));
  for (const group of unique) {
    const parsed = parseGroupId(group);
    if (!parsed) throw new BadRequestError(`Malformed group id: ${group.slice(0, 200)}`);
    const missing = parsed.refs.find((ref) => !lineRefs.has(ref));
    if (missing) throw new BadRequestError(`Group ${group.slice(0, 200)} covers ${missing}, which is not in lines`);
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Confirm: writes
// ---------------------------------------------------------------------------

type PaymentPlan =
  | { kind: 'none' }
  | { kind: 'create'; line: CardOfxStatementLine; sourceAccountId: string }
  | { kind: 'adjust'; line: CardOfxStatementLine; sourceAccountId: string; recorded: RecordedPayment[]; description: string };

/** Decide (and validate, before any write) what the confirm does with the previous invoice's payment. */
async function planPayment(
  input: CardOfxConfirmRequest['payment'],
  result: ReconcileResult,
  recorded: RecordedPayment[],
  householdId: string,
  invoiceMonth: MaxFinMonth,
  beforeSheet: boolean,
): Promise<PaymentPlan> {
  if (!input?.apply || !result.payment || beforeSheet) return { kind: 'none' };
  const { line } = result.payment;
  const proposal = paymentProposal(line, recorded);
  if (proposal === 'ok') return { kind: 'none' };
  if (proposal === 'create') {
    const source = await requestedSource(input.sourceAccountId, householdId, 'no payment is recorded for that invoice');
    return { kind: 'create', line, sourceAccountId: source };
  }
  // Adjust: undo and pay again from the account of the recorded payment, or from the request's when it has none
  // (or it is no longer usable).
  const latest = recorded[0]!;
  const source =
    (await usableRecordedSource(latest, householdId)) ??
    (await requestedSource(input.sourceAccountId, householdId, 'the recorded payment has no usable source account'));
  return { kind: 'adjust', line, sourceAccountId: source, recorded, description: latest.description || paymentDescription(invoiceMonth) };
}

/** The recorded payment's account when it can still pay an invoice (active, of the household, not a card). */
async function usableRecordedSource(payment: RecordedPayment, householdId: string): Promise<string | null> {
  if (!payment.accountId) return null;
  return (await payingAccount(payment.accountId, householdId)) === 'ok' ? payment.accountId : null;
}

/** The request's payment.sourceAccountId, validated. @throws BadRequestError (400) when missing or unusable. */
async function requestedSource(sourceAccountId: string | undefined, householdId: string, why: string): Promise<string> {
  if (!sourceAccountId) throw new BadRequestError(`payment.sourceAccountId is required: ${why}.`);
  const status = await payingAccount(sourceAccountId, householdId);
  if (status === 'missing') throw new BadRequestError('payment.sourceAccountId: account not found or inactive in this household.');
  if (status === 'credit') throw new BadRequestError('payment.sourceAccountId: an invoice cannot be paid from a credit card.');
  return sourceAccountId;
}

/**
 * A write lost a race and wrote nothing: P2002, another confirm recorded a ref first; P2003 (the refs' foreign key) or
 * P2025, the target was deleted after the recompute.
 */
export function isAlreadyTakenOrGone(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return isUniqueViolation(error) || code === 'P2003' || code === 'P2025';
}

/** The transaction service's NotFoundError (404) or Prisma's P2025: the row to update is gone. */
export function isNotFound(error: unknown): boolean {
  const { code, statusCode } = (error ?? {}) as { code?: unknown; statusCode?: unknown };
  return code === 'NOT_FOUND' || code === 'P2025' || statusCode === 404;
}

/** Record the refs and rewrite the target in one database transaction; false when that lost a race (nothing written). */
async function claimAndUpdate(
  householdId: string,
  proposal: ReconcileProposal,
  data: { date: Date; description: string; notes: string | null },
): Promise<boolean> {
  const target = proposal.target!;
  try {
    await prisma.$transaction([
      prisma.transactionExternalRef.createMany({
        data: proposal.refs.map((ref) => ({ householdId, transactionId: target.id, ref })),
      }),
      prisma.transaction.update({ where: { id: target.id }, data }),
    ]);
    return true;
  } catch (error) {
    if (isAlreadyTakenOrGone(error)) return false;
    throw error;
  }
}

/**
 * Merge: the first sheet row stays as the bank line (amount, date, description), the other rows are deleted and their
 * detail is in the notes. One database transaction records the refs (the line's, and the sourceRef of every absorbed
 * row, so a re-imported workbook does not bring them back), rewrites the kept row and deletes the others. The sum of
 * the rows equals the bank amount and all of them are paid, so the card balance does not move and the transaction
 * service's balance bookkeeping is not needed. False when that lost a race or the stored rows changed (nothing written).
 */
async function applyMerge(householdId: string, cardId: string, proposal: ReconcileProposal, amount: number): Promise<boolean> {
  const target = proposal.target!;
  const absorbed = proposal.absorbed;
  const rows = [target, ...absorbed];
  if (rows.some((row) => row.type !== 'EXPENSE' || !row.paid) || rows.reduce((total, row) => total + toCents(row.amount), 0) !== toCents(amount)) {
    return false;
  }
  const data = { ...targetData(proposal), amount };
  const absorbedRefs = absorbed.map((row) => row.sourceRef).filter((ref): ref is string => !!ref);
  try {
    await prisma.$transaction(async (tx) => {
      // Shares or settlements that appeared since the preview: refuse (rollback), checked under the row locks.
      await lockRowsOrThrowIfLinked(tx, rows.map((row) => row.id));
      // Same rows, same amounts, still paid expenses on this card: otherwise nothing is written (rollback).
      const kept = await tx.transaction.updateMany({
        where: { id: target.id, householdId, accountId: cardId, type: TransactionType.EXPENSE, paid: true, amount: target.amount },
        data,
      });
      if (kept.count !== 1) throw new MergeConflict();
      await tx.transactionExternalRef.createMany({
        data: [...proposal.refs, ...absorbedRefs].map((ref) => ({ householdId, transactionId: target.id, ref })),
      });
      const removed = await tx.transaction.deleteMany({
        where: {
          householdId,
          accountId: cardId,
          OR: absorbed.map((row) => ({ id: row.id, type: TransactionType.EXPENSE, paid: true, amount: row.amount })),
        },
      });
      if (removed.count !== absorbed.length) throw new MergeConflict();
    });
    return true;
  } catch (error) {
    if (error instanceof MergeConflict || error instanceof LinkedRowError || isAlreadyTakenOrGone(error)) return false;
    throw error;
  }
}

/** A row has shares or a settlement: it must be neither merged nor deleted by the import tools. */
export class LinkedRowError extends Error {
  constructor() {
    super('The row has shares or a settlement');
  }
}

/**
 * Lock the rows (FOR UPDATE: a share or settlement being created for one waits for this transaction) and count what
 * hangs on them. Run inside the transaction that deletes them, so the check and the delete cannot be split by a
 * concurrent share.
 * @throws LinkedRowError when any of the rows has a share or a settlement.
 */
export async function lockRowsOrThrowIfLinked(tx: Prisma.TransactionClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT id FROM transactions WHERE id IN (${Prisma.join(ids)}) FOR UPDATE`;
  const [shares, settlements] = await Promise.all([
    tx.transactionShare.count({ where: { transactionId: { in: ids } } }),
    tx.settlement.count({ where: { transactionId: { in: ids } } }),
  ]);
  if (shares + settlements > 0) throw new LinkedRowError();
}

class MergeConflict extends Error {
  constructor() {
    super('The rows of the merge changed meanwhile');
  }
}

function targetData(proposal: ReconcileProposal) {
  const result = proposal.result!;
  return {
    date: parseLocalDateString(result.date),
    description: result.description.slice(0, MAX_DESCRIPTION),
    notes: joinNotes(proposal.target!.notes, result.notesAppend),
  };
}

/**
 * Enrich with the strongest claim, for the kinds that can reach rows of another month or that sum several lines
 * (neighbour, group): in one database transaction the row is locked (FOR UPDATE), must still have no external ref at all
 * (a concurrent confirm that linked it first wins), and is rewritten only if it still has the state the recompute saw.
 * False when any of that fails: nothing is written.
 */
async function applyEnrichClaimed(householdId: string, cardId: string, proposal: ReconcileProposal): Promise<boolean> {
  const target = proposal.target!;
  const data = targetData(proposal);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM transactions WHERE id = ${target.id}::uuid FOR UPDATE`;
      if ((await tx.transactionExternalRef.count({ where: { transactionId: target.id } })) > 0) throw new MergeConflict();
      const claimed = await tx.transaction.updateMany({
        where: {
          id: target.id,
          householdId,
          accountId: cardId,
          type: target.type,
          paid: target.paid,
          amount: target.amount,
          sourceRef: target.sourceRef,
        },
        data,
      });
      if (claimed.count !== 1) throw new MergeConflict();
      await tx.transactionExternalRef.createMany({
        data: proposal.refs.map((ref) => ({ householdId, transactionId: target.id, ref })),
      });
    });
    return true;
  } catch (error) {
    if (error instanceof MergeConflict || isAlreadyTakenOrGone(error)) return false;
    throw error;
  }
}

/**
 * Near amount: the sheet row adopts the BANK amount (a few cents of difference), so the card balance and limit must
 * move by exactly that difference: the update goes through the transaction service, whose transaction claims and
 * locks the row, adjusts the balance, recalculates the card limit — and, through the hook, requires that the row has
 * no external ref yet, is still the row the recompute saw, and records the line's ref in the same transaction.
 */
async function applyNear(householdId: string, cardId: string, proposal: ReconcileProposal, bankAmount: number): Promise<boolean> {
  const target = proposal.target!;
  const data = targetData(proposal);
  try {
    await updateTransaction(
      target.id,
      householdId,
      { amount: bankAmount, description: data.description, date: data.date, notes: data.notes },
      {
        beforeWrite: async (tx) => {
          const same = await tx.transaction.count({
            where: {
              id: target.id,
              householdId,
              accountId: cardId,
              type: target.type,
              paid: target.paid,
              amount: target.amount,
              sourceRef: target.sourceRef,
            },
          });
          if (same !== 1) throw new MergeConflict();
          if ((await tx.transactionExternalRef.count({ where: { transactionId: target.id } })) > 0) throw new MergeConflict();
          await tx.transactionExternalRef.createMany({
            data: proposal.refs.map((ref) => ({ householdId, transactionId: target.id, ref })),
          });
        },
      },
    );
    return true;
  } catch (error) {
    if (error instanceof MergeConflict || isAlreadyTakenOrGone(error) || isNotFound(error) || (error as { statusCode?: number })?.statusCode === 409) return false;
    throw error;
  }
}

/** Enrich a sheet row (exact, plan or sum). */
async function applyEnrich(householdId: string, proposal: ReconcileProposal): Promise<boolean> {
  return claimAndUpdate(householdId, proposal, targetData(proposal));
}

/**
 * The real line replaces a stored future installment (a placeholder the importer generated): its date, memo, amount
 * and paid flag (true) go to the future.
 */
async function applyConsumeFuture(householdId: string, proposal: ReconcileProposal, amount: number): Promise<boolean> {
  const data = targetData(proposal);
  const target = proposal.target!;
  if (target.paid && toCents(target.amount) === toCents(amount)) return claimAndUpdate(householdId, proposal, data);
  // A new amount or the paid flag moves the card balance: claim the refs, then go through the transaction service.
  try {
    await prisma.transactionExternalRef.createMany({
      data: proposal.refs.map((ref) => ({ householdId, transactionId: target.id, ref })),
    });
  } catch (error) {
    if (isAlreadyTakenOrGone(error)) return false;
    throw error;
  }
  try {
    await updateTransaction(target.id, householdId, { ...data, amount, paid: true });
  } catch (error) {
    await prisma.transactionExternalRef.deleteMany({ where: { householdId, transactionId: target.id, ref: { in: proposal.refs } } });
    // The row was deleted after the claim, or changed under another request (409): nothing consumed, like a lost race.
    if (isNotFound(error) || (error as { statusCode?: number })?.statusCode === 409) return false;
    throw error;
  }
  return true;
}

/** Category of an advance payment credit (the same the sheet gives its "Pagamento recebido" rows). */
const ADVANCE_PAYMENT_CATEGORY = 'OTHER_INCOME';

interface CreateContext {
  householdId: string;
  card: ResolvedCardAccount;
  month: MaxFinMonth;
  userId?: string;
  categories: LineCategories;
  lineByRef: ReadonlyMap<string, CardOfxStatementLine>;
  lineOrder: ReadonlyMap<string, number>;
}

/**
 * Create one card transaction per line of the proposal (purchase = EXPENSE, credits = INCOME), recording each ref.
 * A line whose ref is already used elsewhere is left alone (the transaction just created is removed again).
 * Returns how many were created.
 */
async function createLines(ctx: CreateContext, refs: string[], fixedCategory?: string): Promise<number> {
  let created = 0;
  const ordered = [...refs].sort((a, b) => ctx.lineOrder.get(a)! - ctx.lineOrder.get(b)!);
  for (const ref of ordered) {
    const line = ctx.lineByRef.get(ref)!;
    const installment = line.kind === 'purchase' ? line.installment : null;
    let transactionId: string;
    try {
      const transaction = await createTransaction(
        {
          householdId: ctx.householdId,
          accountId: ctx.card.id,
          type: line.type === 'INCOME' ? TransactionType.INCOME : TransactionType.EXPENSE,
          categoryName: fixedCategory ?? ctx.categories.categoryNameFor(line),
          amount: line.amount,
          description: line.memo.slice(0, MAX_DESCRIPTION),
          date: parseLocalDateString(line.date),
          paid: true,
          isSplit: false,
          sourceRef: line.ref,
          ...(installment
            ? { installmentId: ofxPlanId(line.fitid), installmentNumber: installment.number, totalInstallments: installment.total }
            : {}),
        },
        ctx.userId,
      );
      transactionId = transaction.id;
    } catch (error) {
      // The sourceRef is unique per household: a concurrent confirm created this line first.
      if (isUniqueViolation(error)) continue;
      throw error;
    }
    try {
      await prisma.transactionExternalRef.create({ data: { householdId: ctx.householdId, transactionId, ref: line.ref } });
      created += 1;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // The ref was reconciled with another transaction meanwhile: this one would be a duplicate.
      await deleteTransaction(transactionId, ctx.householdId);
    }
  }
  return created;
}

/**
 * Record the refs of lines that matched a transaction the generic importer stored. A repeated ref is skipped, and
 * when one of those transactions was deleted meanwhile (its foreign key fails the whole statement) the others are
 * recorded one by one: this runs after the groups were applied and must not fail the confirm.
 */
async function recordLegacyRefs(householdId: string, items: Array<{ transactionId: string; ref: string }>): Promise<void> {
  if (items.length === 0) return;
  try {
    await prisma.transactionExternalRef.createMany({
      data: items.map((item) => ({ householdId, ...item })),
      skipDuplicates: true,
    });
  } catch (error) {
    if (!isAlreadyTakenOrGone(error)) throw error;
    for (const item of items) {
      try {
        await prisma.transactionExternalRef.create({ data: { householdId, ...item } });
      } catch (itemError) {
        if (!isAlreadyTakenOrGone(itemError)) throw itemError;
      }
    }
  }
}

/** Future installments of a new purchase, one per following month, like the monthly sheet's (`<ref>:f<i>`). */
async function createFutureInstallments(ctx: CreateContext, proposal: ReconcileProposal): Promise<number> {
  if (proposal.futureNumbers.length === 0 || !proposal.futureBaseRef) return 0;
  const base = ctx.lineByRef.get(proposal.futureBaseRef)!;
  const { number: last, total } = base.installment!;
  let created = 0;
  for (const n of proposal.futureNumbers) {
    const offset = n - last;
    try {
      await createTransaction(
        {
          householdId: ctx.householdId,
          accountId: ctx.card.id,
          type: TransactionType.EXPENSE,
          categoryName: ctx.categories.categoryNameFor(base),
          amount: base.amount,
          description: futureInstallmentMemo(base.memo, n, total).slice(0, MAX_DESCRIPTION),
          date: firstDayOfMonth(addMonths(ctx.month, offset)),
          notes: `parcela futura gerada na importação do OFX da fatura ${monthKey(ctx.month)}`,
          paid: true,
          isSplit: false,
          sourceRef: `${base.ref}:f${offset}`,
          installmentId: ofxPlanId(base.fitid),
          installmentNumber: n,
          totalInstallments: total,
        },
        ctx.userId,
      );
      created += 1;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return created;
}

/** Card purchases marked paid around the previous invoice, before its payment is undone (see applyPayment). */
async function paidPurchasesUpTo(householdId: string, cardId: string, invoiceMonth: MaxFinMonth, until: Date): Promise<string[]> {
  const end = parseLocalDateString(storedDateString(until));
  end.setHours(23, 59, 59, 999);
  const rows = await prisma.transaction.findMany({
    where: {
      householdId,
      accountId: cardId,
      paid: true,
      attachmentUrl: null,
      date: { gte: firstDayOfMonth(addMonths(invoiceMonth, -1)), lte: end },
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Mark paid again the purchases an undo marked unpaid (and that were paid before it). */
async function restorePaidFlags(householdId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.transaction.updateMany({ where: { id: { in: ids }, householdId, paid: false }, data: { paid: true } });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function applyPayment(
  plan: PaymentPlan,
  householdId: string,
  card: ResolvedCardAccount,
  invoiceMonth: MaxFinMonth,
  warnings: string[],
): Promise<CardOfxConfirmResponse['payment']> {
  if (plan.kind === 'none') return null;
  const month = monthKey(invoiceMonth);
  const payWith = (input: { sourceAccountId: string; amount: number; description: string; paymentDate: Date }) =>
    payCreditCardInvoice({ householdId, accountId: card.id, month, ...input });
  const paymentDate = parseLocalDateString(plan.line.date);
  const pay = (sourceAccountId: string, description: string) =>
    payWith({ sourceAccountId, amount: plan.line.amount, description, paymentDate });

  if (plan.kind === 'create') {
    const result = await pay(plan.sourceAccountId, paymentDescription(invoiceMonth));
    return { action: 'created', transactionId: result.paymentTransaction.id, amount: plan.line.amount, date: plan.line.date };
  }

  // Undoing a payment marks unpaid every card purchase from the invoice start to the payment date, and paying again
  // only marks paid the purchases of the invoice period: restore the flags of the ones that were paid before.
  const latestDate = plan.recorded.reduce((latest, p) => (p.date > latest ? p.date : latest), plan.recorded[0]!.date);
  const paidBefore = await paidPurchasesUpTo(householdId, card.id, invoiceMonth, latestDate);
  const undone: RecordedPayment[] = [];
  let result: Awaited<ReturnType<typeof pay>>;
  try {
    for (const recorded of plan.recorded) {
      await undoCreditCardPayment({ accountId: card.id, transactionId: recorded.id }, householdId);
      undone.push(recorded);
    }
    result = await pay(plan.sourceAccountId, plan.description);
  } catch (error) {
    // All or nothing: put back the payments already undone, with their own amount, date and account.
    try {
      for (const recorded of undone) {
        await payWith({
          sourceAccountId: recorded.accountId ?? plan.sourceAccountId,
          amount: recorded.amount,
          description: recorded.description || paymentDescription(invoiceMonth),
          paymentDate: parseLocalDateString(storedDateString(recorded.date)),
        });
      }
      await restorePaidFlags(householdId, paidBefore);
    } catch (restoreError) {
      throw new Error(
        `${errorText(error)}; and the recorded payment of the ${month} invoice could not be put back (${errorText(restoreError)}): check it`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    await restorePaidFlags(householdId, paidBefore);
  } catch (flagError) {
    warnings.push(
      `Pagamento da fatura de ${month} ajustado, mas não foi possível marcar como pagas as compras que já estavam (${errorText(flagError)}).`,
    );
  }
  return { action: 'adjusted', transactionId: result.paymentTransaction.id, amount: plan.line.amount, date: plan.line.date };
}

export interface ConfirmCardOfxParams {
  request: CardOfxConfirmRequest;
  /** Resolved (and authorized) by the route. */
  account: ResolvedCardAccount;
  userId?: string;
}

export async function confirmCardOfxImport(params: ConfirmCardOfxParams): Promise<CardOfxConfirmResponse> {
  const { request, account, userId } = params;
  const { householdId } = account;

  // Everything the client sends is checked before the first write.
  const month = parseMonthKey(request.monthKey);
  const invoiceMonth = addMonths(month, -1);
  const lines = validateConfirmLines(request.lines);
  const lineByRef = new Map(lines.map((l) => [l.ref, l]));
  const selected = new Set(parseSelectedGroups(request.selectedGroups, new Set(lineByRef.keys())));

  // Recompute on what is stored now; apply only the selected groups that still exist.
  const context = await loadCardContext(account, month, lines);
  const result = reconcileCardOfx(context.input);
  const toApply = result.proposals.filter((p) => selected.has(p.group));
  let skipped = selected.size - toApply.length;

  const warnings: string[] = [];
  const paymentPlan = await planPayment(request.payment, result, context.recordedPayments, householdId, invoiceMonth, context.paymentBeforeSheet);
  if (paymentPlan.kind === 'adjust') {
    const collapse = collapseWarning(paymentPlan.recorded, monthKey(invoiceMonth));
    if (collapse) warnings.push(collapse);
  }

  const importedLines = toApply
    .filter((p) => p.kind === 'create' || p.kind === 'reversal')
    .flatMap((p) => p.refs.map((ref) => lineByRef.get(ref)!));
  const categories = await resolveLineCategories(householdId, request.categoryMap, importedLines);
  const createContext: CreateContext = {
    householdId,
    card: account,
    month,
    userId,
    categories,
    lineByRef,
    lineOrder: new Map(lines.map((l, i) => [l.ref, i])),
  };

  let enriched = 0;
  let absorbedRows = 0;
  let consumedFutures = 0;
  let created = 0;
  let futureInstallments = 0;
  let reversalsImported = 0;
  let advancePayments = 0;
  for (const proposal of toApply) {
    switch (proposal.kind) {
      case 'enrich-exact':
      case 'enrich-plan':
      case 'enrich-sum':
        if (await applyEnrich(householdId, proposal)) enriched += 1;
        else skipped += 1;
        break;
      case 'enrich-near':
        if (await applyNear(householdId, account.id, proposal, lineByRef.get(proposal.refs[0]!)!.amount)) enriched += 1;
        else skipped += 1;
        break;
      case 'enrich-neighbour':
      case 'enrich-group':
        if (await applyEnrichClaimed(householdId, account.id, proposal)) enriched += 1;
        else skipped += 1;
        break;
      case 'enrich-merge':
        if (await applyMerge(householdId, account.id, proposal, lineByRef.get(proposal.refs[0]!)!.amount)) {
          enriched += 1;
          absorbedRows += proposal.absorbed.length;
        } else skipped += 1;
        break;
      case 'consume-future':
        if (await applyConsumeFuture(householdId, proposal, lineByRef.get(proposal.refs[0]!)!.amount)) consumedFutures += 1;
        else skipped += 1;
        break;
      case 'create': {
        // The future installments go first: once the line exists its group is gone, so a failure after it would
        // lose them for good, while a failure before it leaves the group to be retried (stored numbers are skipped).
        futureInstallments += await createFutureInstallments(createContext, proposal);
        const count = await createLines(createContext, proposal.refs);
        if (count === 0) skipped += 1;
        else created += count;
        break;
      }
      case 'reversal': {
        const count = await createLines(createContext, proposal.refs);
        if (count > 0) reversalsImported += count;
        else skipped += 1;
        break;
      }
      case 'advance-payment': {
        // A credit on the card on the bank's day: the debt drops, no bank account moves (the source is unknown).
        const count = await createLines(createContext, proposal.refs, ADVANCE_PAYMENT_CATEGORY);
        if (count > 0) advancePayments += count;
        else skipped += 1;
        break;
      }
    }
  }

  // Lines the generic importer already stored: record their refs so the next preview finds them by ref.
  const legacy = result.lines
    .map((state, i) => ({ state, line: lines[i]! }))
    .filter(({ state }) => state.reconciledBy === 'legacy' && state.transactionId);
  await recordLegacyRefs(
    householdId,
    legacy.map(({ state, line }) => ({ transactionId: state.transactionId!, ref: line.ref })),
  );

  const payment = await applyPayment(paymentPlan, householdId, account, invoiceMonth, warnings);

  return {
    enriched,
    absorbedRows,
    consumedFutures,
    created,
    futureInstallments,
    reversalsImported,
    advancePayments,
    payment,
    skipped,
    createdCategories: categories.created,
    warnings,
  };
}
