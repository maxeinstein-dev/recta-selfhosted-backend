import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { effectiveClosingDay } from '../accounts/closing-day.js';
import { BadRequestError, CategoryNameTakenError } from '../../shared/errors/app-error.js';
import {
  AccountType,
  CATEGORY_NAME_DISPLAY,
  CategoryName,
  CategoryType,
  TransactionType,
  getCategoriesByType,
} from '../../shared/enums/index.js';
import { toCustomCategoryName, normalizeCategoryName } from '../../shared/utils/categoryHelpers.js';
import { bufferToGrid, type Grid } from '../../shared/csv/grid.js';
import { DEFAULT_WORKBOOK_LIMITS, readWorkbookSheets, type WorkbookSheet } from '../../shared/xlsx/workbook.js';
import { createCategory } from '../categories/categories.service.js';
import {
  detectYearFromName,
  findMaxFinHeaderIndex,
  monthLabel,
  parseMaxFinGrid,
  sheetNameFromCsvFilename,
} from './parsers/maxfin.parser.js';
import { MAXFIN_SECTION_KEYS, MAXFIN_SECTION_LABELS } from './parsers/maxfin.types.js';
import type { MaxFinInstallment, MaxFinMonth, MaxFinParseOptions, MaxFinSectionKey } from './parsers/maxfin.types.js';
import {
  addMonths,
  buildCategoryMap,
  buildFutureInstallments,
  coveredInstallmentNumbers,
  invoiceNetAmount,
  invoicePaymentDate,
  invoiceTechnicalId,
  isClosedMonth,
  isFutureDraftRef,
  legacyKey,
  mergeCategoryMaps,
  missingFutureNumbers,
  monthKey,
  normalizeLabel,
  parseLocalDateString,
  storedDateString,
  toLocalDateString,
  type CategoryMapEntry,
  type CategorySuggestion,
  type CustomCategoryRef,
} from './maxfin-import.helpers.js';
import type {
  MaxFinAccountsInput,
  MaxFinCategoryMapEntry,
  MaxFinCategoryMapInput,
  MaxFinCategorySuggestion,
  MaxFinConfirmRequest,
  MaxFinConfirmResponse,
  MaxFinConfirmRow,
  MaxFinImportOptions,
  MaxFinInvoicePreview,
  MaxFinPreviewOptionsInput,
  MaxFinPreviewResponse,
  MaxFinPreviewRow,
  MaxFinRowStatus,
  MaxFinSectionPreview,
  MaxFinWorkbookOptionsInput,
  MaxFinWorkbookPreviewResponse,
  MaxFinWorkbookSheet,
} from './maxfin-import.types.js';
import { createTransaction, deleteTransaction, payCreditCardInvoice, updateTransaction } from './transactions.service.js';
import { addMonthsClamped, localDate } from '../recurring-transactions/recurring-dates.js';
import { followLastAmountInTx } from '../recurring-transactions/recurring-follow.js';
import {
  eligibleForRecurring,
  loadRecurringMatcher,
  recurringMatchDetail,
  type RecurringMatch,
} from './maxfin-recurring.js';

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

export interface ResolvedAccount {
  id: string;
  name: string;
  type: AccountType;
  householdId: string;
  dueDay: number | null;
  closingDay: number | null;
}

export interface MaxFinAccountsResolved {
  householdId: string;
  income: ResolvedAccount;
  bills: ResolvedAccount;
  credit: ResolvedAccount;
  debit: ResolvedAccount;
}

/** Throws when the caller may not write to the household (the routes pass requireEditor). */
export type AuthorizeHousehold = (householdId: string) => Promise<unknown>;

/**
 * Load the four destination accounts and make sure they are active and all belong to the
 * same household. `authorize` runs for every household involved BEFORE a mixed selection is
 * reported, so a caller outside one of them gets a 403 instead of learning which accounts exist.
 */
