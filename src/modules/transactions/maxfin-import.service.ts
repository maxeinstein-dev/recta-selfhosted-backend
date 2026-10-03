import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError } from '../../shared/errors/app-error.js';
import {
  AccountType,
  CATEGORY_NAME_DISPLAY,
  CategoryName,
  CategoryType,
  TransactionType,
  getCategoriesByType,
} from '../../shared/enums/index.js';
import { toCustomCategoryName } from '../../shared/utils/categoryHelpers.js';
import { bufferToGrid } from '../../shared/csv/grid.js';
import { createCategory } from '../categories/categories.service.js';
import { parseMaxFinGrid } from './parsers/maxfin.parser.js';
import { MAXFIN_SECTION_KEYS, MAXFIN_SECTION_LABELS } from './parsers/maxfin.types.js';
import type { MaxFinInstallment, MaxFinMonth } from './parsers/maxfin.types.js';
import {
  buildCategoryMap,
  buildFutureInstallments,
  coveredInstallmentNumbers,
  invoicePaymentDate,
  invoiceTechnicalId,
  isClosedMonth,
  isFutureDraftRef,
  legacyKey,
  missingFutureNumbers,
  monthKey,
  normalizeLabel,
  parseLocalDateString,
  storedDateString,
  sumAmounts,
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
} from './maxfin-import.types.js';
import { createTransaction, deleteTransaction, payCreditCardInvoice } from './transactions.service.js';

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
      closingDay: a.closingDay ?? null,
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
}

/** A generated future installment that a sheet row supersedes. */
export interface FuturePlaceholder {
  id: string;
  installmentNumber: number;
}

/**
 * Classify a parsed row against what is already stored.
 * Order: same sourceRef (duplicate/changed) > generated future installments of the same plan
 * (replaces-future) > identical manual transaction without sourceRef (legacy-duplicate) > new.
 */
