/**
 * Pure helpers for the MaxFin spreadsheet importer (no prisma, no I/O).
 *
 * The import service parses the monthly sheet into MaxFinRow[], lets the
 * user map sheet category labels to Recta categories, creates transactions,
 * generates the future credit-card installments of the newest month and
 * records the invoice payment of closed months. Everything deterministic in
 * those steps lives here so it can be unit tested in isolation.
 */
import {
  CATEGORY_NAME_DISPLAY,
  CategoryName,
  CategoryType,
  getCategoriesByType,
} from '../../shared/enums/index.js';
import { toCustomCategoryName } from '../../shared/utils/categoryHelpers.js';
import { MAXFIN_SECTION_KEYS } from './parsers/maxfin.types.js';
import type { MaxFinInstallment, MaxFinMonth, MaxFinRow, MaxFinSectionKey } from './parsers/maxfin.types.js';

// Category mapping

/** Upper bound for the name of a custom category created by the import. */
const MAX_CUSTOM_CATEGORY_NAME = 100;

/**
 * Canonical form used for every label comparison: trimmed, lower-cased,
 * accents stripped (NFD + combining marks removed) and inner whitespace
 * collapsed to a single space.
 */
export function normalizeLabel(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export type CategorySuggestion =
  | { kind: 'default'; categoryName: CategoryName }
  | { kind: 'system'; categoryName: CategoryName }
  | { kind: 'custom'; categoryId: string; categoryName: string; name: string }
  | { kind: 'create'; name: string };

export interface CustomCategoryRef {
  id: string;
  name: string;
  type: 'INCOME' | 'EXPENSE';
}

function toCategoryType(type: 'INCOME' | 'EXPENSE'): CategoryType {
  return type === 'INCOME' ? CategoryType.INCOME : CategoryType.EXPENSE;
}

/** Labels a system category answers to: pt-BR display name, enum key, enum key with spaces. */
function systemLabels(category: CategoryName): string[] {
  return [CATEGORY_NAME_DISPLAY[category], category, category.replace(/_/g, ' ')];
}

/**
 * Suggest a Recta category for a sheet label. Order: empty key -> default
 * ("other") category of the type; system category of the same type (pt-BR
 * label or enum key); existing custom category of the same type; otherwise
 * create a custom category named after the label.
 */
export function suggestCategory(
  key: string,
  type: 'INCOME' | 'EXPENSE',
  customs: CustomCategoryRef[],
): CategorySuggestion {
  const normalized = normalizeLabel(key);

  if (normalized === '') {
    return {
      kind: 'default',
      categoryName: type === 'INCOME' ? CategoryName.OTHER_INCOME : CategoryName.OTHER_EXPENSES,
    };
  }

  for (const category of getCategoriesByType(toCategoryType(type))) {
    if (systemLabels(category).some((label) => normalizeLabel(label) === normalized)) {
      return { kind: 'system', categoryName: category };
    }
  }

  const custom = customs.find((c) => c.type === type && normalizeLabel(c.name) === normalized);
  if (custom) {
    return {
      kind: 'custom',
      categoryId: custom.id,
      categoryName: toCustomCategoryName(custom.id),
      name: custom.name,
    };
  }

  return { kind: 'create', name: key.trim().slice(0, MAX_CUSTOM_CATEGORY_NAME) };
}

export interface CategoryMapEntry {
  key: string;
  type: 'INCOME' | 'EXPENSE';
  count: number;
  sections: MaxFinSectionKey[];
  suggestion: CategorySuggestion;
}

const SECTION_ORDER = Object.fromEntries(MAXFIN_SECTION_KEYS.map((key, index) => [key, index])) as Record<
  MaxFinSectionKey,
  number
>;

interface CategoryMapAccumulator {
  normalized: string;
  firstSection: MaxFinSectionKey;
  /** Every row of the entry had its type inverted by a negative value (a refund in an expense block). */
  allReversed: boolean;
  entry: CategoryMapEntry;
}

/** A negative value inverts the type of its block: INCOME in bills/credit/debit, EXPENSE in income. */
function isReversedRow(row: MaxFinRow): boolean {
  return (row.section === 'income') !== (row.type === 'INCOME');
}

/**
 * One entry per distinct (type, normalized key), including the empty key so
 * the preview can show "sem categoria". Keeps the first-seen spelling, counts
 * rows and lists the sections in first-seen order. Sorted INCOME first, then
 * by the section of first appearance (income, bills, credit, debit), then by
 * normalized key.
 */
export function buildCategoryMap(rows: MaxFinRow[], customs: CustomCategoryRef[]): CategoryMapEntry[] {
  const byKey = new Map<string, CategoryMapAccumulator>();

  for (const row of rows) {
    const normalized = normalizeLabel(row.categoryKey);
    const id = `${row.type}|${normalized}`;
    let acc = byKey.get(id);
    if (!acc) {
      acc = {
        normalized,
        firstSection: row.section,
        allReversed: true,
        entry: {
          key: row.categoryKey.trim(),
          type: row.type,
          count: 0,
          sections: [],
          suggestion: suggestCategory(row.categoryKey, row.type, customs),
        },
      };
      byKey.set(id, acc);
    }
    acc.entry.count += 1;
    acc.allReversed = acc.allReversed && isReversedRow(row);
    if (!acc.entry.sections.includes(row.section)) {
      acc.entry.sections.push(row.section);
    }
  }

  return [...byKey.values()]
    .sort((a, b) =>
      compareCategoryEntries(
        { type: a.entry.type, section: a.firstSection, normalized: a.normalized },
        { type: b.entry.type, section: b.firstSection, normalized: b.normalized },
      ),
    )
    .map((acc) => {
      // Refunds keep the label of the purchase ("Lazer"); creating an income category with that name would only
      // clutter the list, so an unknown label used only by refunds goes to the default category of its type.
      if (acc.allReversed && acc.entry.suggestion.kind === 'create') {
        const categoryName = acc.entry.type === 'INCOME' ? CategoryName.OTHER_INCOME : CategoryName.OTHER_EXPENSES;
        return { ...acc.entry, suggestion: { kind: 'default', categoryName } };
      }
      return acc.entry;
    });
}

interface CategoryOrderKey {
  type: 'INCOME' | 'EXPENSE';
  section: MaxFinSectionKey;
  normalized: string;
}

/** INCOME first, then by block, then by normalized key. */
function compareCategoryEntries(a: CategoryOrderKey, b: CategoryOrderKey): number {
  if (a.type !== b.type) return a.type === 'INCOME' ? -1 : 1;
  const bySection = SECTION_ORDER[a.section] - SECTION_ORDER[b.section];
  if (bySection !== 0) return bySection;
  if (a.normalized === b.normalized) return 0;
  return a.normalized < b.normalized ? -1 : 1;
}

/** What mergeCategoryMaps needs from an entry (a CategoryMapEntry or its DTO). */
export interface MergeableCategoryEntry {
  key: string;
  type: 'INCOME' | 'EXPENSE';
  count: number;
  sections: MaxFinSectionKey[];
}

/**
 * One category map for several months: entries with the same type and normalized key become one, with the
 * counts summed and the sections joined in block order. The spelling and the suggestion come from the first map
 * that has the entry: the workbook preview passes the months oldest first, so the oldest month's suggestion wins
 * even when a later month alone would suggest another target (for example a label used only by refunds there).
 * Sorted like buildCategoryMap, by the first block of the joined sections.
 */
export function mergeCategoryMaps<T extends MergeableCategoryEntry>(maps: T[][]): T[] {
  const merged = new Map<string, T>();
  for (const map of maps) {
    for (const entry of map) {
      const id = `${entry.type}|${normalizeLabel(entry.key)}`;
      const existing = merged.get(id);
      if (!existing) {
        merged.set(id, { ...entry, sections: [...entry.sections] });
        continue;
      }
      existing.count += entry.count;
      for (const section of entry.sections) {
        if (!existing.sections.includes(section)) existing.sections.push(section);
      }
    }
  }
  const entries = [...merged.values()];
  for (const entry of entries) entry.sections.sort((a, b) => SECTION_ORDER[a] - SECTION_ORDER[b]);
  const orderKey = (entry: T): CategoryOrderKey => ({
    type: entry.type,
    section: entry.sections[0] ?? 'income',
    normalized: normalizeLabel(entry.key),
  });
  return entries.sort((a, b) => compareCategoryEntries(orderKey(a), orderKey(b)));
}

// Month arithmetic (local time; the sheet is a calendar month, dates are day 01 at local midnight)

/** 'YYYY-MM', zero-padded. */
export function monthKey(month: MaxFinMonth): string {
  return `${String(month.year).padStart(4, '0')}-${String(month.month).padStart(2, '0')}`;
}

/** Month shifted by n (negative allowed), rolling the year over as needed. */
export function addMonths(month: MaxFinMonth, n: number): MaxFinMonth {
  const index = month.year * 12 + (month.month - 1) + n;
  return { year: Math.floor(index / 12), month: ((index % 12) + 12) % 12 + 1 };
}

/** Day 01 of the month at local midnight. */
export function firstDayOfMonth(month: MaxFinMonth): Date {
  return new Date(month.year, month.month - 1, 1);
}

/** Number of days in the month (28..31). */
export function lastDayOfMonth(month: MaxFinMonth): number {
  return new Date(month.year, month.month, 0).getDate();
}

/** True when the month is strictly before the calendar month of `today`. */
export function isClosedMonth(month: MaxFinMonth, today: Date = new Date()): boolean {
  const target = month.year * 12 + (month.month - 1);
  const current = today.getFullYear() * 12 + today.getMonth();
  return target < current;
}

/**
 * Date the credit-card invoice of `month` counts as paid: the card's due day
 * clamped to [1, last day of the month]; null/undefined (or a non-finite
 * value) falls back to the last day. Local midnight.
 */
export function invoicePaymentDate(month: MaxFinMonth, dueDay: number | null | undefined): Date {
  const last = lastDayOfMonth(month);
  const day =
    dueDay == null || !Number.isFinite(dueDay)
      ? last
      : Math.min(Math.max(Math.trunc(dueDay), 1), last);
  return new Date(month.year, month.month - 1, day);
}

// Future credit-card installments

export interface FutureInstallmentDraft {
  date: Date;
  description: string;
  amount: number;
  installmentId: string;
  installmentNumber: number;
  totalInstallments: number;
  categoryKey: string;
  notes: string;
  paid: true;
  sourceRef: string;
  section: 'credit';
}

/** What buildFutureInstallments needs from a sheet row (a full MaxFinRow satisfies it). */
export type FutureInstallmentSource = Pick<
  MaxFinRow,
  'amount' | 'categoryKey' | 'description' | 'sourceRef' | 'installment'
>;

/**
 * Amount of one future installment. A prepaid row ("+K") carries the net total of
 * installments N..N+K, so the per-installment value is estimated by dividing it by
 * K+1 (the prepayment discount makes the exact value unknowable from the sheet).
 */
export function futureInstallmentAmount(rowAmount: number, prepaid: number): number {
  if (prepaid <= 0) return rowAmount;
  return Math.round((rowAmount / (prepaid + 1)) * 100) / 100;
}

/** Installment numbers covered by a sheet row: N..N+K (K = installments prepaid in that invoice). */
export function coveredInstallmentNumbers(installment: MaxFinInstallment): number[] {
  const numbers: number[] = [];
  for (let n = installment.number; n <= installment.number + installment.prepaid; n++) numbers.push(n);
  return numbers;
}

/** Numbers still to come after the row (N+K+1..M) that are not stored yet. */
export function missingFutureNumbers(installment: MaxFinInstallment, existing: ReadonlySet<number>): number[] {
  const numbers: number[] = [];
  for (let n = installment.number + installment.prepaid + 1; n <= installment.total; n++) {
    if (!existing.has(n)) numbers.push(n);
  }
  return numbers;
}

/**
 * Drafts for the installments still to come after the sheet month, one per
 * following month, in order. Installments already prepaid in this invoice
 * ("+K") are skipped by numbering: the next one is number + prepaid + 1, and
 * numbers present in `existingNumbers` (generated by an earlier import or typed
 * by hand) are skipped so a plan is never stored twice.
 * Returns [] when the row is not an installment or the plan is settled.
 */
export function buildFutureInstallments(
  row: FutureInstallmentSource,
  month: MaxFinMonth,
  existingNumbers?: ReadonlySet<number>,
): FutureInstallmentDraft[] {
  const installment = row.installment;
  if (!installment || installment.futureCount <= 0) return [];
  const amount = futureInstallmentAmount(row.amount, installment.prepaid);
  const estimated = installment.prepaid > 0 ? ' (valor estimado: linha com parcelas antecipadas)' : '';

  const drafts: FutureInstallmentDraft[] = [];
  for (let i = 1; i <= installment.futureCount; i++) {
    const n = installment.number + installment.prepaid + i;
    if (existingNumbers?.has(n)) continue;
    drafts.push({
      date: firstDayOfMonth(addMonths(month, i)),
      description: `${installment.baseDescription} ${n}/${installment.total}`,
      amount,
      installmentId: installment.installmentId,
      installmentNumber: n,
      totalInstallments: installment.total,
      categoryKey: row.categoryKey,
      notes: `parcela futura gerada na importação de "${row.description}"${estimated}`,
      paid: true,
      sourceRef: `${row.sourceRef}:f${i}`,
      section: 'credit',
    });
  }
  return drafts;
}

// Day strings. Prisma returns @db.Date columns as UTC midnight, while parsed sheet dates are local midnight:
// comparing them needs the UTC day for stored values and the local day for parsed ones, in any host timezone.

/** 'YYYY-MM-DD' of a local-midnight Date (parsed rows, user input). */
export function toLocalDateString(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 'YYYY-MM-DD' of a value read from a @db.Date column (UTC midnight). */
export function storedDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Local-midnight Date from 'YYYY-MM-DD'.
 * @throws Error when the text is not a real calendar day (the Date constructor would roll 2026-13-45 over).
 */
export function parseLocalDateString(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid date "${value}" (expected YYYY-MM-DD)`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`Invalid date "${value}"`);
  }
  return date;
}

/**
 * Technical identifier `payCreditCardInvoice` stores on the payment of a card's invoice for a month
 * (`invoice_pay:<card>:<year>-<zero-based month>`). The frontend builds the same string to filter invoices.
 */
export function invoiceTechnicalId(accountId: string, month: MaxFinMonth): string {
  return `invoice_pay:${accountId}:${month.year}-${month.month - 1}`;
}

/** Key of the "same account, day, amount, description and type" legacy duplicate rule (amounts are absolute). */
export function legacyKey(accountId: string, day: string, amount: number, description: string, type: string): string {
  return `${accountId}|${day}|${amount.toFixed(2)}|${description.trim()}|${type}`;
}

/** True for the sourceRef of a future installment generated by an import (`<rowRef>:f<N>`). */
export function isFutureDraftRef(sourceRef: string | null | undefined): boolean {
  return !!sourceRef && /^maxfin:[^:]+:[a-z]+:\d+:f\d+$/.test(sourceRef);
}

// Amounts

/** Integer cents; the nudge absorbs binary drift such as 1.005 * 100 = 100.49999999999999. */
function toCents(amount: number): number {
  const cents = Math.round(Math.abs(amount) * 100 + 1e-6);
  return amount < 0 ? -cents : cents;
}

/** Sum rounded to 2 decimals, accumulated as integer cents to avoid float drift. */
export function sumAmounts(rows: Array<{ amount: number }>): number {
  let cents = 0;
  for (const row of rows) cents += toCents(row.amount);
  return cents / 100;
}

/**
 * What a card invoice covers, in reais: its purchases (EXPENSE) minus its credits (INCOME rows, from negative
 * values such as refunds), added up in integer cents so no float drift creeps in. Zero or less means there is
 * nothing to pay.
 */
export function invoiceNetAmount(rows: Array<{ type: 'INCOME' | 'EXPENSE'; amount: number }>): number {
  return sumAmounts(rows.map((row) => ({ amount: row.type === 'INCOME' ? -row.amount : row.amount })));
}