export async function resolveMaxFinAccounts(
  accounts: MaxFinAccountsInput,
  authorize?: AuthorizeHousehold,
): Promise<MaxFinAccountsResolved> {
  const ids = Array.from(new Set(MAXFIN_SECTION_KEYS.map((k) => accounts[k])));
  const found = await prisma.account.findMany({
    where: { id: { in: ids }, isActive: true },
    select: { id: true, name: true, type: true, householdId: true, dueDay: true, closingDay: true },
  });
  if (found.length !== ids.length) {
    throw new BadRequestError('One or more destination accounts were not found or are inactive');
  }
  const households = Array.from(new Set(found.map((a) => a.householdId)));
  if (authorize) {
    for (const householdId of households) await authorize(householdId);
  }
  if (households.length !== 1) {
    throw new BadRequestError('All destination accounts must belong to the same household');
  }
  const byId = new Map(found.map((a) => [a.id, a]));
  const pick = (id: string): ResolvedAccount => {
    const a = byId.get(id)!;
    return {
      id: a.id,
      name: a.name,
      type: a.type as AccountType,
      householdId: a.householdId,
      dueDay: a.dueDay ?? null,
      closingDay: effectiveClosingDay(a),
    };
  };
  return {
    householdId: households[0]!,
    income: pick(accounts.income),
    bills: pick(accounts.bills),
    credit: pick(accounts.credit),
    debit: pick(accounts.debit),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Effective options: explicit values win, otherwise derive from whether the month is closed. */
export function resolveImportOptions(
  month: MaxFinMonth | null,
  input: MaxFinPreviewOptionsInput | undefined,
  today: Date = new Date(),
): MaxFinImportOptions {
  const closedMonth = input?.closedMonth ?? (month ? isClosedMonth(month, today) : false);
  return {
    closedMonth,
    payInvoice: input?.payInvoice ?? closedMonth,
    generateFutureInstallments: input?.generateFutureInstallments ?? !closedMonth,
  };
}

export interface ExistingBySourceRef {
  id: string;
  amount: number;
  paid: boolean;
  /** Stored type. Amounts are absolute, so a sheet value whose sign flipped shows up here (EXPENSE <-> INCOME). */
  type: string;
}

/** A generated future installment that a sheet row supersedes. */
export interface FuturePlaceholder {
  id: string;
  installmentNumber: number;
}

/** How a type reads in its block: a debit or credit is the opposite of what the block holds (a negative value). */
function typeLabel(type: string, section: MaxFinSectionKey): string {
  if (type === 'INCOME') return section === 'income' ? 'receita' : 'crédito';
  if (type === 'EXPENSE') return section === 'income' ? 'débito' : 'despesa';
  return type.toLowerCase();
}

/**
 * Classify a parsed row against what is already stored.
 * Order: same sourceRef (duplicate/changed) > generated future installments of the same plan
 * (replaces-future) > identical manual transaction without sourceRef (legacy-duplicate) > a recurrence that
 * already covers the month (matches-recurring) > new.
 * A stored row is a duplicate only with the same type, amount and paid flag: amounts are absolute, so a sheet
 * value whose sign flipped (an expense turned refund) is a change of type.
 */
export function classifyRow(
  row: { amount: number; paid: boolean; type: 'INCOME' | 'EXPENSE'; section: MaxFinSectionKey },
  existing: ExistingBySourceRef | undefined,
  placeholders: FuturePlaceholder[],
  legacyMatchId: string | undefined,
  recurringMatch?: RecurringMatch,
): { status: MaxFinRowStatus; statusDetail: string | null; existingTransactionId: string | null } {
  if (existing) {
    const sameType = existing.type === row.type;
    const sameAmount = Math.abs(existing.amount - row.amount) < 0.005;
    const samePaid = existing.paid === row.paid;
    if (sameType && sameAmount && samePaid) {
      return { status: 'duplicate', statusDetail: null, existingTransactionId: existing.id };
    }
    const parts: string[] = [];
    if (!sameType) parts.push(`tipo ${typeLabel(existing.type, row.section)} → ${typeLabel(row.type, row.section)}`);
    if (!sameAmount) parts.push(`valor ${existing.amount.toFixed(2)} → ${row.amount.toFixed(2)}`);
    if (!samePaid) parts.push(`pago ${existing.paid ? 'sim' : 'não'} → ${row.paid ? 'sim' : 'não'}`);
    return { status: 'changed', statusDetail: parts.join('; '), existingTransactionId: existing.id };
  }
  if (placeholders.length > 0) {
    const numbers = placeholders.map((p) => p.installmentNumber).sort((a, b) => a - b);
    return {
      status: 'replaces-future',
      statusDetail: `substitui a(s) parcela(s) futura(s) ${numbers.join(', ')} gerada(s) em importação anterior`,
      existingTransactionId: placeholders[0]!.id,
    };
  }
  if (legacyMatchId) {
    return {
      status: 'legacy-duplicate',
      statusDetail: 'lançamento igual já existe (importado sem identificador de origem)',
      existingTransactionId: legacyMatchId,
    };
  }
  if (recurringMatch) {
    return {
      status: 'matches-recurring',
      statusDetail: recurringMatchDetail(recurringMatch),
      existingTransactionId: recurringMatch.transactionId,
    };
  }
  return { status: 'new', statusDetail: null, existingTransactionId: null };
}

export function suggestionToDto(s: CategorySuggestion): MaxFinCategorySuggestion {
  switch (s.kind) {
    case 'system':
      return { kind: 'system', categoryName: s.categoryName, label: `${CATEGORY_NAME_DISPLAY[s.categoryName]} (sistema)` };
    case 'custom':
      return { kind: 'custom', categoryId: s.categoryId, categoryName: s.categoryName, name: s.name, label: `${s.name} (categoria existente)` };
    case 'create':
      return { kind: 'create', name: s.name, label: `${s.name} (nova categoria)` };
    case 'default':
    default:
      return { kind: 'default', categoryName: s.categoryName, label: `${CATEGORY_NAME_DISPLAY[s.categoryName]} (padrão)` };
  }
}

function defaultCategoryFor(type: 'INCOME' | 'EXPENSE'): CategoryName {
  return type === 'INCOME' ? CategoryName.OTHER_INCOME : CategoryName.OTHER_EXPENSES;
}

/** Postgres unique violation surfaced by Prisma (duck-typed so it survives mocks and client upgrades). */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

const MAX_INSTALLMENTS = 99;

/**
 * The client may only echo what the preview derived: validate the installment shape and recompute
 * `futureCount` instead of trusting it (it drives how many transactions confirm creates).
 */
export function sanitizeInstallment(installment: MaxFinInstallment | null, sourceRef: string): MaxFinInstallment | null {
  if (!installment) return null;
  const { number, total, prepaid } = installment;
  const ok =
    Number.isInteger(number) &&
    Number.isInteger(total) &&
    Number.isInteger(prepaid) &&
    number >= 1 &&
    total <= MAX_INSTALLMENTS &&
    prepaid >= 0 &&
    number + prepaid <= total &&
    new RegExp(`^maxfin:[a-z0-9-]*:${total}$`).test(installment.installmentId);
  if (!ok) throw new BadRequestError(`Row ${sourceRef}: invalid installment ${number}/${total} +${prepaid}`);
  return { ...installment, futureCount: total - (number + prepaid) };
}

/**
 * Validate and normalise the rows of a confirm request. Everything here is derived by the preview,
 * so anything inconsistent is a client bug or a tampered request and is rejected before any write.
 */
export function validateConfirmRows(rows: MaxFinConfirmRow[], month: MaxFinMonth): MaxFinConfirmRow[] {
  if (rows.length === 0) throw new BadRequestError('No rows to import');
  const key = monthKey(month);
  const prefix = `maxfin:${key}:`;
  const seen = new Set<string>();
  return rows.map((row) => {
    if (!row.sourceRef.startsWith(prefix)) {
      throw new BadRequestError(`Row ${row.sourceRef} does not belong to month ${key}`);
    }
    // Only refs the parser emits: `maxfin:<month>:<block>:<line>`. A client must not mint `:f<N>` refs
    // (generated installments) nor claim another block than the row's own.
    const blockPrefix = `${prefix}${row.section}:`;
    if (!row.sourceRef.startsWith(blockPrefix) || !/^\d+$/.test(row.sourceRef.slice(blockPrefix.length))) {
      throw new BadRequestError(`Row ${row.sourceRef} does not match its block ${row.section}`);
    }
    if (seen.has(row.sourceRef)) {
      throw new BadRequestError(`Duplicate sourceRef in rows: ${row.sourceRef}`);
    }
    seen.add(row.sourceRef);
    // The type is not tied to the block: a negative value in the sheet is a credit (INCOME) in an expense
    // block and a debit (EXPENSE) in the income block, on the same account.
    if (!row.date.startsWith(`${key}-`)) {
      throw new BadRequestError(`Row ${row.sourceRef}: date ${row.date} is outside ${key}`);
    }
    try {
      parseLocalDateString(row.date);
    } catch (error) {
      throw new BadRequestError(error instanceof Error ? error.message : `Invalid date "${row.date}"`);
    }
    return { ...row, installment: sanitizeInstallment(row.installment, row.sourceRef) };
  });
}

/**
 * Sheet rows the card OFX import merged into another transaction (it records each deleted row's sourceRef in
 * transaction_external_refs): `absorbed` maps that ref to the transaction that absorbed it, `targets` holds the
 * transactions that absorbed rows. A sheet row is already represented there, so a new import must not bring it back,
 * and the target (whose amount no longer equals its sheet row) is neither "changed" nor replaceable.
 */
async function loadMergeLinks(
  householdId: string,
  refs: string[],
  existingIds: string[],
): Promise<{ absorbed: Map<string, string>; targets: Set<string> }> {
  const absorbed = new Map<string, string>();
  const targets = new Set<string>();
  if (refs.length === 0) return { absorbed, targets };
  const rows = await prisma.transactionExternalRef.findMany({
    where: {
      householdId,
      OR: [
        { ref: { in: [...refs, ...refs.map((ref) => `deleted:${ref}`)] } },
        { transactionId: { in: existingIds }, ref: { startsWith: 'maxfin:' } },
        { transactionId: { in: existingIds }, ref: { startsWith: 'ofx:' } },
      ],
    },
    select: { ref: true, transactionId: true },
  });
  for (const r of rows) {
    if (r.ref.startsWith('deleted:maxfin:')) {
      // Tombstone of a sheet row the card review deleted: already handled, nothing absorbed it.
      absorbed.set(r.ref.slice('deleted:'.length), r.transactionId);
    } else if (r.ref.startsWith('maxfin:')) {
      targets.add(r.transactionId);
      absorbed.set(r.ref, r.transactionId);
    } else if (r.ref.startsWith('ofx:')) {
      // Reconciled with the card statement (its amount may now be the bank's): neither "changed" nor replaceable.
      targets.add(r.transactionId);
    }
  }
  return { absorbed, targets };
}

// ---------------------------------------------------------------------------
// Stored installment plans
// ---------------------------------------------------------------------------

interface PlanRow {
  id: string;
  installmentId: string | null;
  installmentNumber: number | null;
  sourceRef: string | null;
}

async function loadPlanRows(householdId: string, creditAccountId: string, planIds: string[]): Promise<PlanRow[]> {
  if (planIds.length === 0) return [];
  return prisma.transaction.findMany({
    where: { householdId, accountId: creditAccountId, installmentId: { in: planIds } },
    select: { id: true, installmentId: true, installmentNumber: true, sourceRef: true },
  });
}

/** Ids (of `ids`) that a card statement import already reconciled: they carry an `ofx:` external ref. */
async function loadOfxLinkedIds(householdId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await prisma.transactionExternalRef.findMany({
    where: { householdId, transactionId: { in: ids }, ref: { startsWith: 'ofx:' } },
    select: { transactionId: true },
  });
  return new Set(rows.map((r) => r.transactionId));
}

function indexPlanRows(
  planRows: PlanRow[],
  consumedIds: ReadonlySet<string> = new Set(),
): {
  numbersByPlan: Map<string, Set<number>>;
  placeholdersByPlan: Map<string, Map<number, FuturePlaceholder>>;
  /** Generated futures a card statement already consumed (real installments now): never placeholders. */
  consumedByPlan: Map<string, Map<number, string>>;
} {
  const numbersByPlan = new Map<string, Set<number>>();
  const placeholdersByPlan = new Map<string, Map<number, FuturePlaceholder>>();
  const consumedByPlan = new Map<string, Map<number, string>>();
  for (const t of planRows) {
    if (!t.installmentId || t.installmentNumber == null) continue;
    const numbers = numbersByPlan.get(t.installmentId) ?? new Set<number>();
    numbers.add(t.installmentNumber);
    numbersByPlan.set(t.installmentId, numbers);
    if (isFutureDraftRef(t.sourceRef)) {
      if (consumedIds.has(t.id)) {
        const consumed = consumedByPlan.get(t.installmentId) ?? new Map<number, string>();
        consumed.set(t.installmentNumber, t.id);
        consumedByPlan.set(t.installmentId, consumed);
        continue;
      }
      const placeholders = placeholdersByPlan.get(t.installmentId) ?? new Map<number, FuturePlaceholder>();
      placeholders.set(t.installmentNumber, { id: t.id, installmentNumber: t.installmentNumber });
      placeholdersByPlan.set(t.installmentId, placeholders);
    }
  }
  return { numbersByPlan, placeholdersByPlan, consumedByPlan };
}

/** The consumed future (if any) a sheet installment row stands for: the row is then already imported. */
function consumedCovering(installment: MaxFinInstallment, consumedByPlan: Map<string, Map<number, string>>): string | null {
  const own = consumedByPlan.get(installment.installmentId);
  if (!own) return null;
  for (const n of coveredInstallmentNumbers(installment)) {
    const id = own.get(n);
    if (id) return id;
  }
  return null;
}

function placeholdersCovering(
  installment: MaxFinInstallment,
  placeholdersByPlan: Map<string, Map<number, FuturePlaceholder>>,
): FuturePlaceholder[] {
  const own = placeholdersByPlan.get(installment.installmentId);
  if (!own) return [];
  return coveredInstallmentNumbers(installment)
    .map((n) => own.get(n))
    .filter((p): p is FuturePlaceholder => !!p);
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** The household's custom categories, as the category suggestions need them. */
export async function loadCustomCategories(householdId: string): Promise<CustomCategoryRef[]> {
  const customsRaw = await prisma.category.findMany({
    where: { householdId },
    select: { id: true, name: true, type: true },
  });
  return customsRaw.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type as 'INCOME' | 'EXPENSE',
  }));
}

