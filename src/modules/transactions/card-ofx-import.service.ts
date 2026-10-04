/**
 * Card invoice OFX importer (phase 3 of the MaxFin importer): preview and confirm.
 *
 * The preview parses the invoice, loads what the card already stores (the month's sheet rows, stored future
 * installments, rows the generic importer stored, refs already recorded) and returns the reconciliation proposals
 * of ofx-reconcile.ts. The confirm never trusts the client's ids: it validates the echoed lines against their own
 * content, recomputes the reconciliation on fresh data and applies only the selected groups that still exist,
 * recording every OFX ref it uses in transaction_external_refs so a re-import shows everything reconciled.
 */
import { prisma } from '../../shared/db/prisma.js';
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
    closingDay: account.closingDay ?? null,
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

const CARD_ROW_SELECT = {
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
  };
}

function storedRows(records: CardRowRecord[]): StoredCardRow[] {
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
}

async function loadCardContext(card: ResolvedCardAccount, month: MaxFinMonth, lines: CardOfxStatementLine[]): Promise<CardContext> {
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
  const candidateIds = [...sheetRows, ...futures, ...legacy].map((row) => row.id);
  const externalRefs = await prisma.transactionExternalRef.findMany({
    where: { householdId, OR: [{ ref: { in: refs } }, { transactionId: { in: candidateIds } }] },
    select: { ref: true, transactionId: true },
  });
  const knownRefs = new Map<string, string>();
  for (const t of createdFromRefs) if (t.sourceRef) knownRefs.set(t.sourceRef, t.id);
  for (const r of externalRefs) knownRefs.set(r.ref, r.transactionId);
  const linkedTransactionIds = new Set(externalRefs.map((r) => r.transactionId));

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
    },
    recordedPayments,
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

function paymentDto(
  result: ReconcileResult,
  recorded: RecordedPayment[],
  month: MaxFinMonth,
  usableSource: string | null,
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
    proposal: paymentProposal(line, recorded),
  };
}

