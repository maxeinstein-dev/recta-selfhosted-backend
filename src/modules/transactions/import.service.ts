import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError } from '../../shared/errors/app-error.js';
import { CategoryName, TransactionType } from '../../shared/enums/index.js';
import { parseCsv, type ParsedRow } from './parsers/csv.parser.js';
import { parseOfx } from './parsers/ofx.parser.js';
import { createTransaction } from './transactions.service.js';

export type { ParsedRow };

export interface ImportPreviewRow extends ParsedRow {
  index: number;
  duplicate: boolean;
}

export interface ImportPreview {
  rows: ImportPreviewRow[];
  total: number;
  duplicateCount: number;
  newCount: number;
}

export interface ConfirmImportResult {
  imported: number;
  skipped: number;
  ids: string[];
}

/** Tolerance for in-memory amount comparison (half a cent). */
const AMOUNT_TOLERANCE = 0.005;

/**
 * Pure helper: calendar-day window for a parsed row.
 * Transaction.date is @db.Date (day precision), so dedup must ignore
 * the time component that OFX/CSV parsers may include.
 */
export function getDayRange(date: Date): { start: Date; end: Date } {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

/**
 * Pure helper: float-safe amount comparison for unit tests and docs.
 * The DB query below uses exact Prisma.Decimal equality instead, which is
 * correct because Postgres `numeric` comparison is scale-insensitive
 * (89.9 = 89.90) and import duplicates always originate from the same
 * parser path (same JS number -> same Decimal -> same numeric value).
 */
export function amountsEqual(a: number, b: number, tolerance = AMOUNT_TOLERANCE): boolean {
  return Math.abs(a - b) <= tolerance;
}

/**
 * Parse an uploaded statement file. Selects the parser by extension.
 * @throws BadRequestError (400) for unsupported extensions or empty/unreadable content.
 */
export function parseImportBuffer(filename: string, buffer: Buffer): ParsedRow[] {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';

  if (ext !== '.ofx' && ext !== '.csv') {
    throw new BadRequestError(
      `Unsupported file type "${ext || filename}". Only .ofx and .csv files are accepted.`,
    );
  }

  const text = buffer.toString('utf-8');
  const rows = ext === '.ofx' ? parseOfx(text) : parseCsv(text);

  if (rows.length === 0) {
    throw new BadRequestError('No readable transactions found in the file.');
  }

  return rows;
}

/**
 * True when a transaction with the same household + account + day +
 * amount + description already exists. Amount compares via Prisma.Decimal
 * exact equality (scale-insensitive numeric match in Postgres); the day
 * window neutralizes the time component (@db.Date stores day precision).
 */
export async function isDuplicateRow(
  accountId: string,
  householdId: string,
  row: ParsedRow,
): Promise<boolean> {
  const { start, end } = getDayRange(row.date);
  const existing = await prisma.transaction.findFirst({
    where: {
      householdId,
      accountId,
      description: row.description,
      amount: new Prisma.Decimal(row.amount),
      date: { gte: start, lte: end },
    },
    select: { id: true },
  });
  return existing !== null;
}

export async function buildImportPreview(
  accountId: string,
  householdId: string,
  rows: ParsedRow[],
): Promise<ImportPreview> {
  const preview: ImportPreviewRow[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] as ParsedRow;
    preview.push({
      date: new Date(row.date),
      description: row.description,
      amount: row.amount,
      type: row.type,
      index,
      duplicate: await isDuplicateRow(accountId, householdId, row),
    });
  }
  const duplicateCount = preview.filter((r) => r.duplicate).length;
  return {
    rows: preview,
    total: preview.length,
    duplicateCount,
    newCount: preview.length - duplicateCount,
  };
}

/**
 * Persist non-duplicate rows, revalidating each one against the DB
 * (the preview is not trusted: rows may have been imported since).
 * Each row goes through the existing createTransaction, which owns its
 * own transaction and updates the account balance — so this loops
 * sequentially instead of wrapping everything in an outer
 * prisma.$transaction (an outer interactive transaction would be a no-op:
 * createTransaction queries via the global prisma client, not the tx
 * handle, and would neither join it nor roll back with it).
 */
export async function confirmImport(
  accountId: string,
  householdId: string,
  rows: ParsedRow[],
  userId?: string,
): Promise<ConfirmImportResult> {
  const ids: string[] = [];
  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    if (await isDuplicateRow(accountId, householdId, row)) {
      skipped += 1;
      continue;
    }
    const created = await createTransaction(
      {
        householdId,
        accountId,
        type: row.type === 'INCOME' ? TransactionType.INCOME : TransactionType.EXPENSE,
        categoryName:
          row.type === 'INCOME' ? CategoryName.OTHER_INCOME : CategoryName.OTHER_EXPENSES,
        amount: row.amount,
        description: row.description,
        date: row.date,
        paid: true,
        isSplit: false,
      },
      userId,
    );
    ids.push(created.id);
    imported += 1;
  }

  return { imported, skipped, ids };
}