export interface PreviewFromGridParams {
  grid: Grid;
  /** What the parser knows about the sheet's name, to find its month (see MaxFinParseOptions). */
  naming: Pick<MaxFinParseOptions, 'filename' | 'sheetName' | 'fileYear' | 'fallbackYear'>;
  accounts: MaxFinAccountsInput;
  /** Resolved (and authorized) by the caller. */
  resolved: MaxFinAccountsResolved;
  options?: MaxFinPreviewOptionsInput;
  /** The household's custom categories, or a loader that only runs once the sheet proved to have rows. */
  customs: CustomCategoryRef[] | (() => Promise<CustomCategoryRef[]>);
  today?: Date;
}

/**
 * Preview of one monthly sheet already read into a grid, shared by the CSV and the workbook paths: parse,
 * classify every row against what is stored, suggest categories and the invoice payment. Nothing is persisted.
 */
export async function previewFromGrid(params: PreviewFromGridParams): Promise<MaxFinPreviewResponse> {
  const { resolved } = params;
  const { householdId } = resolved;

  const parsed = parseMaxFinGrid(params.grid, {
    ...params.naming,
    ...(params.options?.monthOverride ? { monthOverride: params.options.monthOverride } : {}),
  });

  if (parsed.rows.length === 0) {
    const why = parsed.warnings[0] ? ` (${parsed.warnings[0]})` : '';
    throw new BadRequestError(`No readable rows found in the sheet${why}.`);
  }

  const warnings = [...parsed.warnings];
  const month = parsed.month;
  const options = resolveImportOptions(month, params.options, params.today);
  const key = month ? monthKey(month) : null;

  // Category suggestions.
  const customs = Array.isArray(params.customs) ? params.customs : await params.customs();
  const categoryMap: MaxFinCategoryMapEntry[] = buildCategoryMap(parsed.rows, customs).map(
    (e: CategoryMapEntry) => ({
      key: e.key,
      type: e.type,
      count: e.count,
      sections: e.sections,
      suggestion: suggestionToDto(e.suggestion),
    }),
  );

  // Existing rows by sourceRef (exact dedup).
  const refs = parsed.rows.map((r) => r.sourceRef);
  const existingRows = await prisma.transaction.findMany({
    where: { householdId, sourceRef: { in: refs } },
    select: { id: true, sourceRef: true, amount: true, paid: true, type: true },
  });
  const existingByRef = new Map<string, ExistingBySourceRef>(
    existingRows
      .filter((t) => t.sourceRef)
      .map((t) => [t.sourceRef as string, { id: t.id, amount: t.amount.toNumber(), paid: t.paid, type: String(t.type) }]),
  );

  // Rows the card OFX import merged into another transaction (and the row that absorbed them) count as already
  // imported, whatever their amounts now are.
  const links = await loadMergeLinks(householdId, refs, existingRows.map((t) => t.id));
  const rowByRef = new Map(parsed.rows.map((r) => [r.sourceRef, r]));
  let mergedCount = 0;
  const protectedRows: string[] = [];
  for (const [ref, transactionId] of links.absorbed) {
    const row = rowByRef.get(ref);
    if (row && !existingByRef.has(ref)) {
      existingByRef.set(ref, { id: transactionId, amount: row.amount, paid: row.paid, type: row.type });
      mergedCount += 1;
      protectedRows.push(row.description);
    }
  }
  for (const [ref, existing] of existingByRef) {
    const row = rowByRef.get(ref);
    if (row && links.targets.has(existing.id) && (existing.amount !== row.amount || existing.type !== row.type || existing.paid !== row.paid)) {
      existingByRef.set(ref, { id: existing.id, amount: row.amount, paid: row.paid, type: row.type });
      mergedCount += 1;
      protectedRows.push(row.description);
    }
  }

  // Installment plans already stored on the card (generated placeholders and real rows).
  const planIds = Array.from(
    new Set(
      parsed.rows
        .filter((r) => r.section === 'credit' && r.installment)
        .map((r) => r.installment!.installmentId),
    ),
  );
  const planRows = await loadPlanRows(householdId, resolved.credit.id, planIds);
  const consumedIds = await loadOfxLinkedIds(
    householdId,
    planRows.filter((t) => isFutureDraftRef(t.sourceRef)).map((t) => t.id),
  );
  const { numbersByPlan, placeholdersByPlan, consumedByPlan } = indexPlanRows(planRows, consumedIds);

  // Legacy duplicates: same account/day/amount/description without a sourceRef.
  const accountIds = Array.from(new Set(MAXFIN_SECTION_KEYS.map((k) => resolved[k].id)));
  const legacyByKey = new Map<string, string>();
  const times = parsed.rows.map((r) => r.date.getTime());
  if (times.length > 0) {
    const start = new Date(Math.min(...times));
    start.setHours(0, 0, 0, 0);
    const end = new Date(Math.max(...times));
    end.setHours(23, 59, 59, 999);
    const legacy = await prisma.transaction.findMany({
      where: { householdId, accountId: { in: accountIds }, sourceRef: null, date: { gte: start, lte: end } },
      select: { id: true, accountId: true, date: true, amount: true, description: true, type: true },
    });
    for (const t of legacy) {
      if (!t.accountId) continue;
      // Stored @db.Date values come back as UTC midnight; parsed rows are local midnight.
      const key = legacyKey(t.accountId, storedDateString(t.date), t.amount.toNumber(), t.description ?? '', String(t.type));
      legacyByKey.set(key, t.id);
    }
  }

  // Recurrences that already cover the month (the sheet takes them over); a match serves one row.
  const recurringMatcher = key
    ? await loadRecurringMatcher(householdId, accountIds, key, params.today)
    : { take: (_accountId: string, _description: string): RecurringMatch | undefined => undefined };

  const rows: MaxFinPreviewRow[] = parsed.rows.map((r) => {
    const accountId = resolved[r.section].id;
    const paid = options.closedMonth ? true : r.paid;
    const planInstallment = r.section === 'credit' ? r.installment : null;
    // A generated future a card statement already consumed IS this installment now: the row is already imported.
    const consumedId = !existingByRef.has(r.sourceRef) && planInstallment ? consumedCovering(planInstallment, consumedByPlan) : null;
    if (consumedId) {
      mergedCount += 1;
      protectedRows.push(r.description);
    }
    const existing = consumedId ? { id: consumedId, amount: r.amount, paid, type: r.type } : existingByRef.get(r.sourceRef);
    const placeholders = planInstallment ? placeholdersCovering(planInstallment, placeholdersByPlan) : [];
    const legacyMatchId = legacyByKey.get(legacyKey(accountId, toLocalDateString(r.date), r.amount, r.description, r.type));
    // Only a row that would otherwise be new may take a recurrence's occurrence.
    const recurringMatch =
      !existing && placeholders.length === 0 && !legacyMatchId && eligibleForRecurring(r)
        ? recurringMatcher.take(accountId, r.description)
        : undefined;
    const cls = classifyRow(
      { amount: r.amount, paid, type: r.type, section: r.section },
      existing,
      placeholders,
      legacyMatchId,
      recurringMatch,
    );
    const futureInstallments =
      planInstallment && options.generateFutureInstallments && !options.closedMonth && cls.status !== 'duplicate'
        ? missingFutureNumbers(planInstallment, numbersByPlan.get(planInstallment.installmentId) ?? new Set()).length
        : 0;
    return {
      sourceLine: r.sourceLine,
      sourceRef: r.sourceRef,
      section: r.section,
      accountId,
      type: r.type,
      description: r.description,
      categoryKey: r.categoryKey,
      amount: r.amount,
      planned: r.planned,
      realized: r.realized,
      paid,
      date: toLocalDateString(r.date),
      notes: r.notes,
      flag: r.flag,
      installment: r.installment,
      futureInstallments,
      shareHint: r.shareHint,
      ...cls,
      existingAmount: cls.status === 'matches-recurring' && recurringMatch ? recurringMatch.amount : null,
    };
  });

  if (mergedCount > 0) {
    const listed = protectedRows.slice(0, 8).join('; ') + (protectedRows.length > 8 ? '; …' : '');
    warnings.push(
      `${mergedCount} linha(s) da planilha já foram conciliadas com o OFX (inclusive parcelas futuras que o OFX tornou reais), mescladas em outro lançamento ou removidas por uma importação/revisão de OFX e são tratadas como já importadas, mesmo que o valor da planilha tenha mudado: ${listed}. Para trocar uma delas, apague-a à mão no Recta e reimporte a planilha.`,
    );
  }

  const sections: MaxFinSectionPreview[] = parsed.sections.map((s) => {
    const own = rows.filter((r) => r.section === s.key);
    return {
      key: s.key,
      label: s.label || MAXFIN_SECTION_LABELS[s.key],
      accountId: resolved[s.key].id,
      count: s.count,
      sum: s.sum,
      sheetTotalPlanned: s.sheetTotalPlanned,
      sheetTotalRealized: s.sheetTotalRealized,
      newCount: own.filter((r) => r.status === 'new' || r.status === 'replaces-future').length,
      duplicateCount: own.filter((r) => r.status === 'duplicate' || r.status === 'legacy-duplicate').length,
      changedCount: own.filter((r) => r.status === 'changed').length,
      recurringCount: own.filter((r) => r.status === 'matches-recurring').length,
    };
  });

  // Account warnings and the invoice payment preview.
  const billsCannotPay = resolved.bills.type === AccountType.CREDIT || resolved.bills.id === resolved.credit.id;
  let invoice: MaxFinInvoicePreview | null = null;
  if (resolved.credit.type !== AccountType.CREDIT) {
    warnings.push(`A conta escolhida para o cartão ("${resolved.credit.name}") não é um cartão de crédito; o pagamento de fatura não será registrado.`);
  } else {
    if (!resolved.credit.closingDay) {
      warnings.push(`O cartão "${resolved.credit.name}" não tem dia de fechamento nem de vencimento configurado; as faturas seguem o mês calendário.`);
    } else if (resolved.credit.closingDay === 1) {
      warnings.push(`O cartão "${resolved.credit.name}" fecha no dia 1: as linhas datadas no dia 01 entram na fatura do mês seguinte.`);
    }
    if (billsCannotPay) {
      warnings.push('A conta de contas fixas é um cartão de crédito (ou o próprio cartão); o pagamento de fatura não será registrado.');
    }
  }
  if (month && resolved.credit.type === AccountType.CREDIT) {
    const creditRows = rows.filter(
      (r) =>
        r.section === 'credit' &&
        (r.status === 'new' || r.status === 'changed' || r.status === 'replaces-future' || r.status === 'matches-recurring'),
    );
    // Purchases minus credits (refunds): the invoice pays the net.
    const amount = invoiceNetAmount(creditRows);
    if (options.closedMonth && options.payInvoice && creditRows.length > 0 && amount <= 0) {
      warnings.push(
        `Os créditos do cartão cobrem as compras de ${key} (saldo líquido ${amount.toFixed(2)}): o pagamento da fatura não será registrado.`,
      );
    }
    // The payment of a month is recorded once: say so in the preview instead of promising a second one.
    const alreadyPaid = !!(await prisma.transaction.findFirst({
      where: { householdId, attachmentUrl: invoiceTechnicalId(resolved.credit.id, month) },
      select: { id: true },
    }));
    invoice = {
      creditAccountId: resolved.credit.id,
      sourceAccountId: resolved.bills.id,
      month: key!,
      paymentDate: toLocalDateString(invoicePaymentDate(month, resolved.credit.dueDay)),
      amount,
      dueDay: resolved.credit.dueDay,
      closingDay: resolved.credit.closingDay,
      alreadyPaid,
      willPay: options.closedMonth && options.payInvoice && amount > 0 && !billsCannotPay && !alreadyPaid,
    };
  }

  const totals = {
    rows: rows.length,
    new: rows.filter((r) => r.status === 'new' || r.status === 'replaces-future').length,
    duplicate: rows.filter((r) => r.status === 'duplicate').length,
    changed: rows.filter((r) => r.status === 'changed').length,
    legacyDuplicate: rows.filter((r) => r.status === 'legacy-duplicate').length,
    matchesRecurring: rows.filter((r) => r.status === 'matches-recurring').length,
    skipped: parsed.skipped.length,
  };

  return {
    month,
    monthKey: key,
    monthSource: parsed.monthSource,
    householdId,
    accounts: params.accounts,
    options,
    sections,
    rows,
    skipped: parsed.skipped,
    categoryMap,
    invoice,
    warnings,
    totals,
  };
}