export function classifyRow(
  row: { amount: number; paid: boolean },
  existing: ExistingBySourceRef | undefined,
  placeholders: FuturePlaceholder[],
  legacyMatchId: string | undefined,
): { status: MaxFinRowStatus; statusDetail: string | null; existingTransactionId: string | null } {
  if (existing) {
    const sameAmount = Math.abs(existing.amount - row.amount) < 0.005;
    const samePaid = existing.paid === row.paid;
    if (sameAmount && samePaid) {
      return { status: 'duplicate', statusDetail: null, existingTransactionId: existing.id };
    }
    const parts: string[] = [];
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
    const expectedType = row.section === 'income' ? 'INCOME' : 'EXPENSE';
    if (row.type !== expectedType) {
      throw new BadRequestError(`Row ${row.sourceRef}: type ${row.type} does not match section ${row.section}`);
    }
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

function indexPlanRows(planRows: PlanRow[]): {
  numbersByPlan: Map<string, Set<number>>;
  placeholdersByPlan: Map<string, Map<number, FuturePlaceholder>>;
} {
  const numbersByPlan = new Map<string, Set<number>>();
  const placeholdersByPlan = new Map<string, Map<number, FuturePlaceholder>>();
  for (const t of planRows) {
    if (!t.installmentId || t.installmentNumber == null) continue;
    const numbers = numbersByPlan.get(t.installmentId) ?? new Set<number>();
    numbers.add(t.installmentNumber);
    numbersByPlan.set(t.installmentId, numbers);
    if (isFutureDraftRef(t.sourceRef)) {
      const placeholders = placeholdersByPlan.get(t.installmentId) ?? new Map<number, FuturePlaceholder>();
      placeholders.set(t.installmentNumber, { id: t.id, installmentNumber: t.installmentNumber });
      placeholdersByPlan.set(t.installmentId, placeholders);
    }
  }
  return { numbersByPlan, placeholdersByPlan };
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

export interface BuildPreviewParams {
  filename: string;
  buffer: Buffer;
  accounts: MaxFinAccountsInput;
  /** Already resolved and authorized by the route; resolved here when omitted. */
  resolved?: MaxFinAccountsResolved;
  options?: MaxFinPreviewOptionsInput;
  today?: Date;
}

export async function buildMaxFinPreview(params: BuildPreviewParams): Promise<MaxFinPreviewResponse> {
  const resolved = params.resolved ?? (await resolveMaxFinAccounts(params.accounts));
  const { householdId } = resolved;

  const { grid } = bufferToGrid(params.buffer);
  const parsed = parseMaxFinGrid(grid, {
    filename: params.filename,
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
  const customsRaw = await prisma.category.findMany({
    where: { householdId },
    select: { id: true, name: true, type: true },
  });
  const customs: CustomCategoryRef[] = customsRaw.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type as 'INCOME' | 'EXPENSE',
  }));
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
    select: { id: true, sourceRef: true, amount: true, paid: true },
  });
  const existingByRef = new Map<string, ExistingBySourceRef>(
    existingRows
      .filter((t) => t.sourceRef)
      .map((t) => [t.sourceRef as string, { id: t.id, amount: t.amount.toNumber(), paid: t.paid }]),
  );

  // Installment plans already stored on the card (generated placeholders and real rows).
  const planIds = Array.from(
    new Set(
      parsed.rows
        .filter((r) => r.section === 'credit' && r.installment)
        .map((r) => r.installment!.installmentId),
    ),
  );
  const { numbersByPlan, placeholdersByPlan } = indexPlanRows(
    await loadPlanRows(householdId, resolved.credit.id, planIds),
  );

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
      select: { id: true, accountId: true, date: true, amount: true, description: true },
    });
    for (const t of legacy) {
      if (!t.accountId) continue;
      // Stored @db.Date values come back as UTC midnight; parsed rows are local midnight.
      legacyByKey.set(legacyKey(t.accountId, storedDateString(t.date), t.amount.toNumber(), t.description ?? ''), t.id);
    }
  }

  const rows: MaxFinPreviewRow[] = parsed.rows.map((r) => {
    const accountId = resolved[r.section].id;
    const paid = options.closedMonth ? true : r.paid;
    const planInstallment = r.section === 'credit' ? r.installment : null;
    const cls = classifyRow(
      { amount: r.amount, paid },
      existingByRef.get(r.sourceRef),
      planInstallment ? placeholdersCovering(planInstallment, placeholdersByPlan) : [],
      legacyByKey.get(legacyKey(accountId, toLocalDateString(r.date), r.amount, r.description)),
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
    };
  });

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
    };
  });

  // Account warnings and the invoice payment preview.
  const billsCannotPay = resolved.bills.type === AccountType.CREDIT || resolved.bills.id === resolved.credit.id;
  let invoice: MaxFinInvoicePreview | null = null;
  if (resolved.credit.type !== AccountType.CREDIT) {
    warnings.push(`A conta escolhida para o cartão ("${resolved.credit.name}") não é um cartão de crédito; o pagamento de fatura não será registrado.`);
  } else {
    if (!resolved.credit.closingDay) {
      warnings.push(`O cartão "${resolved.credit.name}" não tem dia de fechamento configurado; as faturas seguem o mês calendário.`);
    } else if (resolved.credit.closingDay === 1) {
      warnings.push(`O cartão "${resolved.credit.name}" fecha no dia 1: as linhas datadas no dia 01 entram na fatura do mês seguinte.`);
    }
    if (billsCannotPay) {
      warnings.push('A conta de contas fixas é um cartão de crédito (ou o próprio cartão); o pagamento de fatura não será registrado.');
    }
  }
  if (month && resolved.credit.type === AccountType.CREDIT) {
    const creditRows = rows.filter(
      (r) => r.section === 'credit' && (r.status === 'new' || r.status === 'changed' || r.status === 'replaces-future'),
    );
    const amount = sumAmounts(creditRows);
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

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

export interface ConfirmParams {
  request: MaxFinConfirmRequest;
  userId?: string;
  /** Already resolved and authorized by the route; resolved here when omitted. */
  resolved?: MaxFinAccountsResolved;
}

interface CategoryResolver {
  categoryNameFor(key: string, type: 'INCOME' | 'EXPENSE'): string;
  created: Array<{ id: string; name: string; type: 'INCOME' | 'EXPENSE' }>;
}

/** Validate the mapping and create the requested custom categories (find-or-create by normalized name + type). */
async function buildCategoryResolver(householdId: string, entries: MaxFinCategoryMapInput[]): Promise<CategoryResolver> {
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
      toCreate.push({ mapKey, name, type: entry.type });
    } else {
      resolvedNames.set(mapKey, defaultCategoryFor(entry.type));
    }
  }

  // Pass 2: find-or-create the custom categories (a repeated (type, name) is created once).
  for (const { mapKey, name, type } of toCreate) {
    let custom = findCustom(name, type);
    if (!custom) {
      const createdCat = await createCategory({ householdId, name, type: type as CategoryType });
      custom = { id: createdCat.id, name: createdCat.name, type };
      customs.push(custom);
      created.push({ id: custom.id, name: custom.name, type });
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
): Promise<FuturePlaceholder[]> {
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
  return found
    .filter((t) => isFutureDraftRef(t.sourceRef) && t.installmentNumber != null)
    .map((t) => ({ id: t.id, installmentNumber: t.installmentNumber as number }));
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
    select: { id: true, sourceRef: true },
  });
  const existingByRef = new Map(existingRows.map((t) => [t.sourceRef as string, t.id]));

  const ids: string[] = [];
  let imported = 0;
  let skipped = 0;
  let replaced = 0;
  let consumedFutureInstallments = 0;
  const importedCreditRows: MaxFinConfirmRow[] = [];
  const importedFutureRows: MaxFinConfirmRow[] = [];

  for (const row of rows) {
    const existingId = existingByRef.get(row.sourceRef);
    const placeholders =
      row.section === 'credit' && row.installment
        ? await findFuturePlaceholders(householdId, resolved.credit.id, row.installment)
        : [];

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
              type: TransactionType.EXPENSE,
              categoryName: categories.categoryNameFor(draft.categoryKey, 'EXPENSE'),
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
    const amount = sumAmounts(importedCreditRows);
    if (resolved.credit.type !== AccountType.CREDIT) {
      warnings.push('Pagamento de fatura não registrado: a conta do cartão não é do tipo crédito.');
    } else if (resolved.bills.type === AccountType.CREDIT || resolved.bills.id === resolved.credit.id) {
      warnings.push('Pagamento de fatura não registrado: a conta de contas fixas é um cartão de crédito (ou o próprio cartão).');
    } else if (amount <= 0) {
      warnings.push('Pagamento de fatura não registrado: nenhuma compra de cartão foi importada nesta confirmação.');
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
    consumedFutureInstallments,
    futureInstallments,
    createdCategories: categories.created,
    invoicePayment,
    ids,
    warnings,
  };
}
