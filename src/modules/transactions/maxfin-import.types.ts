/**
 * HTTP contract of the monthly-sheet ("MaxFin") importer:
 *   POST /transactions/import/maxfin/preview  (multipart: file + accounts + options)
 *   POST /transactions/import/maxfin/confirm  (application/json: MaxFinConfirmRequest)
 *
 * These are the shapes the frontend consumes. Keep them free of Prisma types and
 * of internal helper types; the service maps internal structures into these.
 */
import type {
  MaxFinInstallment,
  MaxFinMonth,
  MaxFinSectionKey,
  MaxFinSkippedRow,
  ShareHint,
} from './parsers/maxfin.types.js';

/** Destination account per sheet block. All four must belong to the same household. */
export interface MaxFinAccountsInput {
  income: string;
  bills: string;
  credit: string;
  debit: string;
}

/**
 * Import behaviour switches. The preview returns suggested values:
 * closedMonth = sheet month before the current month; payInvoice = closedMonth;
 * generateFutureInstallments = !closedMonth.
 */
export interface MaxFinImportOptions {
  /** Treat every row as settled (paid/received) and allow the invoice payment. */
  closedMonth: boolean;
  /** Record the credit card invoice payment from the bills account (only when closedMonth and credit rows were imported). */
  payInvoice: boolean;
  /** Create the remaining installments (N+1..M) of credit rows in the following months (only when !closedMonth). */
  generateFutureInstallments: boolean;
}

/** Optional overrides accepted by the preview (multipart field `options`, JSON). */
export interface MaxFinPreviewOptionsInput extends Partial<MaxFinImportOptions> {
  /** Used when the sheet month cannot be detected from the title or the file name. */
  monthOverride?: MaxFinMonth;
}

export type MaxFinRowStatus =
  | 'new'
  | 'duplicate' // same sourceRef already imported, same amount and paid flag
  | 'changed' // same sourceRef already imported with a different amount or paid flag
  | 'replaces-future' // generated future installments of the same plan (from an earlier import) are superseded by this row
  | 'legacy-duplicate'; // no sourceRef match, but an identical (account, day, amount, description) exists

export interface MaxFinPreviewRow {
  sourceLine: number;
  sourceRef: string;
  section: MaxFinSectionKey;
  /** Resolved from the section. */
  accountId: string;
  type: 'INCOME' | 'EXPENSE';
  description: string;
  categoryKey: string;
  amount: number;
  planned: number | null;
  realized: number | null;
  /** Effective value after the closedMonth rule. */
  paid: boolean;
  /** YYYY-MM-DD (local). */
  date: string;
  notes: string | null;
  flag: string | null;
  installment: MaxFinInstallment | null;
  /** Installments that confirm would create for this row under the suggested options. */
  futureInstallments: number;
  shareHint: ShareHint | null;
  status: MaxFinRowStatus;
  statusDetail: string | null;
  existingTransactionId: string | null;
}

export type MaxFinCategoryTargetKind = 'system' | 'custom' | 'create' | 'default';

export interface MaxFinCategorySuggestion {
  kind: MaxFinCategoryTargetKind;
  /** System enum value (kind system/default) or "CUSTOM:<id>" (kind custom). */
  categoryName?: string;
  /** Existing custom category id (kind custom). */
  categoryId?: string;
  /** Name of the custom category to create (kind create). */
  name?: string;
  /** Human label for the UI (e.g. "Saúde (sistema)", "Casa (nova categoria)"). */
  label: string;
}

export interface MaxFinCategoryMapEntry {
  key: string;
  type: 'INCOME' | 'EXPENSE';
  count: number;
  sections: MaxFinSectionKey[];
  suggestion: MaxFinCategorySuggestion;
}

export interface MaxFinSectionPreview {
  key: MaxFinSectionKey;
  label: string;
  accountId: string;
  count: number;
  sum: number;
  sheetTotalPlanned: number | null;
  sheetTotalRealized: number | null;
  newCount: number;
  duplicateCount: number;
  changedCount: number;
}

export interface MaxFinInvoicePreview {
  creditAccountId: string;
  sourceAccountId: string;
  /** YYYY-MM */
  month: string;
  /** YYYY-MM-DD, due day of the sheet month (or its last day when the card has no due day). */
  paymentDate: string;
  /** Sum of the credit rows that would be imported (new + replaced). */
  amount: number;
  dueDay: number | null;
  closingDay: number | null;
  /** A payment for this card and month already exists: confirm never records a second one. */
  alreadyPaid: boolean;
  /** True when confirm would record the payment under the suggested options. */
  willPay: boolean;
}

export interface MaxFinPreviewTotals {
  rows: number;
  new: number;
  duplicate: number;
  changed: number;
  legacyDuplicate: number;
  skipped: number;
}

export interface MaxFinPreviewResponse {
  month: MaxFinMonth | null;
  /** YYYY-MM or null when the month could not be detected. */
  monthKey: string | null;
  monthSource: 'title' | 'filename' | 'override' | 'none';
  householdId: string;
  accounts: MaxFinAccountsInput;
  /** Suggested options (see MaxFinImportOptions). */
  options: MaxFinImportOptions;
  sections: MaxFinSectionPreview[];
  rows: MaxFinPreviewRow[];
  skipped: MaxFinSkippedRow[];
  categoryMap: MaxFinCategoryMapEntry[];
  invoice: MaxFinInvoicePreview | null;
  warnings: string[];
  totals: MaxFinPreviewTotals;
}

export type MaxFinCategoryTargetInput =
  | { kind: 'system'; categoryName: string }
  | { kind: 'custom'; categoryId: string }
  | { kind: 'create'; name: string }
  | { kind: 'default' };

export interface MaxFinCategoryMapInput {
  key: string;
  type: 'INCOME' | 'EXPENSE';
  target: MaxFinCategoryTargetInput;
}

/** A preview row the user chose to import (rows left out are simply not sent). */
export interface MaxFinConfirmRow {
  sourceRef: string;
  section: MaxFinSectionKey;
  type: 'INCOME' | 'EXPENSE';
  description: string;
  categoryKey: string;
  amount: number;
  paid: boolean;
  /** YYYY-MM-DD */
  date: string;
  notes: string | null;
  installment: MaxFinInstallment | null;
  /**
   * Confirms replacing what this row supersedes: the stored row with the same sourceRef (status `changed`)
   * and/or the generated future installments of the same plan it covers (status `replaces-future`).
   * Without it such rows are skipped. Never deletes anything else.
   */
  replace?: boolean;
}

export interface MaxFinConfirmRequest {
  month: MaxFinMonth;
  accounts: MaxFinAccountsInput;
  options: MaxFinImportOptions;
  categoryMap: MaxFinCategoryMapInput[];
  rows: MaxFinConfirmRow[];
}

export interface MaxFinConfirmResponse {
  imported: number;
  /** Rows re-checked at write time and found already imported (or not replaceable). */
  skipped: number;
  replaced: number;
  /** Generated future installments deleted because a sheet row of the same plan superseded them. */
  consumedFutureInstallments: number;
  futureInstallments: number;
  createdCategories: Array<{ id: string; name: string; type: 'INCOME' | 'EXPENSE' }>;
  invoicePayment: { transactionId: string; amount: number; date: string } | null;
  ids: string[];
  /** Non-fatal notices (e.g. invoice payment skipped because one already exists for the month). */
  warnings: string[];
}