export interface BuildPreviewParams {
  filename: string;
  buffer: Buffer;
  accounts: MaxFinAccountsInput;
  /** Already resolved and authorized by the route; resolved here when omitted. */
  resolved?: MaxFinAccountsResolved;
  options?: MaxFinPreviewOptionsInput;
  today?: Date;
}

/** Preview of one monthly tab uploaded as CSV. */
export async function buildMaxFinPreview(params: BuildPreviewParams): Promise<MaxFinPreviewResponse> {
  const resolved = params.resolved ?? (await resolveMaxFinAccounts(params.accounts));
  const { grid } = bufferToGrid(params.buffer);
  // Google's download of one tab is named "<workbook> - <tab>.csv": the tab name wins over a stale title.
  const sheetName = sheetNameFromCsvFilename(params.filename);
  return previewFromGrid({
    grid,
    naming: { filename: params.filename, ...(sheetName ? { sheetName } : {}) },
    accounts: params.accounts,
    resolved,
    options: params.options,
    customs: () => loadCustomCategories(resolved.householdId),
    today: params.today,
  });
}

// ---------------------------------------------------------------------------
// Workbook preview
// ---------------------------------------------------------------------------

const SKIP_NO_HEADER = 'sem cabeçalho "Descrição"';
const SKIP_NO_MONTH = 'mês não identificado';
const SKIP_NO_ROWS = 'sem linhas para importar';
/**
 * Rows one workbook preview returns across its selected months. The user's ten months of 2026 hold about 850;
 * 60 full tabs would answer with tens of megabytes of JSON.
 */