/** An account an invoice can be paid from: active, of the household, not a credit card. */
async function payingAccount(accountId: string, householdId: string): Promise<'ok' | 'missing' | 'credit'> {
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
      `O cartão "${account.name}" não tem dia de fechamento configurado: no Recta as faturas seguem o mês calendário, e a data real de uma compra pode levá-la para outra fatura.`,
    );
  }

  const purchasesAndCredits = statement.lines.filter((l) => l.kind !== 'payment');
  const ofxTotalCents = netCents(purchasesAndCredits);
  if (statement.balance !== null && Math.abs(-toCents(statement.balance) - ofxTotalCents) > BALANCE_WARNING_CENTS) {
    warnings.push(
      `O saldo da fatura no OFX (${formatBRL(-statement.balance)}) difere do total das linhas (${formatBRL(ofxTotalCents / 100)}).`,
    );
  }

  const context = await loadCardContext(account, month, statement.lines);
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

  if (result.payment?.legacyDuplicateId) {
    const { line } = result.payment;
    warnings.push(
      `Já existe no cartão um crédito "${line.memo}" de ${formatBRL(line.amount)} em ${formatDay(line.date)} (importação genérica): com o pagamento da fatura ele conta duas vezes; apague esse lançamento.`,
    );
  }
  for (const advance of result.unpairedAdvances) {
    warnings.push(
      `Pagamento antecipado de ${formatBRL(advance.amount)} em ${formatDay(advance.date)} não será importado: o Recta registra só o pagamento da fatura anterior.`,
    );
  }
  const latestPayment = context.recordedPayments[0];
  const usableSource = latestPayment ? await usableRecordedSource(latestPayment, account.householdId) : null;
  if (result.payment && latestPayment && !usableSource && paymentProposal(result.payment.line, context.recordedPayments) === 'adjust') {
    warnings.push(
      `O pagamento registrado da fatura de ${monthKey(addMonths(month, -1))} saiu de uma conta que não está mais disponível: escolha a conta de origem para o ajuste.`,
    );
  }
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
        'As compras novas vêm desmarcadas porque a planilha pode agrupar compras de outro jeito: confira antes de importar para não duplicar.',
    );
  }

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
    payment: paymentDto(result, context.recordedPayments, month, usableSource),
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
): Promise<PaymentPlan> {
  if (!input?.apply || !result.payment) return { kind: 'none' };
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
function isAlreadyTakenOrGone(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return isUniqueViolation(error) || code === 'P2003' || code === 'P2025';
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

function targetData(proposal: ReconcileProposal) {
  const result = proposal.result!;
  return {
    date: parseLocalDateString(result.date),
    description: result.description.slice(0, MAX_DESCRIPTION),
    notes: joinNotes(proposal.target!.notes, result.notesAppend),
  };
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
    throw error;
  }
  return true;
}

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
async function createLines(ctx: CreateContext, refs: string[]): Promise<number> {
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
          categoryName: ctx.categories.categoryNameFor(line),
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

async function applyPayment(
  plan: PaymentPlan,
  householdId: string,
  card: ResolvedCardAccount,
  invoiceMonth: MaxFinMonth,
): Promise<CardOfxConfirmResponse['payment']> {
  if (plan.kind === 'none') return null;
  const paymentDate = parseLocalDateString(plan.line.date);
  const pay = (sourceAccountId: string, description: string) =>
    payCreditCardInvoice({
      householdId,
      accountId: card.id,
      sourceAccountId,
      month: monthKey(invoiceMonth),
      amount: plan.line.amount,
      description,
      paymentDate,
    });

  if (plan.kind === 'create') {
    const result = await pay(plan.sourceAccountId, paymentDescription(invoiceMonth));
    return { action: 'created', transactionId: result.paymentTransaction.id, amount: plan.line.amount, date: plan.line.date };
  }

  // Undoing a payment marks unpaid every card purchase from the invoice start to the payment date, and paying again
  // only marks paid the purchases of the invoice period: restore the flags of the ones that were paid before.
  const latestDate = plan.recorded.reduce((latest, p) => (p.date > latest ? p.date : latest), plan.recorded[0]!.date);
  const paidBefore = await paidPurchasesUpTo(householdId, card.id, invoiceMonth, latestDate);
  for (const recorded of plan.recorded) {
    await undoCreditCardPayment({ accountId: card.id, transactionId: recorded.id }, householdId);
  }
  const result = await pay(plan.sourceAccountId, plan.description);
  if (paidBefore.length > 0) {
    await prisma.transaction.updateMany({
      where: { id: { in: paidBefore }, householdId, paid: false },
      data: { paid: true },
    });
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
  const paymentPlan = await planPayment(request.payment, result, context.recordedPayments, householdId, invoiceMonth);

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
  let consumedFutures = 0;
  let created = 0;
  let futureInstallments = 0;
  let reversalsImported = 0;
  for (const proposal of toApply) {
    switch (proposal.kind) {
      case 'enrich-exact':
      case 'enrich-plan':
      case 'enrich-sum':
        if (await applyEnrich(householdId, proposal)) enriched += 1;
        else skipped += 1;
        break;
      case 'consume-future':
        if (await applyConsumeFuture(householdId, proposal, lineByRef.get(proposal.refs[0]!)!.amount)) consumedFutures += 1;
        else skipped += 1;
        break;
      case 'create': {
        const count = await createLines(createContext, proposal.refs);
        if (count === 0) {
          skipped += 1;
          break;
        }
        created += count;
        futureInstallments += await createFutureInstallments(createContext, proposal);
        break;
      }
      case 'reversal': {
        const count = await createLines(createContext, proposal.refs);
        if (count > 0) reversalsImported += count;
        else skipped += 1;
        break;
      }
    }
  }

  // Lines the generic importer already stored: record their refs so the next preview finds them by ref.
  const legacy = result.lines
    .map((state, i) => ({ state, line: lines[i]! }))
    .filter(({ state }) => state.reconciledBy === 'legacy' && state.transactionId);
  if (legacy.length > 0) {
    await prisma.transactionExternalRef.createMany({
      data: legacy.map(({ state, line }) => ({ householdId, transactionId: state.transactionId!, ref: line.ref })),
      skipDuplicates: true,
    });
  }

  const payment = await applyPayment(paymentPlan, householdId, account, invoiceMonth);

  return {
    enriched,
    consumedFutures,
    created,
    futureInstallments,
    reversalsImported,
    payment,
    skipped,
    createdCategories: categories.created,
    warnings,
  };
}