export const MAX_WORKBOOK_PREVIEW_ROWS = 6_000;

/** A tab of the workbook after the scan. */
interface WorkbookTab {
  sheet: WorkbookSheet;
  /** What the parser gets to find the tab's month (the same in the scan and in the preview). */
  naming: Pick<MaxFinParseOptions, 'sheetName' | 'fileYear' | 'fallbackYear'>;
  monthKey: string | null;
  rowCount: number;
  /** Why the tab is skipped; null for a month tab. */
  reason: string | null;
}

/**
 * Month and status of every tab, in tab order. The month follows the parser's rule (tab name, then title), and
 * so does its year (see MaxFinParseOptions.sheetName), with the 4-digit year of the uploaded file name as the
 * file-name year and the single year the titled tabs share as the last resort. The file name never gives a
 * month: a workbook named after one month would pour that month into every tab. The first tab of a month wins.
 */
function scanWorkbookTabs(sheets: WorkbookSheet[], filename: string): WorkbookTab[] {
  const hasHeader = sheets.map((sheet) => findMaxFinHeaderIndex(sheet.grid) >= 0);
  const titleYears = new Set<number>();
  sheets.forEach((sheet, index) => {
    if (!hasHeader[index]) return;
    const titled = parseMaxFinGrid(sheet.grid);
    if (titled.monthSource === 'title' && titled.month) titleYears.add(titled.month.year);
  });
  const sharedTitleYear = titleYears.size === 1 ? [...titleYears][0] : undefined;
  const fileYear = detectYearFromName(filename);

  const firstTabOfMonth = new Map<string, string>();
  return sheets.map((sheet, index) => {
    const naming = {
      sheetName: sheet.name,
      ...(fileYear !== null ? { fileYear } : {}),
      ...(sharedTitleYear !== undefined ? { fallbackYear: sharedTitleYear } : {}),
    };
    const parsed = parseMaxFinGrid(sheet.grid, naming);
    const key = parsed.month ? monthKey(parsed.month) : null;
    let reason: string | null = null;
    if (!hasHeader[index]) reason = SKIP_NO_HEADER;
    else if (key === null) reason = SKIP_NO_MONTH;
    else if (parsed.rows.length === 0) reason = SKIP_NO_ROWS;
    else if (firstTabOfMonth.has(key)) reason = `mês repetido (vale a aba "${firstTabOfMonth.get(key)}")`;
    else firstTabOfMonth.set(key, sheet.name);
    return { sheet, naming, monthKey: key, rowCount: reason === null ? parsed.rows.length : 0, reason };
  });
}

/** `requested` when given (each must be a month tab), otherwise every month tab up to the current month; oldest first. */
function selectMonths(
  requested: string[] | undefined,
  monthTabs: ReadonlyMap<string, WorkbookTab>,
  currentMonthKey: string,
): string[] {
  const available = [...monthTabs.keys()].sort();
  if (requested === undefined) return available.filter((key) => key <= currentMonthKey);
  const selected = [...new Set(requested)].sort();
  const unknown = selected.filter((key) => !monthTabs.has(key));
  if (unknown.length > 0) {
    throw new BadRequestError(
      `Not a month tab of this workbook: ${unknown.join(', ')} (available: ${available.join(', ')}).`,
    );
  }
  return selected;
}

export interface BuildWorkbookPreviewParams {
  filename: string;
  buffer: Buffer;
  accounts: MaxFinAccountsInput;
  /** Already resolved and authorized by the route; resolved here when omitted. */
  resolved?: MaxFinAccountsResolved;
  options?: MaxFinWorkbookOptionsInput;
  today?: Date;
}

/**
 * Preview of a whole MaxFin workbook (.xlsx). Every tab is read and classified (selected, available, or skipped
 * with a reason); every selected month becomes the same preview its CSV export would give, with its own options:
 * closed up to `closedThrough`, the invoice payment as asked, and future installments only from the latest month.
 * Nothing is persisted; the client confirms month by month.
 */
export async function buildMaxFinWorkbookPreview(
  params: BuildWorkbookPreviewParams,
): Promise<MaxFinWorkbookPreviewResponse> {
  const resolved = params.resolved ?? (await resolveMaxFinAccounts(params.accounts));
  const today = params.today ?? new Date();
  const input = params.options ?? {};

  const tabs = scanWorkbookTabs(await readWorkbookSheets(params.buffer), params.filename);
  const monthTabs = new Map<string, WorkbookTab>();
  for (const tab of tabs) {
    if (tab.reason === null && tab.monthKey !== null) monthTabs.set(tab.monthKey, tab);
  }
  if (monthTabs.size === 0) {
    const reasons = tabs.slice(0, 10).map((tab) => `${tab.sheet.name}: ${tab.reason}`);
    throw new BadRequestError(`No month tab found in the workbook (${reasons.join('; ') || 'it has no sheets'}).`);
  }

  const currentMonth: MaxFinMonth = { year: today.getFullYear(), month: today.getMonth() + 1 };
  const selected = selectMonths(input.months, monthTabs, monthKey(currentMonth));
  const rowsOf = (keys: readonly string[]) => keys.reduce((sum, key) => sum + (monthTabs.get(key)?.rowCount ?? 0), 0);
  const selectionWarnings: string[] = [];
  if (input.months === undefined && rowsOf(selected) > MAX_WORKBOOK_PREVIEW_ROWS) {
    // The default selection leaves its oldest months out until it fits, so the user still gets the month picker.
    const leftOut: string[] = [];
    while (selected.length > 1 && rowsOf(selected) > MAX_WORKBOOK_PREVIEW_ROWS) leftOut.push(selected.shift()!);
    const labels = leftOut.map((key) => monthLabel({ year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) }));
    selectionWarnings.push(
      `Os meses mais antigos ficaram desmarcados (${labels.join(', ')}): com eles a seleção passava de ` +
        `${MAX_WORKBOOK_PREVIEW_ROWS.toLocaleString('pt-BR')} linhas. Importe estes meses e depois marque os outros.`,
    );
  }
  const selectedRows = rowsOf(selected);
  if (selectedRows > MAX_WORKBOOK_PREVIEW_ROWS) {
    throw new BadRequestError(
      `The selected months hold ${selectedRows.toLocaleString('en-US')} rows, more than one preview returns ` +
        `(${MAX_WORKBOOK_PREVIEW_ROWS.toLocaleString('en-US')}); select fewer months.`,
    );
  }
  const closedThrough =
    input.closedThrough === undefined ? monthKey(addMonths(currentMonth, -1)) : input.closedThrough;
  const payInvoice = input.payInvoice ?? true;
  const generateFutureInstallments = input.generateFutureInstallments ?? true;
  const latest = selected[selected.length - 1];

  // One query for the whole workbook, none when no month is selected.
  const customs = selected.length > 0 ? await loadCustomCategories(resolved.householdId) : [];
  const months: MaxFinPreviewResponse[] = [];
  for (const key of selected) {
    const tab = monthTabs.get(key)!;
    const closedMonth = closedThrough !== null && key <= closedThrough;
    months.push(
      await previewFromGrid({
        grid: tab.sheet.grid,
        naming: tab.naming,
        accounts: params.accounts,
        resolved,
        options: {
          closedMonth,
          payInvoice,
          // Only the latest month generates the installments still to come, and only while it is open.
          generateFutureInstallments: key === latest && !closedMonth ? generateFutureInstallments : false,
        },
        customs,
        today,
      }),
    );
  }

  const isSelected = new Set(selected);
  const { maxRows, maxColumns } = DEFAULT_WORKBOOK_LIMITS;
  return {
    filename: params.filename,
    householdId: resolved.householdId,
    accounts: params.accounts,
    options: { months: selected, closedThrough, payInvoice, generateFutureInstallments },
    sheets: tabs.map(
      (tab): MaxFinWorkbookSheet => ({
        name: tab.sheet.name,
        monthKey: tab.monthKey,
        status: tab.reason !== null ? 'skipped' : isSelected.has(tab.monthKey ?? '') ? 'selected' : 'available',
        reason: tab.reason,
        rowCount: tab.rowCount,
        hidden: tab.sheet.hidden,
      }),
    ),
    months,
    categoryMap: mergeCategoryMaps(months.map((month) => month.categoryMap)),
    warnings: [
      ...selectionWarnings,
      ...tabs
      .filter((tab) => tab.sheet.truncated)
      .map(
        (tab) =>
          `A aba "${tab.sheet.name}" tem valores além de ${maxRows} linhas ou ${maxColumns} colunas; só esse trecho foi lido.`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

export interface ConfirmParams {
  request: MaxFinConfirmRequest;
  userId?: string;
  /** Already resolved and authorized by the route; resolved here when omitted. */
  resolved?: MaxFinAccountsResolved;
}

export interface CategoryResolver {
  categoryNameFor(key: string, type: 'INCOME' | 'EXPENSE'): string;
  created: Array<{ id: string; name: string; type: 'INCOME' | 'EXPENSE' }>;
}

/** Validate the mapping and create the requested custom categories (find-or-create by normalized name + type). */
export async function buildCategoryResolver(householdId: string, entries: MaxFinCategoryMapInput[]): Promise<CategoryResolver> {
  const customsRaw = await prisma.category.findMany({ where: { householdId }, select: { id: true, name: true, type: true } });
  const customs = customsRaw.map((c) => ({ id: c.id, name: c.name, type: c.type as 'INCOME' | 'EXPENSE' }));
  const findCustom = (name: string, type: 'INCOME' | 'EXPENSE') =>
    customs.find((c) => c.type === type && normalizeLabel(c.name) === normalizeLabel(name));

  const resolvedNames = new Map<string, string>(); // `${type}|${normalized key}` -> categoryName
  const created: CategoryResolver['created'] = [];
  const toCreate: Array<{ mapKey: string; name: string; type: 'INCOME' | 'EXPENSE' }> = [];

  // Pass 1: validate every entry. Nothing is written until the whole map is known to be valid.
  for (const entry of entries) {
    const mapKey = `${entry.type}|${normalizeLabel(entry.key)}`;
    const target = entry.target;
    if (target.kind === 'system') {
      const allowed = getCategoriesByType(entry.type as CategoryType) as string[];
      if (!allowed.includes(target.categoryName)) {
        throw new BadRequestError(`Category "${target.categoryName}" is not a ${entry.type} system category`);
      }
      resolvedNames.set(mapKey, target.categoryName);
    } else if (target.kind === 'custom') {
      const custom = customs.find((c) => c.id === target.categoryId);
      if (!custom || custom.type !== entry.type) {
        throw new BadRequestError(`Custom category ${target.categoryId} not found for type ${entry.type}`);
      }
      resolvedNames.set(mapKey, toCustomCategoryName(custom.id));
    } else if (target.kind === 'create') {
      const name = target.name.trim().slice(0, 100);
      if (!name) throw new BadRequestError(`Empty name for new category (key "${entry.key}")`);
      // A name equal to a system category of the type (ignoring case/accents) maps to that system category: creating a
      // custom one would be refused (409) halfway through the map, after other categories were already created.
      const system = (getCategoriesByType(entry.type as CategoryType) as CategoryName[]).find(
        (n) => normalizeCategoryName(CATEGORY_NAME_DISPLAY[n]) === normalizeCategoryName(name),
      );
      if (system) {
        resolvedNames.set(mapKey, system);
      } else {
        toCreate.push({ mapKey, name, type: entry.type });
      }
    } else {
      resolvedNames.set(mapKey, defaultCategoryFor(entry.type));
    }
  }

  // Pass 2: find-or-create the custom categories (a repeated (type, name) is created once).
  for (const { mapKey, name, type } of toCreate) {
    let custom = findCustom(name, type);
    if (!custom) {
      try {
        const createdCat = await createCategory({ householdId, name, type: type as CategoryType });
        custom = { id: createdCat.id, name: createdCat.name, type };
        customs.push(custom);
        created.push({ id: custom.id, name: custom.name, type });
      } catch (error) {
        // Someone created the same name meanwhile: use theirs instead of failing the whole import halfway.
        if (!(error instanceof CategoryNameTakenError)) throw error;
        const fresh = await prisma.category.findMany({ where: { householdId, type: type as CategoryType }, select: { id: true, name: true, type: true } });
        const theirs = fresh.find((c) => normalizeLabel(c.name) === normalizeLabel(name) || normalizeCategoryName(c.name) === normalizeCategoryName(name));
        if (!theirs) throw error;
        custom = { id: theirs.id, name: theirs.name, type };
        customs.push(custom);
      }
    }
    resolvedNames.set(mapKey, toCustomCategoryName(custom.id));
  }

  return {
    created,
    categoryNameFor(key, type) {
      return resolvedNames.get(`${type}|${normalizeLabel(key)}`) ?? defaultCategoryFor(type);
    },
  };
}

function installmentFields(installment: MaxFinInstallment | null) {
  if (!installment) return {};
  return {
    installmentId: installment.installmentId,
    installmentNumber: installment.number,
    totalInstallments: installment.total,
  };
}

async function findFuturePlaceholders(
  householdId: string,
  creditAccountId: string,
  installment: MaxFinInstallment,
): Promise<{ placeholders: FuturePlaceholder[]; consumed: string[] }> {
  const found = await prisma.transaction.findMany({
    where: {
      householdId,
      accountId: creditAccountId,
      installmentId: installment.installmentId,
      installmentNumber: { in: coveredInstallmentNumbers(installment) },
      sourceRef: { contains: ':f' },
    },
    select: { id: true, installmentNumber: true, sourceRef: true },
  });
  const drafts = found.filter((t) => isFutureDraftRef(t.sourceRef) && t.installmentNumber != null);
  // A generated future that a card statement import already consumed is a real installment now: never a placeholder.
  const consumedIds = await loadOfxLinkedIds(
    householdId,
    drafts.map((t) => t.id),
  );
  return {
    placeholders: drafts.filter((t) => !consumedIds.has(t.id)).map((t) => ({ id: t.id, installmentNumber: t.installmentNumber as number })),
    consumed: drafts.filter((t) => consumedIds.has(t.id)).map((t) => t.id),
  };
}

export async function confirmMaxFinImport(params: ConfirmParams): Promise<MaxFinConfirmResponse> {
  const { request, userId } = params;
  const month = request.month;
  const key = monthKey(month);
  const options = request.options;

  // Everything the client sends is checked before the first write.
  const rows = validateConfirmRows(request.rows, month);
  const resolved = params.resolved ?? (await resolveMaxFinAccounts(request.accounts));
  const { householdId } = resolved;
  const warnings: string[] = [];

  const categories = await buildCategoryResolver(householdId, request.categoryMap);

  // Re-check what is already stored at write time (the preview is not trusted).
  const existingRows = await prisma.transaction.findMany({
    where: { householdId, sourceRef: { in: rows.map((r) => r.sourceRef) } },
    select: { id: true, sourceRef: true, recurringTransactionId: true },
  });
  const existingByRef = new Map(existingRows.map((t) => [t.sourceRef as string, t.id]));
  const links = await loadMergeLinks(
    householdId,
    rows.map((r) => r.sourceRef),
    existingRows.map((t) => t.id),
  );
  // A row the sheet already took over keeps its link to the recurrence when it is replaced.
  const recurrenceOfExisting = new Map(
    existingRows.filter((t) => t.recurringTransactionId).map((t) => [t.sourceRef as string, t.recurringTransactionId as string]),
  );

  // Recurrences that already cover the month, loaded only when a row could take one over.
  const takesRecurrence = rows.some(eligibleForRecurring);
  const recurringMatcher = takesRecurrence
    ? await loadRecurringMatcher(
        householdId,
        Array.from(new Set(MAXFIN_SECTION_KEYS.map((k) => resolved[k].id))),
        key,
      )
    : { take: (_accountId: string, _description: string): RecurringMatch | undefined => undefined };

  const ids: string[] = [];
  let imported = 0;
  let skipped = 0;
  let replaced = 0;
  let assumedRecurring = 0;
  let consumedFutureInstallments = 0;
  const importedCreditRows: MaxFinConfirmRow[] = [];
  const importedFutureRows: MaxFinConfirmRow[] = [];

  for (const row of rows) {
    // Merged into another transaction by the card OFX import: never brought back, not even by "replace".
    if (links.absorbed.has(row.sourceRef) && !existingByRef.has(row.sourceRef)) {
      skipped += 1;
      continue;
    }
    const existingId = existingByRef.get(row.sourceRef);
    // The row that absorbed others: replacing it would delete it (cascading its refs) and duplicate the purchase.
    if (existingId && links.targets.has(existingId) && row.replace) {
      skipped += 1;
      warnings.push(`"${row.description}" não foi substituída: ela já foi conciliada com o OFX ou absorveu outras linhas da planilha.`);
      continue;
    }
    const futures =
      row.section === 'credit' && row.installment
        ? await findFuturePlaceholders(householdId, resolved.credit.id, row.installment)
        : { placeholders: [] as FuturePlaceholder[], consumed: [] as string[] };
    const placeholders = futures.placeholders;
    // The installment was already consumed by a card statement import: this row is imported, even with "replace"
    // (deleting the consumed row would cascade its OFX refs and duplicate the purchase).
    if (!existingId && futures.consumed.length > 0) {
      skipped += 1;
      warnings.push(`"${row.description}" não foi importada: a parcela já foi conciliada com o OFX (parcela futura consumida).`);
      continue;
    }

    if (existingId && !row.replace) {
      skipped += 1;
      continue;
    }
    if (!existingId && placeholders.length > 0 && !row.replace) {
      skipped += 1;
      warnings.push(
        `"${row.description}" ignorada: já existem parcelas futuras geradas para este plano (marque "substituir" para trocá-las pela linha da planilha).`,
      );
      continue;
    }

    // The sheet takes over the month's occurrence of a recurrence (same account and description).
    const recurringMatch =
      !existingId && placeholders.length === 0 && eligibleForRecurring(row)
        ? recurringMatcher.take(resolved[row.section].id, row.description)
        : undefined;
    if (recurringMatch) {
      if (!row.replace) {
        skipped += 1;
        warnings.push(
          `"${row.description}" ignorada: uma recorrência já cobre este mês (marque "substituir" para a planilha assumir a conta).`,
        );
        continue;
      }
      // An occurrence already paid stays paid whatever the sheet says: never un-pay a bill the app has settled.
      const paid =
        options.closedMonth || row.section === 'credit' || (recurringMatch.kind === 'generated' && recurringMatch.paid)
          ? true
          : row.paid;
      const date = parseLocalDateString(row.date);
      try {
        const takenId = await assumeRecurrence(recurringMatch, {
          householdId,
          row,
          paid,
          date,
          accountId: resolved[row.section].id,
          userId,
          categories,
        });
        ids.push(takenId);
        assumedRecurring += 1;
        if (row.section === 'credit') importedCreditRows.push(row);
      } catch (error) {
        // A concurrent confirm stored the same sourceRef first: that row exists, skip ours.
        if (!isUniqueViolation(error)) throw error;
        skipped += 1;
      }
      continue;
    }

    // Replacing deletes only what this row supersedes: the stored row with the same sourceRef and/or
    // the generated future installments it covers (same household, same card, same plan).
    if (existingId) {
      await deleteTransaction(existingId, householdId);
      replaced += 1;
    }
    for (const placeholder of placeholders) {
      await deleteTransaction(placeholder.id, householdId);
      consumedFutureInstallments += 1;
    }

    try {
      const created = await createTransaction(
        {
          householdId,
          accountId: resolved[row.section].id,
          type: row.type === 'INCOME' ? TransactionType.INCOME : TransactionType.EXPENSE,
          categoryName: categories.categoryNameFor(row.categoryKey, row.type),
          amount: row.amount,
          description: row.description.slice(0, 255),
          date: parseLocalDateString(row.date),
          ...(row.notes ? { notes: row.notes.slice(0, 1000) } : {}),
          paid: options.closedMonth || row.section === 'credit' ? true : row.paid,
          isSplit: false,
          sourceRef: row.sourceRef,
          ...(recurrenceOfExisting.has(row.sourceRef) ? { recurringTransactionId: recurrenceOfExisting.get(row.sourceRef)! } : {}),
          ...installmentFields(row.installment),
        },
        userId,
      );
      ids.push(created.id);
      if (!existingId) imported += 1;
      if (row.section === 'credit') {
        importedCreditRows.push(row);
        if (row.installment && row.installment.futureCount > 0) importedFutureRows.push(row);
      }
    } catch (error) {
      // A concurrent confirm stored the same sourceRef first (unique per household): that row exists, skip ours.
      if (!isUniqueViolation(error)) throw error;
      skipped += 1;
    }
  }

  // Future installments (open months only), never repeating a number that is already stored.
  let futureInstallments = 0;
  if (options.generateFutureInstallments && !options.closedMonth && importedFutureRows.length > 0) {
    const planIds = Array.from(new Set(importedFutureRows.map((r) => r.installment!.installmentId)));
    const { numbersByPlan } = indexPlanRows(await loadPlanRows(householdId, resolved.credit.id, planIds));
    for (const row of importedFutureRows) {
      const planId = row.installment!.installmentId;
      const numbers = numbersByPlan.get(planId) ?? new Set<number>();
      numbersByPlan.set(planId, numbers);
      for (const draft of buildFutureInstallments(row, month, numbers)) {
        try {
          const created = await createTransaction(
            {
              householdId,
              accountId: resolved.credit.id,
              // A refund paid back in installments (INCOME row) generates INCOME installments.
              type: row.type === 'INCOME' ? TransactionType.INCOME : TransactionType.EXPENSE,
              categoryName: categories.categoryNameFor(draft.categoryKey, row.type),
              amount: draft.amount,
              description: draft.description.slice(0, 255),
              date: draft.date,
              notes: draft.notes.slice(0, 1000),
              paid: true,
              isSplit: false,
              sourceRef: draft.sourceRef,
              installmentId: draft.installmentId,
              installmentNumber: draft.installmentNumber,
              totalInstallments: draft.totalInstallments,
            },
            userId,
          );
          ids.push(created.id);
          numbers.add(draft.installmentNumber);
          futureInstallments += 1;
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
      }
    }
  }

  // Invoice payment for closed months.
  let invoicePayment: MaxFinConfirmResponse['invoicePayment'] = null;
  if (options.closedMonth && options.payInvoice) {
    // Purchases minus credits (refunds) imported in this call.
    const amount = invoiceNetAmount(importedCreditRows);
    if (resolved.credit.type !== AccountType.CREDIT) {
      warnings.push('Pagamento de fatura não registrado: a conta do cartão não é do tipo crédito.');
    } else if (resolved.bills.type === AccountType.CREDIT || resolved.bills.id === resolved.credit.id) {
      warnings.push('Pagamento de fatura não registrado: a conta de contas fixas é um cartão de crédito (ou o próprio cartão).');
    } else if (importedCreditRows.length === 0) {
      warnings.push('Pagamento de fatura não registrado: nenhuma compra de cartão foi importada nesta confirmação.');
    } else if (amount <= 0) {
      warnings.push(
        `Pagamento de fatura não registrado: os créditos do cartão importados nesta confirmação cobrem as compras (saldo líquido ${amount.toFixed(2)}).`,
      );
    } else {
      const technicalIdentifier = invoiceTechnicalId(resolved.credit.id, month);
      const already = await prisma.transaction.findFirst({
        where: { householdId, attachmentUrl: technicalIdentifier },
        select: { id: true },
      });
      if (already) {
        warnings.push(`Pagamento de fatura de ${key} já existia (${already.id}); não foi criado outro.`);
      } else {
        const paymentDate = invoicePaymentDate(month, resolved.credit.dueDay);
        const result = await payCreditCardInvoice({
          householdId,
          accountId: resolved.credit.id,
          sourceAccountId: resolved.bills.id,
          month: key,
          amount,
          description: `Pagamento de fatura - ${String(month.month).padStart(2, '0')}/${month.year} (importação)`,
          paymentDate,
        });
        invoicePayment = {
          transactionId: result.paymentTransaction.id,
          amount,
          date: toLocalDateString(paymentDate),
        };
      }
    }
  }

  return {
    imported,
    skipped,
    replaced,
    assumedRecurring,
    consumedFutureInstallments,
    futureInstallments,
    createdCategories: categories.created,
    invoicePayment,
    ids,
    warnings,
  };
}

interface AssumeContext {
  householdId: string;
  row: MaxFinConfirmRow;
  paid: boolean;
  date: Date;
  accountId: string;
  userId?: string;
  categories: CategoryResolver;
}

/**
 * The sheet row takes over a recurrence's occurrence of the month. With a generated (pending) transaction, that
 * transaction is updated in place through the transactions service (amount, date, paid and sourceRef; the link to
 * the recurrence stays and balances follow the service). With only the recurrence, the row is created linked to it
 * and the recurrence moves on to the month after, so the cron does not duplicate it. The recurrence follows the
 * sheet's real value when it asks to follow the last amount. Returns the id of the transaction that carries the row.
 */
async function assumeRecurrence(match: RecurringMatch, ctx: AssumeContext): Promise<string> {
  const { householdId, row, paid, date, userId, categories } = ctx;
  if (match.kind === 'generated') {
    await updateTransaction(
      match.transactionId,
      householdId,
      {
        amount: row.amount,
        date,
        paid,
        sourceRef: row.sourceRef,
        ...(row.notes ? { notes: row.notes.slice(0, 1000) } : {}),
      },
      {
        inTransaction: async (tx) => {
          await followLastAmountInTx(
            tx,
            { id: match.transactionId, householdId, recurringTransactionId: match.recurringId, date: localDate(match.day), amount: match.amount },
            { amount: row.amount, date },
          );
        },
      },
    );
    return match.transactionId;
  }

  // The occurrence and the recurrence's move commit together: a crash between them would let the cron
  // (or a second confirm) produce the month's charge again.
  const nextRunDay = addMonthsClamped(match.day, 1, Math.max(match.anchorDay, Number(match.day.slice(8, 10))));
  const created = await createTransaction(
    {
      householdId,
      accountId: ctx.accountId,
      type: TransactionType.EXPENSE,
      categoryName: categories.categoryNameFor(row.categoryKey, row.type),
      amount: row.amount,
      description: row.description.slice(0, 255),
      date,
      ...(row.notes ? { notes: row.notes.slice(0, 1000) } : {}),
      paid,
      isSplit: false,
      sourceRef: row.sourceRef,
      recurringTransactionId: match.recurringId,
    },
    userId,
    {
      inTransaction: async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`recurring:${match.recurringId}`}))`;
        await tx.recurringTransaction.update({
          where: { id: match.recurringId },
          data: {
            lastRunDate: date,
            nextRunAt: localDate(nextRunDay),
            ...(match.followLastAmount ? { amount: new Prisma.Decimal(Math.round(row.amount * 100) / 100) } : {}),
            ...(match.endDate && nextRunDay > match.endDate ? { isActive: false } : {}),
          },
        });
      },
    },
  );
  return created.id;
}
