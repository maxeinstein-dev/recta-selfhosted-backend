import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountType, CategoryName } from '../../shared/enums/index.js';
import { ForbiddenError } from '../../shared/errors/app-error.js';
import { normalizeLabel } from './maxfin-import.helpers.js';
import {
  buildMaxFinPreview,
  classifyRow,
  confirmMaxFinImport,
  isUniqueViolation,
  resolveImportOptions,
  resolveMaxFinAccounts,
  sanitizeInstallment,
  suggestionToDto,
  validateConfirmRows,
  type BuildPreviewParams,
  type MaxFinAccountsResolved,
  type ResolvedAccount,
} from './maxfin-import.service.js';
import type {
  MaxFinAccountsInput,
  MaxFinCategoryMapInput,
  MaxFinConfirmRow,
  MaxFinImportOptions,
  MaxFinPreviewResponse,
  MaxFinPreviewRow,
} from './maxfin-import.types.js';
import type { MaxFinInstallment, MaxFinMonth, MaxFinSectionKey } from './parsers/maxfin.types.js';

// The service talks to prisma and to three write functions; the parser and the pure helpers run for real.
const db = vi.hoisted(() => ({
  accountFindMany: vi.fn(),
  categoryFindMany: vi.fn(),
  transactionFindMany: vi.fn(),
  transactionFindFirst: vi.fn(),
  externalRefFindMany: vi.fn(),
  createTransaction: vi.fn(),
  deleteTransaction: vi.fn(),
  payCreditCardInvoice: vi.fn(),
  createCategory: vi.fn(),
}));

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    account: { findMany: db.accountFindMany },
    category: { findMany: db.categoryFindMany },
    transaction: { findMany: db.transactionFindMany, findFirst: db.transactionFindFirst },
    transactionExternalRef: { findMany: db.externalRefFindMany },
  },
}));
vi.mock('./transactions.service.js', () => ({
  createTransaction: db.createTransaction,
  deleteTransaction: db.deleteTransaction,
  payCreditCardInvoice: db.payCreditCardInvoice,
}));
vi.mock('../categories/categories.service.js', () => ({ createCategory: db.createCategory }));
// Recurrence matching has its own tests (maxfin-import.recurring.test.ts); here no recurrence covers any month.
vi.mock('./maxfin-recurring.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./maxfin-recurring.js')>()),
  loadRecurringMatcher: async () => ({ take: () => undefined }),
}));


// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOUSEHOLD = 'hh-1';
const MARCH: MaxFinMonth = { year: 2026, month: 3 };
const SAMPLE_CSV = readFileSync(new URL('./parsers/__fixtures__/maxfin-sample.csv', import.meta.url));
/** After the sample month (2026-03): the month is closed. */
const APRIL_15 = new Date(2026, 3, 15);
/** Inside the sample month: the month is the current one, hence open. */
const MARCH_15 = new Date(2026, 2, 15);

/** sourceRef of the sample rows the tests refer to (sheet month 2026-03). */
const REF = {
  freela: 'maxfin:2026-03:income:8', // not received yet in the sheet (paid = false)
  rent: 'maxfin:2026-03:bills:11',
  gym: 'maxfin:2026-03:bills:13', // not paid yet in the sheet
  market: 'maxfin:2026-03:credit:16',
  lojaA: 'maxfin:2026-03:credit:17', // "Loja A 3/10": 7 installments to come
  cursoB: 'maxfin:2026-03:credit:18', // "Curso B 5/12 +7": plan settled by the prepayment
  remedios: 'maxfin:2026-03:credit:19', // "Remédios 1/4 + 1": 2 installments to come
  refund: 'maxfin:2026-03:credit:21', // "Estorno Loja A", -156.00 in the sheet: a credit on the card
  uber: 'maxfin:2026-03:credit:25',
  luz: 'maxfin:2026-03:debit:30',
  padaria: 'maxfin:2026-03:debit:33',
} as const;
const PLAN_LOJA_A = 'maxfin:loja-a:10';
const PLAN_CURSO_B = 'maxfin:curso-b:12';

const OPEN: MaxFinImportOptions = { closedMonth: false, payInvoice: false, generateFutureInstallments: false };
const OPEN_WITH_FUTURES: MaxFinImportOptions = { ...OPEN, generateFutureInstallments: true };
const CLOSED: MaxFinImportOptions = { closedMonth: true, payInvoice: false, generateFutureInstallments: false };
const CLOSED_WITH_INVOICE: MaxFinImportOptions = { ...CLOSED, payInvoice: true };

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

type TxInput = Record<string, unknown>;

/**
 * AppError resets its prototype, so `instanceof BadRequestError` is false for its own instances
 * (see import.service.test.ts): a BadRequestError is recognised by its status and code instead.
 */
function isBadRequest(message: string | RegExp) {
  return expect.objectContaining({
    statusCode: 400,
    code: 'BAD_REQUEST',
    message: typeof message === 'string' ? expect.stringContaining(message) : expect.stringMatching(message),
  });
}

/** Position of the n-th call of a mock in the global call order (to assert "A before B"). */
function callOrder(mock: { mock: { invocationCallOrder: number[] } }, index = 0): number {
  const order = mock.mock.invocationCallOrder[index];
  if (order === undefined) throw new Error(`expected call #${index + 1} to have happened`);
  return order;
}

/** First argument of every createTransaction call, in call order. */
function createdInputs(): TxInput[] {
  return db.createTransaction.mock.calls.map((call) => call[0] as TxInput);
}

function expectNoWrites(): void {
  expect(db.createTransaction).not.toHaveBeenCalled();
  expect(db.deleteTransaction).not.toHaveBeenCalled();
  expect(db.createCategory).not.toHaveBeenCalled();
  expect(db.payCreditCardInvoice).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

type AccountOverrides = Partial<Record<MaxFinSectionKey, Partial<ResolvedAccount>>>;

/** Four resolved accounts of one household; the card is a CREDIT account due on day 9, closing on day 2. */
function makeAccounts(overrides: AccountOverrides = {}): MaxFinAccountsResolved {
  const account = (key: MaxFinSectionKey, defaults: Partial<ResolvedAccount> = {}): ResolvedAccount => ({
    id: `acc-${key}`,
    name: `Conta ${key}`,
    type: AccountType.CHECKING,
    householdId: HOUSEHOLD,
    dueDay: null,
    closingDay: null,
    ...defaults,
    ...overrides[key],
  });
  return {
    householdId: HOUSEHOLD,
    income: account('income'),
    bills: account('bills'),
    credit: account('credit', { name: 'Nubank Teste', type: AccountType.CREDIT, dueDay: 9, closingDay: 2 }),
    debit: account('debit'),
  };
}

function idsOf(accounts: MaxFinAccountsResolved): MaxFinAccountsInput {
  return {
    income: accounts.income.id,
    bills: accounts.bills.id,
    credit: accounts.credit.id,
    debit: accounts.debit.id,
  };
}

function makeInstallment(base: string, number: number, total: number, prepaid = 0): MaxFinInstallment {
  return {
    number,
    total,
    prepaid,
    baseDescription: base,
    installmentId: `maxfin:${normalizeLabel(base).replace(/[^a-z0-9]+/g, '-')}:${total}`,
    futureCount: total - (number + prepaid),
  };
}

let rowSeq = 0;

/** A confirm row of the sample month; the sourceRef is unique per call unless given. */
function makeConfirmRow(overrides: Partial<MaxFinConfirmRow> = {}): MaxFinConfirmRow {
  const section = overrides.section ?? 'debit';
  rowSeq += 1;
  return {
    sourceRef: `maxfin:2026-03:${section}:${100 + rowSeq}`,
    section,
    type: section === 'income' ? 'INCOME' : 'EXPENSE',
    description: `Lancamento ${rowSeq}`,
    categoryKey: section === 'income' ? 'Salário' : 'Alimentação',
    amount: 100,
    paid: true,
    date: '2026-03-01',
    notes: null,
    installment: null,
    ...overrides,
  };
}

/** The sample's "Loja A" installment row, as number/10 (+ prepaid). */
function makeLojaARow(number: number, prepaid = 0, overrides: Partial<MaxFinConfirmRow> = {}): MaxFinConfirmRow {
  return makeConfirmRow({
    section: 'credit',
    sourceRef: REF.lojaA,
    description: `Loja A ${number}/10`,
    categoryKey: 'Compras',
    amount: 90,
    installment: makeInstallment('Loja A', number, 10, prepaid),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Fakes for the prisma queries
// ---------------------------------------------------------------------------

interface StoredRow {
  id: string;
  householdId?: string;
  accountId?: string | null;
  sourceRef?: string | null;
  amount?: number;
  paid?: boolean;
  /** Defaults to INCOME for a sourceRef of the income block, EXPENSE otherwise. */
  type?: 'INCOME' | 'EXPENSE';
  /** @db.Date columns come back from Prisma as UTC midnight. */
  date?: Date;
  description?: string | null;
  installmentId?: string | null;
  installmentNumber?: number | null;
}

interface TransactionWhere {
  householdId?: string;
  accountId?: string | { in: string[] };
  sourceRef?: null | { in?: string[]; contains?: string };
  installmentId?: string | { in: string[] };
  installmentNumber?: { in: number[] };
  date?: unknown;
}

const SUPPORTED_WHERE_KEYS = new Set(['householdId', 'accountId', 'sourceRef', 'installmentId', 'installmentNumber', 'date']);

function matchesWhere(row: Required<StoredRow>, where: TransactionWhere): boolean {
  const { accountId, sourceRef, installmentId, installmentNumber } = where;
  if (where.householdId !== undefined && row.householdId !== where.householdId) return false;
  if (accountId !== undefined) {
    const allowed = typeof accountId === 'string' ? [accountId] : accountId.in;
    if (row.accountId === null || !allowed.includes(row.accountId)) return false;
  }
  if (sourceRef !== undefined) {
    if (sourceRef === null) {
      if (row.sourceRef !== null) return false;
    } else {
      if (row.sourceRef === null) return false;
      if (sourceRef.in && !sourceRef.in.includes(row.sourceRef)) return false;
      if (sourceRef.contains !== undefined && !row.sourceRef.includes(sourceRef.contains)) return false;
    }
  }
  if (installmentId !== undefined) {
    const allowed = typeof installmentId === 'string' ? [installmentId] : installmentId.in;
    if (row.installmentId === null || !allowed.includes(row.installmentId)) return false;
  }
  if (installmentNumber !== undefined) {
    if (row.installmentNumber === null || !installmentNumber.in.includes(row.installmentNumber)) return false;
  }
  // `date` is not emulated: Prisma truncates the @db.Date bounds to their UTC day, so the service's range is a superset.
  return true;
}

/**
 * Make prisma.transaction.findMany answer from these stored rows, honouring the filters the service
 * uses (household, account, sourceRef in / contains / null, plan id and numbers). Rows default to the
 * test household and to the card account. Rows deleted or created by the service do not change it.
 */
function useStore(rows: StoredRow[]): void {
  const stored: Array<Required<StoredRow>> = rows.map((row) => ({
    householdId: HOUSEHOLD,
    accountId: 'acc-credit',
    sourceRef: null,
    amount: 0,
    paid: true,
    date: new Date('2026-03-01T00:00:00.000Z'),
    description: null,
    installmentId: null,
    installmentNumber: null,
    ...row,
    type: row.type ?? (row.sourceRef?.includes(':income:') ? 'INCOME' : 'EXPENSE'),
  }));
  db.transactionFindMany.mockImplementation(async (args: { where: TransactionWhere }) => {
    const unsupported = Object.keys(args.where).filter((key) => !SUPPORTED_WHERE_KEYS.has(key));
    if (unsupported.length > 0) {
      throw new Error(`the transaction.findMany fake does not emulate: ${unsupported.join(', ')}`);
    }
    return stored
      .filter((row) => matchesWhere(row, args.where))
      .map((row) => ({ ...row, amount: { toNumber: () => row.amount } }));
  });
}

interface StoredCategory {
  id: string;
  name: string;
  type: 'INCOME' | 'EXPENSE';
  householdId?: string;
}

/** Make prisma.category.findMany answer with the categories of the requested household. */
function useCategories(categories: StoredCategory[]): void {
  db.categoryFindMany.mockImplementation(async (args: { where: { householdId: string } }) =>
    categories
      .filter((category) => (category.householdId ?? HOUSEHOLD) === args.where.householdId)
      .map(({ id, name, type }) => ({ id, name, type })),
  );
}

let txSeq = 0;
let categorySeq = 0;

const createTransactionOk = async (input: TxInput) => ({ id: `tx-${++txSeq}`, ...input });

/** Make createTransaction fail for the row with this sourceRef and succeed for the others. */
function failCreateFor(sourceRef: string, error: unknown): void {
  db.createTransaction.mockImplementation(async (input: TxInput) => {
    if (input.sourceRef === sourceRef) throw error;
    return createTransactionOk(input);
  });
}

function uniqueViolation(): Error {
  return Object.assign(new Error('Unique constraint failed on (household_id, source_ref)'), { code: 'P2002' });
}

beforeEach(() => {
  for (const mock of Object.values(db)) mock.mockReset();
  rowSeq = 0;
  txSeq = 0;
  categorySeq = 0;
  db.createTransaction.mockImplementation(createTransactionOk);
  db.deleteTransaction.mockResolvedValue(undefined);
  db.createCategory.mockImplementation(async (input: TxInput) => ({ id: `cat-new-${++categorySeq}`, ...input }));
  db.payCreditCardInvoice.mockResolvedValue({ paymentTransaction: { id: 'pay-1' } });
  db.transactionFindFirst.mockResolvedValue(null);
  db.externalRefFindMany.mockResolvedValue([]);
  useStore([]);
  useCategories([]);
});

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

interface ConfirmExtras {
  options?: MaxFinImportOptions;
  categoryMap?: MaxFinCategoryMapInput[];
  resolved?: MaxFinAccountsResolved;
  month?: MaxFinMonth;
}

function confirm(rows: MaxFinConfirmRow[], extras: ConfirmExtras = {}) {
  const resolved = extras.resolved ?? makeAccounts();
  return confirmMaxFinImport({
    request: {
      month: extras.month ?? MARCH,
      accounts: idsOf(resolved),
      options: extras.options ?? OPEN,
      categoryMap: extras.categoryMap ?? [],
      rows,
    },
    userId: 'user-1',
    resolved,
  });
}

/** Preview of the sample sheet; March 2026 is closed unless `today` says otherwise. */
function previewSample(overrides: Partial<BuildPreviewParams> = {}): Promise<MaxFinPreviewResponse> {
  const resolved = overrides.resolved ?? makeAccounts();
  return buildMaxFinPreview({
    filename: 'FINANCAS - MAR.csv',
    buffer: SAMPLE_CSV,
    accounts: idsOf(resolved),
    resolved,
    today: APRIL_15,
    ...overrides,
  });
}

function rowOf(preview: MaxFinPreviewResponse, sourceRef: string): MaxFinPreviewRow {
  const found = preview.rows.find((row) => row.sourceRef === sourceRef);
  if (!found) throw new Error(`the preview has no row ${sourceRef}`);
  return found;
}

/** A future installment generated by an earlier import (sourceRef `<rowRef>:f<i>`): Loja A 3/10 of the February sheet. */
function generatedInstallment(number: number, extra: Partial<StoredRow> = {}): StoredRow {
  return {
    id: `ph-${number}`,
    sourceRef: `maxfin:2026-02:credit:20:f${number - 3}`,
    installmentId: PLAN_LOJA_A,
    installmentNumber: number,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// A. resolveMaxFinAccounts
// ---------------------------------------------------------------------------

describe('resolveMaxFinAccounts', () => {
  const requested: MaxFinAccountsInput = { income: 'a-income', bills: 'a-bills', credit: 'a-credit', debit: 'a-debit' };

  /** An account as prisma.account.findMany returns it. */
  function accountRow(
    id: string,
    householdId: string,
    extra: Partial<{ type: string; dueDay: number | null; closingDay: number | null }> = {},
  ) {
    return { id, name: `Name ${id}`, type: 'CHECKING', householdId, dueDay: null, closingDay: null, ...extra };
  }

  const allInOneHousehold = () => [
    accountRow('a-income', 'hh-1'),
    accountRow('a-bills', 'hh-1'),
    accountRow('a-credit', 'hh-1', { type: 'CREDIT', dueDay: 9, closingDay: 2 }),
    accountRow('a-debit', 'hh-1'),
  ];

  it('rejects when a requested account is missing or inactive, without authorizing anything', async () => {
    const authorize = vi.fn();
    db.accountFindMany.mockResolvedValue(allInOneHousehold().slice(0, 3));

    await expect(resolveMaxFinAccounts(requested, authorize)).rejects.toEqual(isBadRequest('not found or are inactive'));

    expect(authorize).not.toHaveBeenCalled();
  });

  it('queries only active accounts, by the distinct requested ids', async () => {
    db.accountFindMany.mockResolvedValue(allInOneHousehold());

    await resolveMaxFinAccounts(requested);

    expect(db.accountFindMany).toHaveBeenCalledTimes(1);
    expect(db.accountFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['a-income', 'a-bills', 'a-credit', 'a-debit'] }, isActive: true },
      }),
    );
  });

  describe('when the accounts span two households', () => {
    const spanningTwoHouseholds = () => [
      accountRow('a-income', 'hh-1'),
      accountRow('a-bills', 'hh-1'),
      accountRow('a-credit', 'hh-1', { type: 'CREDIT' }),
      accountRow('a-debit', 'hh-2'),
    ];

    it('authorizes both households before reporting the mixed selection', async () => {
      const authorize = vi.fn().mockResolvedValue(undefined);
      db.accountFindMany.mockResolvedValue(spanningTwoHouseholds());

      await expect(resolveMaxFinAccounts(requested, authorize)).rejects.toEqual(isBadRequest('same household'));

      expect(authorize).toHaveBeenCalledTimes(2);
      expect(authorize).toHaveBeenNthCalledWith(1, 'hh-1');
      expect(authorize).toHaveBeenNthCalledWith(2, 'hh-2');
    });

    it('surfaces the authorization error of the second household instead of the mixed-selection error', async () => {
      const forbidden = new ForbiddenError('not a member of hh-2');
      const authorize = vi.fn(async (householdId: string) => {
        if (householdId === 'hh-2') throw forbidden;
      });
      db.accountFindMany.mockResolvedValue(spanningTwoHouseholds());

      await expect(resolveMaxFinAccounts(requested, authorize)).rejects.toBe(forbidden);

      expect(authorize).toHaveBeenCalledTimes(2);
    });

    it('still reports the mixed selection when no authorize callback is given', async () => {
      db.accountFindMany.mockResolvedValue(spanningTwoHouseholds());

      await expect(resolveMaxFinAccounts(requested)).rejects.toEqual(isBadRequest('same household'));
    });
  });

  it('returns the four accounts of a single household with due and closing days mapped, authorizing it once', async () => {
    const authorize = vi.fn().mockResolvedValue(undefined);
    // Reversed on purpose: accounts are matched to their section by id, not by position.
    db.accountFindMany.mockResolvedValue(allInOneHousehold().reverse());

    const resolved = await resolveMaxFinAccounts(requested, authorize);

    expect(resolved).toEqual({
      householdId: 'hh-1',
      income: { id: 'a-income', name: 'Name a-income', type: 'CHECKING', householdId: 'hh-1', dueDay: null, closingDay: null },
      bills: { id: 'a-bills', name: 'Name a-bills', type: 'CHECKING', householdId: 'hh-1', dueDay: null, closingDay: null },
      credit: { id: 'a-credit', name: 'Name a-credit', type: 'CREDIT', householdId: 'hh-1', dueDay: 9, closingDay: 2 },
      debit: { id: 'a-debit', name: 'Name a-debit', type: 'CHECKING', householdId: 'hh-1', dueDay: null, closingDay: null },
    });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith('hh-1');
  });

  it('accepts one account serving two sections and authorizes its household once', async () => {
    const authorize = vi.fn().mockResolvedValue(undefined);
    const billsAndDebit: MaxFinAccountsInput = { ...requested, bills: 'a-debit' };
    db.accountFindMany.mockResolvedValue(allInOneHousehold().filter((a) => a.id !== 'a-bills'));

    const resolved = await resolveMaxFinAccounts(billsAndDebit, authorize);

    expect(resolved.bills).toEqual(resolved.debit);
    expect(resolved.bills.id).toBe('a-debit');
    expect(db.accountFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['a-income', 'a-debit', 'a-credit'] }, isActive: true } }),
    );
    expect(authorize).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// B. validateConfirmRows / sanitizeInstallment
// ---------------------------------------------------------------------------

describe('validateConfirmRows', () => {
  /** A debit row of the given month; the date defaults to day 01. */
  function rowIn(month: MaxFinMonth, date?: string): MaxFinConfirmRow {
    const key = `${month.year}-${String(month.month).padStart(2, '0')}`;
    return makeConfirmRow({ sourceRef: `maxfin:${key}:debit:5`, date: date ?? `${key}-01` });
  }

  it('rejects a request without rows', () => {
    expect(() => validateConfirmRows([], MARCH)).toThrow(isBadRequest('No rows to import'));
  });

  it.each([
    'maxfin:2026-04:debit:5',
    'maxfin:2025-03:debit:5',
    'maxfin:2026-030:debit:5',
    'ofx:abc123:1',
  ])('rejects the sourceRef %s, which does not belong to the sheet month 2026-03', (sourceRef) => {
    const row = makeConfirmRow({ sourceRef });

    expect(() => validateConfirmRows([row], MARCH)).toThrow(isBadRequest('does not belong to month 2026-03'));
  });

  it('rejects the same sourceRef twice in one request', () => {
    const first = makeConfirmRow({ sourceRef: 'maxfin:2026-03:debit:5' });
    const second = makeConfirmRow({ sourceRef: 'maxfin:2026-03:debit:5', description: 'Outro nome' });

    expect(() => validateConfirmRows([first, second], MARCH)).toThrow(
      isBadRequest('Duplicate sourceRef in rows: maxfin:2026-03:debit:5'),
    );
  });

  it.each<{ label: string; section: MaxFinSectionKey; sourceRef: string }>([
    { label: 'a ref that names another block than the row', section: 'credit', sourceRef: 'maxfin:2026-03:debit:30' },
    { label: 'a generated-installment ref (:f<N>) minted by the client', section: 'credit', sourceRef: 'maxfin:2026-03:credit:30:f1' },
    { label: 'a ref whose line is not a number', section: 'bills', sourceRef: 'maxfin:2026-03:bills:abc' },
    { label: 'a ref with no line', section: 'debit', sourceRef: 'maxfin:2026-03:debit:' },
  ])('rejects $label (sourceRef shape)', ({ section, sourceRef }) => {
    const row = makeConfirmRow({ section, sourceRef });

    expect(() => validateConfirmRows([row], MARCH)).toThrow(isBadRequest('does not match its block'));
  });

  it('accepts the exact ref shape the parser emits for every block (sourceRef shape)', () => {
    const rows = (['income', 'bills', 'credit', 'debit'] as const).map((section, index) =>
      makeConfirmRow({ section, sourceRef: `maxfin:2026-03:${section}:${index + 7}` }),
    );

    expect(validateConfirmRows(rows, MARCH)).toHaveLength(4);
  });

  it.each<{ label: string; section: MaxFinSectionKey; type: 'INCOME' | 'EXPENSE' }>([
    { label: 'an INCOME row (a credit) under the credit section', section: 'credit', type: 'INCOME' },
    { label: 'an INCOME row (a credit) under the bills section', section: 'bills', type: 'INCOME' },
    { label: 'an INCOME row (a credit) under the debit section', section: 'debit', type: 'INCOME' },
    { label: 'an EXPENSE row (a debit) under the income section', section: 'income', type: 'EXPENSE' },
  ])('accepts $label, which a negative value in the sheet produces', ({ section, type }) => {
    const row = makeConfirmRow({ section, type });

    expect(validateConfirmRows([row], MARCH).map((validated) => validated.type)).toEqual([type]);
  });

  it.each(['2026-04-01', '2026-02-28', '2025-03-01', '2026-03', '2026-13-01'])(
    'rejects the date %s, which is outside the sheet month',
    (date) => {
      expect(() => validateConfirmRows([rowIn(MARCH, date)], MARCH)).toThrow(isBadRequest('is outside 2026-03'));
    },
  );

  it.each<{ label: string; month: MaxFinMonth; date: string }>([
    { label: 'April 31st', month: { year: 2026, month: 4 }, date: '2026-04-31' },
    { label: 'February 29th of a common year', month: { year: 2026, month: 2 }, date: '2026-02-29' },
    { label: 'March 32nd', month: MARCH, date: '2026-03-32' },
    { label: 'day zero', month: MARCH, date: '2026-03-00' },
  ])('rejects $label, which is not a real calendar day', ({ month, date }) => {
    expect(() => validateConfirmRows([rowIn(month, date)], month)).toThrow(isBadRequest('Invalid date'));
  });

  it.each(['2026-03-1', '2026-03-01T00:00:00.000Z', '2026-03-ab'])(
    'rejects the date %s, which is not in the YYYY-MM-DD format',
    (date) => {
      expect(() => validateConfirmRows([rowIn(MARCH, date)], MARCH)).toThrow(isBadRequest('Invalid date'));
    },
  );

  it('accepts the last day of the month and the leap day of a leap year', () => {
    const lastOfMarch = rowIn(MARCH, '2026-03-31');
    const leapDay = rowIn({ year: 2024, month: 2 }, '2024-02-29');

    expect(validateConfirmRows([lastOfMarch], MARCH).map((r) => r.date)).toEqual(['2026-03-31']);
    expect(validateConfirmRows([leapDay], { year: 2024, month: 2 }).map((r) => r.date)).toEqual(['2024-02-29']);
  });

  it('returns the valid rows in order', () => {
    const rows = [
      makeConfirmRow({ section: 'income' }),
      makeConfirmRow({ section: 'bills' }),
      makeConfirmRow({ section: 'credit' }),
    ];

    expect(validateConfirmRows(rows, MARCH).map((r) => r.sourceRef)).toEqual(rows.map((r) => r.sourceRef));
  });

  it('recomputes the futureCount of a tampered installment row', () => {
    const row = makeLojaARow(3, 0, { installment: { ...makeInstallment('Loja A', 3, 10), futureCount: 9999 } });

    const [validated] = validateConfirmRows([row], MARCH);

    expect(validated?.installment?.futureCount).toBe(7);
  });

  it('rejects a row with an invalid installment, naming the row', () => {
    const row = makeLojaARow(11, 0, { installment: { ...makeInstallment('Loja A', 3, 10), number: 11 } });

    expect(() => validateConfirmRows([row], MARCH)).toThrow(isBadRequest(`Row ${REF.lojaA}: invalid installment 11/10`));
  });
});

describe('sanitizeInstallment', () => {
  const ROW_REF = REF.lojaA;

  it('passes a missing installment through as null', () => {
    expect(sanitizeInstallment(null, ROW_REF)).toBeNull();
  });

  it.each([9999, 0, -4])('recomputes a tampered futureCount of %s as total - (number + prepaid)', (tampered) => {
    const installment = { ...makeInstallment('Loja A', 3, 10), futureCount: tampered };

    expect(sanitizeInstallment(installment, ROW_REF)?.futureCount).toBe(7);
  });

  it('subtracts the prepaid installments when recomputing futureCount', () => {
    const settled = { ...makeInstallment('Curso B', 5, 12, 7), futureCount: 99 };
    const partial = { ...makeInstallment('Remédios', 1, 4, 1), futureCount: 99 };

    expect(sanitizeInstallment(settled, ROW_REF)?.futureCount).toBe(0);
    expect(sanitizeInstallment(partial, ROW_REF)?.futureCount).toBe(2);
  });

  it('keeps the other fields and does not mutate its input', () => {
    const installment = { ...makeInstallment('Loja A', 3, 10), futureCount: 5 };

    const sanitized = sanitizeInstallment(installment, ROW_REF);

    expect(sanitized).toEqual({ ...installment, futureCount: 7 });
    expect(installment.futureCount).toBe(5);
  });

  it('accepts the largest plan (99) and an empty slug', () => {
    const largest = { ...makeInstallment('x', 1, 99), installmentId: 'maxfin:x:99' };
    const emptySlug = { ...makeInstallment('x', 1, 10), installmentId: 'maxfin::10' };

    expect(sanitizeInstallment(largest, ROW_REF)?.futureCount).toBe(98);
    expect(sanitizeInstallment(emptySlug, ROW_REF)?.futureCount).toBe(9);
  });

  const valid = makeInstallment('Loja A', 3, 10);
  it.each<{ label: string; installment: MaxFinInstallment }>([
    { label: 'a number above the total (11/10)', installment: { ...valid, number: 11 } },
    { label: 'number plus prepaid above the total (5/10 +6)', installment: { ...valid, number: 5, prepaid: 6 } },
    { label: 'a total above 99', installment: { ...valid, total: 100, installmentId: 'maxfin:loja-a:100' } },
    { label: 'a number below 1', installment: { ...valid, number: 0 } },
    { label: 'a negative prepaid', installment: { ...valid, prepaid: -1 } },
    { label: 'a fractional number', installment: { ...valid, number: 2.5 } },
    { label: 'a fractional total', installment: { ...valid, total: 10.5, installmentId: 'maxfin:loja-a:10.5' } },
    { label: 'a fractional prepaid', installment: { ...valid, prepaid: 0.5 } },
    { label: 'an installmentId for another total', installment: { ...valid, installmentId: 'maxfin:loja-a:12' } },
    { label: 'an installmentId without the maxfin prefix', installment: { ...valid, installmentId: 'loja-a:10' } },
    { label: 'an installmentId with an invalid slug', installment: { ...valid, installmentId: 'maxfin:Loja A:10' } },
    { label: 'an installmentId with a trailing segment', installment: { ...valid, installmentId: 'maxfin:loja-a:10:x' } },
  ])('rejects $label', ({ installment }) => {
    expect(() => sanitizeInstallment(installment, ROW_REF)).toThrow(isBadRequest(`Row ${ROW_REF}: invalid installment`));
  });
});

// ---------------------------------------------------------------------------
// C. confirmMaxFinImport
// ---------------------------------------------------------------------------

describe('confirmMaxFinImport: rows already stored', () => {
  it('skips a row whose sourceRef is already stored, creating and deleting nothing', async () => {
    const row = makeConfirmRow({ section: 'debit', sourceRef: REF.padaria });
    useStore([{ id: 'old-1', sourceRef: REF.padaria, accountId: 'acc-debit' }]);

    const result = await confirm([row]);

    expect(result).toMatchObject({
      imported: 0,
      skipped: 1,
      replaced: 0,
      consumedFutureInstallments: 0,
      futureInstallments: 0,
      ids: [],
    });
    expect(db.createTransaction).not.toHaveBeenCalled();
    expect(db.deleteTransaction).not.toHaveBeenCalled();
  });

  it('never brings back a row the card OFX import merged into another transaction, not even when replacing', async () => {
    const merged = makeConfirmRow({ section: 'debit', sourceRef: REF.padaria, replace: true });
    db.externalRefFindMany.mockResolvedValue([{ ref: REF.padaria, transactionId: 'kept-1' }]);

    const result = await confirm([merged]);

    expect(result).toMatchObject({ imported: 0, skipped: 1, replaced: 0, ids: [] });
    expect(db.createTransaction).not.toHaveBeenCalled();
    expect(db.deleteTransaction).not.toHaveBeenCalled();
  });

  it('never brings back a row the card review deleted (tombstone), even when replacing', async () => {
    const row = makeConfirmRow({ section: 'debit', sourceRef: REF.padaria, replace: true });
    db.externalRefFindMany.mockResolvedValue([{ ref: `deleted:${REF.padaria}`, transactionId: 'anchor-1' }]);

    const result = await confirm([row]);

    expect(result).toMatchObject({ imported: 0, skipped: 1, replaced: 0 });
    expect(db.createTransaction).not.toHaveBeenCalled();
    expect(db.deleteTransaction).not.toHaveBeenCalled();
  });

  it('refuses to replace the row that absorbed others, warning and deleting nothing', async () => {
    const row = makeConfirmRow({ section: 'debit', sourceRef: REF.padaria, replace: true });
    useStore([{ id: 'kept-1', sourceRef: REF.padaria, accountId: 'acc-debit' }]);
    db.externalRefFindMany.mockResolvedValue([{ ref: 'maxfin:2026-10:credit:99', transactionId: 'kept-1' }]);

    const result = await confirm([row]);

    expect(result).toMatchObject({ imported: 0, skipped: 1, replaced: 0 });
    expect(result.warnings.some((w) => w.includes('absorveu'))).toBe(true);
    expect(db.deleteTransaction).not.toHaveBeenCalled();
    expect(db.createTransaction).not.toHaveBeenCalled();
  });

  it('imports the rows that are not stored and skips only the stored ones', async () => {
    const stored = makeConfirmRow({ sourceRef: REF.padaria });
    const fresh = makeConfirmRow({ sourceRef: REF.luz });
    useStore([{ id: 'old-1', sourceRef: REF.padaria, accountId: 'acc-debit' }]);

    const result = await confirm([stored, fresh]);

    expect(result).toMatchObject({ imported: 1, skipped: 1, ids: ['tx-1'] });
    expect(createdInputs().map((input) => input.sourceRef)).toEqual([REF.luz]);
  });

  it('with replace, deletes the stored row first and only then creates the new one', async () => {
    const row = makeConfirmRow({ sourceRef: REF.padaria, amount: 40, replace: true });
    useStore([{ id: 'old-1', sourceRef: REF.padaria, accountId: 'acc-debit' }]);

    const result = await confirm([row]);

    expect(db.deleteTransaction).toHaveBeenCalledTimes(1);
    expect(db.deleteTransaction).toHaveBeenCalledWith('old-1', HOUSEHOLD);
    expect(db.createTransaction).toHaveBeenCalledTimes(1);
    expect(callOrder(db.deleteTransaction)).toBeLessThan(callOrder(db.createTransaction));
    expect(createdInputs()[0]).toMatchObject({ sourceRef: REF.padaria, amount: 40 });
    expect(result).toMatchObject({ replaced: 1, imported: 0, skipped: 0, ids: ['tx-1'] });
  });

  it('ignores a stored row of another household that has the same sourceRef', async () => {
    const row = makeConfirmRow({ sourceRef: REF.padaria, replace: true });
    useStore([{ id: 'foreign-1', householdId: 'hh-2', sourceRef: REF.padaria, accountId: 'acc-debit' }]);

    const result = await confirm([row]);

    expect(result).toMatchObject({ imported: 1, skipped: 0, replaced: 0 });
    expect(db.deleteTransaction).not.toHaveBeenCalled();
  });

  it('deletes nothing when replace is set on a row that supersedes nothing', async () => {
    const row = makeConfirmRow({ section: 'debit', description: 'Pix Padaria', amount: 35, replace: true });
    // A manual twin (same account, amount and description, no sourceRef) is not what replace may delete.
    useStore([{ id: 'manual-1', sourceRef: null, accountId: 'acc-debit', amount: 35, description: 'Pix Padaria' }]);

    const result = await confirm([row]);

    expect(db.deleteTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ imported: 1, replaced: 0 });
  });
});

describe('confirmMaxFinImport: a value whose sign flipped since the last import', () => {
  const refund = () =>
    makeConfirmRow({ section: 'credit', type: 'INCOME', sourceRef: REF.refund, description: 'Estorno Loja A', amount: 156 });

  it('skips the row without replace, like any other stored row', async () => {
    useStore([{ id: 'old-refund', sourceRef: REF.refund, amount: 156, type: 'EXPENSE' }]);

    const result = await confirm([refund()]);

    expect(result).toMatchObject({ imported: 0, skipped: 1, replaced: 0 });
    expect(db.deleteTransaction).not.toHaveBeenCalled();
    expect(db.createTransaction).not.toHaveBeenCalled();
  });

  it('with replace, deletes the stored expense and creates the credit in its place', async () => {
    useStore([{ id: 'old-refund', sourceRef: REF.refund, amount: 156, type: 'EXPENSE' }]);

    const result = await confirm([{ ...refund(), replace: true }]);

    expect(db.deleteTransaction).toHaveBeenCalledWith('old-refund', HOUSEHOLD);
    expect(callOrder(db.deleteTransaction)).toBeLessThan(callOrder(db.createTransaction));
    expect(createdInputs()).toEqual([
      expect.objectContaining({ sourceRef: REF.refund, type: 'INCOME', amount: 156, accountId: 'acc-credit' }),
    ]);
    expect(result).toMatchObject({ imported: 0, replaced: 1, skipped: 0 });
  });
});

describe('confirmMaxFinImport: failures while creating a row', () => {
  it('counts a unique violation as skipped, with no further effect for that row', async () => {
    const installmentRow = makeLojaARow(3);
    const next = makeConfirmRow({ sourceRef: REF.padaria });
    failCreateFor(installmentRow.sourceRef, uniqueViolation());

    const result = await confirm([installmentRow, next], { options: OPEN_WITH_FUTURES });

    expect(result).toMatchObject({ imported: 1, skipped: 1, futureInstallments: 0, ids: ['tx-1'] });
    // Two attempts only: the row that lost the race generates no future installments.
    expect(createdInputs().map((input) => input.sourceRef)).toEqual([installmentRow.sourceRef, REF.padaria]);
  });

  it('rethrows any other creation error and stops there', async () => {
    const failure = Object.assign(new Error('foreign key violation'), { code: 'P2003' });
    const failing = makeConfirmRow({ sourceRef: REF.padaria });
    const next = makeConfirmRow({ sourceRef: REF.luz });
    failCreateFor(failing.sourceRef, failure);

    await expect(confirm([failing, next])).rejects.toBe(failure);

    expect(db.createTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('confirmMaxFinImport: category map validation', () => {
  it.each<{ label: string; entry: MaxFinCategoryMapInput }>([
    {
      label: 'an income category for an expense key',
      entry: { key: 'Salário', type: 'EXPENSE', target: { kind: 'system', categoryName: CategoryName.SALARY } },
    },
    {
      label: 'an expense category for an income key',
      entry: { key: 'Mercado', type: 'INCOME', target: { kind: 'system', categoryName: CategoryName.FOOD } },
    },
    {
      label: 'a pseudo-category such as TRANSFER',
      entry: { key: 'Pix', type: 'EXPENSE', target: { kind: 'system', categoryName: CategoryName.TRANSFER } },
    },
    {
      label: 'an unknown category name',
      entry: { key: 'Pix', type: 'EXPENSE', target: { kind: 'system', categoryName: 'NOT_A_CATEGORY' } },
    },
  ])('rejects $label as a system target, before any write', async ({ entry }) => {
    await expect(confirm([makeConfirmRow()], { categoryMap: [entry] })).rejects.toEqual(
      isBadRequest(/is not a (INCOME|EXPENSE) system category/),
    );

    expectNoWrites();
  });

  describe('custom targets', () => {
    beforeEach(() => {
      useCategories([
        { id: 'cat-own', name: 'Pets', type: 'EXPENSE' },
        { id: 'cat-income', name: 'Bônus', type: 'INCOME' },
        { id: 'cat-foreign', name: 'Pets', type: 'EXPENSE', householdId: 'hh-2' },
      ]);
    });

    it.each([
      { label: 'a category of another household', categoryId: 'cat-foreign' },
      { label: 'an unknown category id', categoryId: 'cat-missing' },
      { label: 'a category of the other type', categoryId: 'cat-income' },
    ])('rejects $label as a custom target, before any write', async ({ categoryId }) => {
      const entry: MaxFinCategoryMapInput = { key: 'Pets', type: 'EXPENSE', target: { kind: 'custom', categoryId } };

      await expect(confirm([makeConfirmRow()], { categoryMap: [entry] })).rejects.toEqual(
        isBadRequest(`Custom category ${categoryId} not found`),
      );

      expectNoWrites();
    });

    it('reads the custom categories of the import household only', async () => {
      await confirm([makeConfirmRow()]);

      expect(db.categoryFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { householdId: HOUSEHOLD } }));
    });
  });

  it('rejects a new category with a blank name, before any write', async () => {
    const entry: MaxFinCategoryMapInput = { key: 'Casa', type: 'EXPENSE', target: { kind: 'create', name: '   ' } };

    await expect(confirm([makeConfirmRow()], { categoryMap: [entry] })).rejects.toEqual(isBadRequest('Empty name'));

    expectNoWrites();
  });

  // confirmMaxFinImport promises that "everything the client sends is checked before the first write", and
  // creating a category is a write: an invalid entry must stop the request before any category is created.
  // Regression guard: the resolver validates the whole map first and creates categories in a second pass.
  it('validates every category target before creating any category', async () => {
    const categoryMap: MaxFinCategoryMapInput[] = [
      { key: 'Casa', type: 'EXPENSE', target: { kind: 'create', name: 'Casa' } },
      { key: 'Salário', type: 'EXPENSE', target: { kind: 'system', categoryName: CategoryName.SALARY } },
    ];

    await expect(confirm([makeConfirmRow()], { categoryMap })).rejects.toEqual(isBadRequest('system category'));

    expectNoWrites();
  });
});

describe('confirmMaxFinImport: category map resolution', () => {
  it('creates each distinct (type, normalised name) once and stores CUSTOM:<new id> on the transactions', async () => {
    const categoryMap: MaxFinCategoryMapInput[] = [
      { key: 'Casa', type: 'EXPENSE', target: { kind: 'create', name: 'Casa' } },
      { key: 'Moradia extra', type: 'EXPENSE', target: { kind: 'create', name: '  casa ' } },
      { key: 'Casa', type: 'INCOME', target: { kind: 'create', name: 'Casa' } },
    ];
    const rows = [
      makeConfirmRow({ section: 'debit', categoryKey: 'CASA ' }),
      makeConfirmRow({ section: 'credit', categoryKey: 'Moradia extra' }),
      makeConfirmRow({ section: 'income', categoryKey: 'Casa' }),
    ];

    const result = await confirm(rows, { categoryMap });

    expect(db.createCategory).toHaveBeenCalledTimes(2);
    expect(db.createCategory).toHaveBeenNthCalledWith(1, { householdId: HOUSEHOLD, name: 'Casa', type: 'EXPENSE' });
    expect(db.createCategory).toHaveBeenNthCalledWith(2, { householdId: HOUSEHOLD, name: 'Casa', type: 'INCOME' });
    expect(createdInputs().map((input) => input.categoryName)).toEqual([
      'CUSTOM:cat-new-1',
      'CUSTOM:cat-new-1',
      'CUSTOM:cat-new-2',
    ]);
    expect(result.createdCategories).toEqual([
      { id: 'cat-new-1', name: 'Casa', type: 'EXPENSE' },
      { id: 'cat-new-2', name: 'Casa', type: 'INCOME' },
    ]);
  });

  it('reuses an existing custom category of the same normalised name instead of creating it', async () => {
    useCategories([{ id: 'cat-existing', name: 'CASA', type: 'EXPENSE' }]);
    const categoryMap: MaxFinCategoryMapInput[] = [
      { key: 'Casa', type: 'EXPENSE', target: { kind: 'create', name: 'casa' } },
    ];

    const result = await confirm([makeConfirmRow({ categoryKey: 'Casa' })], { categoryMap });

    expect(db.createCategory).not.toHaveBeenCalled();
    expect(createdInputs()[0]).toMatchObject({ categoryName: 'CUSTOM:cat-existing' });
    expect(result.createdCategories).toEqual([]);
  });

  it('maps system and custom targets to the category name stored on the transaction', async () => {
    useCategories([{ id: 'cat-own', name: 'Pets', type: 'EXPENSE' }]);
    const categoryMap: MaxFinCategoryMapInput[] = [
      { key: 'Saúde', type: 'EXPENSE', target: { kind: 'system', categoryName: CategoryName.HEALTHCARE } },
      { key: 'Pets', type: 'EXPENSE', target: { kind: 'custom', categoryId: 'cat-own' } },
      { key: 'Salário', type: 'INCOME', target: { kind: 'system', categoryName: CategoryName.SALARY } },
    ];
    const rows = [
      makeConfirmRow({ categoryKey: 'SAÚDE' }),
      makeConfirmRow({ categoryKey: 'pets' }),
      makeConfirmRow({ section: 'income', categoryKey: 'Salario' }),
    ];

    await confirm(rows, { categoryMap });

    expect(createdInputs().map((input) => input.categoryName)).toEqual(['HEALTHCARE', 'CUSTOM:cat-own', 'SALARY']);
    expect(db.createCategory).not.toHaveBeenCalled();
  });

  it('maps an empty category key to OTHER_EXPENSES or OTHER_INCOME by default', async () => {
    const rows = [makeConfirmRow({ categoryKey: '' }), makeConfirmRow({ section: 'income', categoryKey: '' })];

    await confirm(rows);

    expect(createdInputs().map((input) => input.categoryName)).toEqual(['OTHER_EXPENSES', 'OTHER_INCOME']);
  });

  it('falls back to the default category for a default target and for a key missing from the map', async () => {
    const categoryMap: MaxFinCategoryMapInput[] = [{ key: 'Diversos', type: 'EXPENSE', target: { kind: 'default' } }];
    const rows = [makeConfirmRow({ categoryKey: 'Diversos' }), makeConfirmRow({ categoryKey: 'Sem mapa' })];

    await confirm(rows, { categoryMap });

    expect(createdInputs().map((input) => input.categoryName)).toEqual(['OTHER_EXPENSES', 'OTHER_EXPENSES']);
  });
});

describe('confirmMaxFinImport: created transactions', () => {
  it('creates income, bills and debit rows as paid in a closed month, whatever the sheet says', async () => {
    const rows = [
      makeConfirmRow({ section: 'income', paid: false }),
      makeConfirmRow({ section: 'bills', paid: false }),
      makeConfirmRow({ section: 'debit', paid: false }),
    ];

    await confirm(rows, { options: CLOSED });

    expect(createdInputs().map((input) => input.paid)).toEqual([true, true, true]);
  });

  it('creates credit rows as paid even when the row says otherwise', async () => {
    await confirm([makeConfirmRow({ section: 'credit', paid: false })], { options: OPEN });

    expect(createdInputs()[0]).toMatchObject({ paid: true });
  });

  it('keeps the sheet paid flag of income, bills and debit rows in an open month', async () => {
    const rows = [
      makeConfirmRow({ section: 'income', paid: false }),
      makeConfirmRow({ section: 'bills', paid: false }),
      makeConfirmRow({ section: 'debit', paid: true }),
    ];

    await confirm(rows, { options: OPEN });

    expect(createdInputs().map((input) => input.paid)).toEqual([false, false, true]);
  });

  it('sends each row to the account of its section, with the type of its section', async () => {
    const rows = [
      makeConfirmRow({ section: 'income' }),
      makeConfirmRow({ section: 'bills' }),
      makeConfirmRow({ section: 'credit' }),
      makeConfirmRow({ section: 'debit' }),
    ];

    await confirm(rows);

    expect(createdInputs().map((input) => [input.accountId, input.type])).toEqual([
      ['acc-income', 'INCOME'],
      ['acc-bills', 'EXPENSE'],
      ['acc-credit', 'EXPENSE'],
      ['acc-debit', 'EXPENSE'],
    ]);
  });

  it('creates the transaction with exactly the fields derived from the row', async () => {
    const row = makeConfirmRow({
      section: 'bills',
      sourceRef: REF.rent,
      description: 'Aluguel',
      categoryKey: 'Moradia',
      amount: 1300,
      paid: false,
    });
    const categoryMap: MaxFinCategoryMapInput[] = [
      { key: 'Moradia', type: 'EXPENSE', target: { kind: 'system', categoryName: CategoryName.HOUSING } },
    ];

    await confirm([row], { categoryMap });

    expect(createdInputs()[0]).toEqual({
      householdId: HOUSEHOLD,
      accountId: 'acc-bills',
      type: 'EXPENSE',
      categoryName: 'HOUSING',
      amount: 1300,
      description: 'Aluguel',
      date: new Date(2026, 2, 1),
      paid: false,
      isSplit: false,
      sourceRef: REF.rent,
    });
  });

  it('adds the installment fields to an installment row', async () => {
    await confirm([makeLojaARow(3)]);

    expect(createdInputs()[0]).toMatchObject({
      description: 'Loja A 3/10',
      installmentId: PLAN_LOJA_A,
      installmentNumber: 3,
      totalInstallments: 10,
    });
  });

  it('keeps the notes and cuts the description and the notes to the column limits', async () => {
    const withNotes = makeConfirmRow({ description: 'd'.repeat(300), notes: 'n'.repeat(1200) });
    const withoutNotes = makeConfirmRow({ notes: null });

    await confirm([withNotes, withoutNotes]);

    const [first, second] = createdInputs();
    expect(first?.description).toHaveLength(255);
    expect(first?.notes).toHaveLength(1000);
    expect(second).not.toHaveProperty('notes');
  });

  it('forwards the user id to every createTransaction call', async () => {
    await confirm([makeConfirmRow(), makeConfirmRow()]);

    expect(db.createTransaction).toHaveBeenCalledTimes(2);
    for (const call of db.createTransaction.mock.calls) expect(call[1]).toBe('user-1');
  });
});

describe('confirmMaxFinImport: future installments', () => {
  it('creates the remaining installments of a credit row, one per following month', async () => {
    const categoryMap: MaxFinCategoryMapInput[] = [
      { key: 'Compras', type: 'EXPENSE', target: { kind: 'system', categoryName: CategoryName.ONLINE_SHOPPING } },
    ];

    const result = await confirm([makeLojaARow(3)], { options: OPEN_WITH_FUTURES, categoryMap });

    const [base, ...futures] = createdInputs();
    expect(base).toMatchObject({ sourceRef: REF.lojaA, installmentNumber: 3 });
    expect(futures.map((f) => f.installmentNumber)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(futures.map((f) => f.sourceRef)).toEqual([1, 2, 3, 4, 5, 6, 7].map((i) => `${REF.lojaA}:f${i}`));
    // Day 01 of April..October 2026, local midnight.
    expect(futures.map((f) => f.date)).toEqual([3, 4, 5, 6, 7, 8, 9].map((monthIndex) => new Date(2026, monthIndex, 1)));
    expect(futures.every((f) => f.paid === true)).toBe(true);
    expect(futures.every((f) => f.installmentId === PLAN_LOJA_A && f.totalInstallments === 10)).toBe(true);
    expect(futures[0]).toMatchObject({
      householdId: HOUSEHOLD,
      accountId: 'acc-credit',
      type: 'EXPENSE',
      categoryName: 'ONLINE_SHOPPING',
      amount: 90,
      description: 'Loja A 4/10',
      isSplit: false,
    });
    expect(result).toMatchObject({ imported: 1, futureInstallments: 7 });
    expect(result.ids).toHaveLength(8);
  });

  it('numbers the future installments after the prepaid ones and estimates their amount', async () => {
    const row = makeConfirmRow({
      section: 'credit',
      sourceRef: REF.remedios,
      description: 'Remédios 1/4 + 1',
      amount: 200,
      installment: makeInstallment('Remédios', 1, 4, 1),
    });

    const result = await confirm([row], { options: OPEN_WITH_FUTURES });

    const futures = createdInputs().slice(1);
    expect(futures.map((f) => [f.installmentNumber, f.sourceRef, f.amount])).toEqual([
      [3, `${REF.remedios}:f1`, 100],
      [4, `${REF.remedios}:f2`, 100],
    ]);
    expect(futures.map((f) => f.date)).toEqual([new Date(2026, 3, 1), new Date(2026, 4, 1)]);
    expect(result.futureInstallments).toBe(2);
  });

  it('creates none in a closed month, even if generateFutureInstallments is on', async () => {
    const options: MaxFinImportOptions = { closedMonth: true, payInvoice: false, generateFutureInstallments: true };

    const result = await confirm([makeLojaARow(3)], { options });

    expect(result.futureInstallments).toBe(0);
    expect(db.createTransaction).toHaveBeenCalledTimes(1);
  });

  it('creates none when generateFutureInstallments is off', async () => {
    const result = await confirm([makeLojaARow(3)], { options: OPEN });

    expect(result.futureInstallments).toBe(0);
    expect(db.createTransaction).toHaveBeenCalledTimes(1);
  });

  it('skips the numbers that are already stored for the plan', async () => {
    useStore([
      { id: 'manual-4', installmentId: PLAN_LOJA_A, installmentNumber: 4 },
      { id: 'manual-5', installmentId: PLAN_LOJA_A, installmentNumber: 5 },
    ]);

    const result = await confirm([makeLojaARow(3)], { options: OPEN_WITH_FUTURES });

    const futures = createdInputs().slice(1);
    expect(futures.map((f) => f.installmentNumber)).toEqual([6, 7, 8, 9, 10]);
    expect(futures.map((f) => f.sourceRef)).toEqual([3, 4, 5, 6, 7].map((i) => `${REF.lojaA}:f${i}`));
    expect(result.futureInstallments).toBe(5);
  });

  it('reads the stored plan of the import household and card only', async () => {
    useStore([
      { id: 'other-card-4', accountId: 'acc-other-card', installmentId: PLAN_LOJA_A, installmentNumber: 4 },
      { id: 'other-household-5', householdId: 'hh-2', installmentId: PLAN_LOJA_A, installmentNumber: 5 },
    ]);

    const result = await confirm([makeLojaARow(3)], { options: OPEN_WITH_FUTURES });

    expect(result.futureInstallments).toBe(7);
  });

  it.each([9999, 0, -4])('ignores a tampered futureCount of %s and derives the count from the plan', async (tampered) => {
    const row = makeLojaARow(3, 0, { installment: { ...makeInstallment('Loja A', 3, 10), futureCount: tampered } });

    const result = await confirm([row], { options: OPEN_WITH_FUTURES });

    expect(result.futureInstallments).toBe(7);
    expect(db.createTransaction).toHaveBeenCalledTimes(8);
  });

  it('creates none for a row that was skipped as already imported', async () => {
    useStore([{ id: 'old-1', sourceRef: REF.lojaA, installmentId: PLAN_LOJA_A, installmentNumber: 3 }]);

    const result = await confirm([makeLojaARow(3)], { options: OPEN_WITH_FUTURES });

    expect(result).toMatchObject({ imported: 0, skipped: 1, futureInstallments: 0 });
    expect(db.createTransaction).not.toHaveBeenCalled();
  });

  it('does not repeat a number across two rows of the same plan in one request', async () => {
    const first = makeLojaARow(3);
    const second = makeLojaARow(3, 0, { sourceRef: 'maxfin:2026-03:credit:40' });

    const result = await confirm([first, second], { options: OPEN_WITH_FUTURES });

    expect(result).toMatchObject({ imported: 2, futureInstallments: 7 });
    expect(db.createTransaction).toHaveBeenCalledTimes(9);
  });

  it('skips a future installment that hits a unique violation and still creates the others', async () => {
    failCreateFor(`${REF.lojaA}:f3`, uniqueViolation());

    const result = await confirm([makeLojaARow(3)], { options: OPEN_WITH_FUTURES });

    expect(result.futureInstallments).toBe(6);
    expect(db.createTransaction).toHaveBeenCalledTimes(8);
    expect(result.ids).toHaveLength(7);
  });

  it('rethrows any other error raised while creating a future installment', async () => {
    const failure = new Error('database is down');
    failCreateFor(`${REF.lojaA}:f2`, failure);

    await expect(confirm([makeLojaARow(3)], { options: OPEN_WITH_FUTURES })).rejects.toBe(failure);
  });
});

describe('confirmMaxFinImport: generated future installments superseded by a later sheet', () => {
  // The February sheet (open at the time) generated 4/10..10/10 of Loja A; March now says 4/10.
  const generatedPlan = () => [4, 5, 6, 7, 8, 9, 10].map((number) => generatedInstallment(number));

  it('skips the row with a warning that names it, unless replace is set', async () => {
    useStore(generatedPlan());

    const result = await confirm([makeLojaARow(4)], { options: OPEN_WITH_FUTURES });

    expect(result).toMatchObject({ imported: 0, skipped: 1, consumedFutureInstallments: 0, ids: [] });
    expect(result.warnings).toEqual([expect.stringContaining('Loja A 4/10')]);
    expect(db.deleteTransaction).not.toHaveBeenCalled();
    expect(db.createTransaction).not.toHaveBeenCalled();
  });

  it('never deletes a generated installment the card statement consumed, even with replace: the row is skipped with a warning', async () => {
    useStore(generatedPlan());
    db.externalRefFindMany.mockResolvedValue([{ ref: 'ofx:abc:11111111', transactionId: 'ph-4' }]);

    const result = await confirm([makeLojaARow(4, 0, { replace: true })], { options: OPEN_WITH_FUTURES });

    expect(result).toMatchObject({ imported: 0, skipped: 1, consumedFutureInstallments: 0 });
    expect(result.warnings).toEqual([expect.stringContaining('parcela futura consumida')]);
    expect(db.deleteTransaction).not.toHaveBeenCalled();
    expect(db.createTransaction).not.toHaveBeenCalled();
  });

  it('with replace, deletes the generated installment it supersedes and then creates the real row', async () => {
    useStore(generatedPlan());

    const result = await confirm([makeLojaARow(4, 0, { replace: true })], { options: OPEN_WITH_FUTURES });

    expect(db.deleteTransaction).toHaveBeenCalledTimes(1);
    expect(db.deleteTransaction).toHaveBeenCalledWith('ph-4', HOUSEHOLD);
    expect(db.createTransaction).toHaveBeenCalledTimes(1);
    expect(callOrder(db.deleteTransaction)).toBeLessThan(callOrder(db.createTransaction));
    expect(createdInputs()[0]).toMatchObject({ sourceRef: REF.lojaA, installmentNumber: 4 });
    // 5/10..10/10 are already stored as generated installments, so none is created again.
    expect(result).toMatchObject({
      imported: 1,
      replaced: 0,
      skipped: 0,
      consumedFutureInstallments: 1,
      futureInstallments: 0,
    });
  });

  it('deletes only the generated installments covered by the row (N..N+K)', async () => {
    useStore([4, 5, 6].map((number) => generatedInstallment(number)));

    const result = await confirm([makeLojaARow(4, 1, { replace: true })], { options: OPEN });

    expect(db.deleteTransaction).toHaveBeenCalledTimes(2);
    expect(db.deleteTransaction).toHaveBeenNthCalledWith(1, 'ph-4', HOUSEHOLD);
    expect(db.deleteTransaction).toHaveBeenNthCalledWith(2, 'ph-5', HOUSEHOLD);
    expect(result.consumedFutureInstallments).toBe(2);
  });

  it('never deletes rows of another household, card or plan, nor rows that are not generated installments', async () => {
    useStore([
      generatedInstallment(4),
      generatedInstallment(4, { id: 'other-household', householdId: 'hh-2' }),
      generatedInstallment(4, { id: 'other-card', accountId: 'acc-other-card' }),
      generatedInstallment(4, { id: 'other-plan', installmentId: 'maxfin:outra-compra:10' }),
      generatedInstallment(4, { id: 'typed-by-hand', sourceRef: null }),
      // Matches the `:f` lookup but is not a generated reference.
      generatedInstallment(4, { id: 'odd-reference', sourceRef: 'manual:f-note' }),
    ]);

    const result = await confirm([makeLojaARow(4, 0, { replace: true })], { options: OPEN });

    expect(db.deleteTransaction).toHaveBeenCalledTimes(1);
    expect(db.deleteTransaction).toHaveBeenCalledWith('ph-4', HOUSEHOLD);
    expect(result.consumedFutureInstallments).toBe(1);
  });

  it('does not look for generated installments when the row is not a credit installment', async () => {
    useStore(generatedPlan());
    const bills = makeConfirmRow({ section: 'bills', replace: true, installment: makeInstallment('Loja A', 4, 10) });

    const result = await confirm([bills], { options: OPEN });

    expect(db.deleteTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ imported: 1, consumedFutureInstallments: 0 });
  });
});

describe('confirmMaxFinImport: invoice payment', () => {
  const creditRow = (line: number, amount: number) =>
    makeConfirmRow({ section: 'credit', sourceRef: `maxfin:2026-03:credit:${line}`, amount });

  it('pays the invoice once, with the sum of the credit rows created in this call', async () => {
    const rows = [
      creditRow(16, 100.1),
      creditRow(17, 50.2),
      makeConfirmRow({ section: 'bills', sourceRef: REF.rent, amount: 1300 }),
    ];

    const result = await confirm(rows, { options: CLOSED_WITH_INVOICE });

    expect(db.payCreditCardInvoice).toHaveBeenCalledTimes(1);
    expect(db.payCreditCardInvoice).toHaveBeenCalledWith({
      householdId: HOUSEHOLD,
      accountId: 'acc-credit',
      sourceAccountId: 'acc-bills',
      month: '2026-03',
      amount: 150.3,
      paymentDate: new Date(2026, 2, 9),
      description: expect.stringContaining('03/2026'),
    });
    expect(result.invoicePayment).toEqual({ transactionId: 'pay-1', amount: 150.3, date: '2026-03-09' });
    expect(result.warnings).toEqual([]);
  });

  it('leaves out of the amount a credit row that was skipped as already imported', async () => {
    useStore([{ id: 'old-16', sourceRef: 'maxfin:2026-03:credit:16' }]);

    const result = await confirm([creditRow(16, 100), creditRow(17, 50)], { options: CLOSED_WITH_INVOICE });

    expect(result).toMatchObject({ imported: 1, skipped: 1 });
    expect(db.payCreditCardInvoice).toHaveBeenCalledWith(expect.objectContaining({ amount: 50 }));
    expect(result.invoicePayment).toMatchObject({ amount: 50 });
  });

  it('leaves out of the amount a credit row that lost a race to a unique violation', async () => {
    failCreateFor('maxfin:2026-03:credit:16', uniqueViolation());

    const result = await confirm([creditRow(16, 100), creditRow(17, 50)], { options: CLOSED_WITH_INVOICE });

    expect(result).toMatchObject({ imported: 1, skipped: 1 });
    expect(db.payCreditCardInvoice).toHaveBeenCalledWith(expect.objectContaining({ amount: 50 }));
  });

  it('includes a replaced credit row in the amount', async () => {
    useStore([{ id: 'old-16', sourceRef: 'maxfin:2026-03:credit:16' }]);
    const replaced = makeConfirmRow({ section: 'credit', sourceRef: 'maxfin:2026-03:credit:16', amount: 120, replace: true });

    const result = await confirm([replaced, creditRow(17, 50)], { options: CLOSED_WITH_INVOICE });

    expect(result).toMatchObject({ imported: 1, replaced: 1 });
    expect(db.payCreditCardInvoice).toHaveBeenCalledWith(expect.objectContaining({ amount: 170 }));
  });

  it('pays on the last day of the month when the card has no due day', async () => {
    const resolved = makeAccounts({ credit: { dueDay: null } });

    await confirm([creditRow(16, 100)], { options: CLOSED_WITH_INVOICE, resolved });

    expect(db.payCreditCardInvoice).toHaveBeenCalledWith(expect.objectContaining({ paymentDate: new Date(2026, 2, 31) }));
  });

  it('does not pay in an open month', async () => {
    const options: MaxFinImportOptions = { closedMonth: false, payInvoice: true, generateFutureInstallments: false };

    const result = await confirm([creditRow(16, 100)], { options });

    expect(db.payCreditCardInvoice).not.toHaveBeenCalled();
    expect(result).toMatchObject({ invoicePayment: null, warnings: [] });
  });

  it('does not pay when payInvoice is off', async () => {
    const result = await confirm([creditRow(16, 100)], { options: CLOSED });

    expect(db.payCreditCardInvoice).not.toHaveBeenCalled();
    expect(result).toMatchObject({ invoicePayment: null, warnings: [] });
  });

  it('looks the existing payment up under the zero-based month that payCreditCardInvoice uses (January is 0)', async () => {
    const january = makeConfirmRow({
      section: 'credit',
      sourceRef: 'maxfin:2026-01:credit:16',
      date: '2026-01-01',
      amount: 100,
    });

    await confirm([january], { options: CLOSED_WITH_INVOICE, month: { year: 2026, month: 1 } });

    expect(db.transactionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { householdId: HOUSEHOLD, attachmentUrl: 'invoice_pay:acc-credit:2026-0' } }),
    );
    expect(db.payCreditCardInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ month: '2026-01', paymentDate: new Date(2026, 0, 9) }),
    );
  });

  it('does not pay again when a payment with the same technical identifier already exists', async () => {
    db.transactionFindFirst.mockResolvedValue({ id: 'pay-existing' });

    const result = await confirm([creditRow(16, 100)], { options: CLOSED_WITH_INVOICE });

    expect(db.transactionFindFirst).toHaveBeenCalledTimes(1);
    expect(db.transactionFindFirst).toHaveBeenCalledWith({
      where: { householdId: HOUSEHOLD, attachmentUrl: 'invoice_pay:acc-credit:2026-2' },
      select: { id: true },
    });
    expect(db.payCreditCardInvoice).not.toHaveBeenCalled();
    expect(result.invoicePayment).toBeNull();
    expect(result.warnings).toEqual([expect.stringContaining('pay-existing')]);
    expect(result.imported).toBe(1);
  });

  it('does not pay, and says so, when the bills account is another credit card', async () => {
    const resolved = makeAccounts({ bills: { type: AccountType.CREDIT } });

    const result = await confirm([creditRow(16, 100)], { options: CLOSED_WITH_INVOICE, resolved });

    expect(db.payCreditCardInvoice).not.toHaveBeenCalled();
    expect(result.invoicePayment).toBeNull();
    expect(result.warnings).toEqual([expect.stringContaining('contas fixas')]);
    expect(result.imported).toBe(1);
  });

  it('does not pay, and says so, when the bills account is the card itself', async () => {
    const resolved = makeAccounts();
    resolved.bills = { ...resolved.credit };

    const result = await confirm([creditRow(16, 100)], { options: CLOSED_WITH_INVOICE, resolved });

    expect(db.payCreditCardInvoice).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([expect.stringContaining('contas fixas')]);
    expect(result.imported).toBe(1);
  });

  it('does not pay, and says so, when the card account is not a credit account', async () => {
    const resolved = makeAccounts({ credit: { type: AccountType.CHECKING } });

    const result = await confirm([creditRow(16, 100)], { options: CLOSED_WITH_INVOICE, resolved });

    expect(db.payCreditCardInvoice).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([expect.stringContaining('não é do tipo crédito')]);
    expect(result.imported).toBe(1);
  });

  it('does not pay, and says so, when no credit row was created in this call', async () => {
    const rows = [makeConfirmRow({ section: 'bills' }), makeConfirmRow({ section: 'debit' })];

    const result = await confirm(rows, { options: CLOSED_WITH_INVOICE });

    expect(db.payCreditCardInvoice).not.toHaveBeenCalled();
    expect(result.invoicePayment).toBeNull();
    expect(result.warnings).toEqual([expect.stringContaining('nenhuma compra de cartão')]);
    expect(result.imported).toBe(2);
  });

  it('does not pay when every credit row was skipped as already imported', async () => {
    useStore([{ id: 'old-16', sourceRef: 'maxfin:2026-03:credit:16' }]);

    const result = await confirm([creditRow(16, 100)], { options: CLOSED_WITH_INVOICE });

    expect(db.payCreditCardInvoice).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([expect.stringContaining('nenhuma compra de cartão')]);
  });
});

describe('confirmMaxFinImport: credits (negative values in the sheet)', () => {
  const purchase = (line: number, amount: number) =>
    makeConfirmRow({ section: 'credit', sourceRef: `maxfin:2026-03:credit:${line}`, amount, categoryKey: 'Compras' });
  const credit = (line: number, amount: number, overrides: Partial<MaxFinConfirmRow> = {}) =>
    makeConfirmRow({
      section: 'credit',
      type: 'INCOME',
      sourceRef: `maxfin:2026-03:credit:${line}`,
      description: 'Estorno Loja Z',
      categoryKey: 'Compras',
      amount,
      ...overrides,
    });

  it('creates a card credit as INCOME on the card account, paid', async () => {
    await confirm([credit(21, 156)], { options: CLOSED });

    expect(createdInputs()).toEqual([
      expect.objectContaining({
        accountId: 'acc-credit',
        type: 'INCOME',
        amount: 156,
        paid: true,
        categoryName: CategoryName.OTHER_INCOME,
        sourceRef: 'maxfin:2026-03:credit:21',
      }),
    ]);
  });

  it('pays the invoice with the purchases minus the credits created in the call', async () => {
    const result = await confirm([purchase(16, 100.1), credit(21, 30.05)], { options: CLOSED_WITH_INVOICE });

    expect(db.payCreditCardInvoice).toHaveBeenCalledTimes(1);
    expect(db.payCreditCardInvoice).toHaveBeenCalledWith(expect.objectContaining({ amount: 70.05 }));
    expect(result.invoicePayment).toMatchObject({ amount: 70.05 });
    expect(result.warnings).toEqual([]);
  });

  it('records no payment, and says why, when the credits cover the purchases', async () => {
    const result = await confirm([purchase(16, 50), credit(21, 50)], { options: CLOSED_WITH_INVOICE });

    expect(db.payCreditCardInvoice).not.toHaveBeenCalled();
    expect(result.invoicePayment).toBeNull();
    expect(result.warnings).toEqual([expect.stringContaining('cobrem as compras')]);
    expect(result.imported).toBe(2);
  });

  it('generates the future installments of a refund paid back in installments as INCOME', async () => {
    const categoryMap: MaxFinCategoryMapInput[] = [
      { key: 'Compras', type: 'INCOME', target: { kind: 'system', categoryName: CategoryName.SALES } },
    ];
    const row = credit(21, 30, {
      description: 'Estorno Loja Z 1/3',
      installment: makeInstallment('Estorno Loja Z', 1, 3),
    });

    const result = await confirm([row], { options: OPEN_WITH_FUTURES, categoryMap });

    const [base, ...futures] = createdInputs();
    expect(base).toMatchObject({ type: 'INCOME', installmentNumber: 1, categoryName: 'SALES' });
    expect(futures.map((f) => [f.type, f.installmentNumber, f.amount, f.accountId, f.categoryName])).toEqual([
      ['INCOME', 2, 30, 'acc-credit', 'SALES'],
      ['INCOME', 3, 30, 'acc-credit', 'SALES'],
    ]);
    expect(futures.map((f) => f.description)).toEqual(['Estorno Loja Z 2/3', 'Estorno Loja Z 3/3']);
    expect(result.futureInstallments).toBe(2);
  });
});

describe('confirmMaxFinImport: nothing is written for an invalid request', () => {
  const withNewCategory: MaxFinCategoryMapInput[] = [
    { key: 'Casa', type: 'EXPENSE', target: { kind: 'create', name: 'Casa' } },
  ];

  it('rejects a request without rows before any write', async () => {
    await expect(confirm([], { categoryMap: withNewCategory })).rejects.toEqual(isBadRequest('No rows to import'));

    expectNoWrites();
  });

  it('rejects a request with an invalid row before writing the valid rows that precede it', async () => {
    const valid = makeConfirmRow({ section: 'debit' });
    const foreignMonth = makeConfirmRow({ sourceRef: 'maxfin:2026-04:debit:5', date: '2026-04-01' });

    await expect(confirm([valid, foreignMonth], { categoryMap: withNewCategory })).rejects.toEqual(
      isBadRequest('does not belong to month 2026-03'),
    );

    expectNoWrites();
  });

  it('rejects a request with a tampered installment before any write', async () => {
    const valid = makeConfirmRow({ section: 'debit' });
    const tampered = makeLojaARow(3, 0, { installment: { ...makeInstallment('Loja A', 3, 10), total: 100 } });

    await expect(confirm([valid, tampered], { categoryMap: withNewCategory })).rejects.toEqual(
      isBadRequest('invalid installment'),
    );

    expectNoWrites();
  });
});

describe('confirmMaxFinImport: account resolution', () => {
  it('resolves the destination accounts itself when the caller did not', async () => {
    const resolved = makeAccounts();
    db.accountFindMany.mockResolvedValue([resolved.income, resolved.bills, resolved.credit, resolved.debit]);

    const result = await confirmMaxFinImport({
      request: {
        month: MARCH,
        accounts: idsOf(resolved),
        options: OPEN,
        categoryMap: [],
        rows: [makeConfirmRow({ section: 'credit' })],
      },
    });

    expect(db.accountFindMany).toHaveBeenCalledTimes(1);
    expect(createdInputs()[0]).toMatchObject({ householdId: HOUSEHOLD, accountId: 'acc-credit' });
    expect(result.imported).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// D. buildMaxFinPreview
// ---------------------------------------------------------------------------

describe('buildMaxFinPreview on the sample sheet with nothing stored', () => {
  it('lists the 18 readable rows as new', async () => {
    const preview = await previewSample();

    expect(preview.rows).toHaveLength(18);
    expect(preview.rows.every((row) => row.status === 'new')).toBe(true);
    expect(preview.rows.every((row) => row.statusDetail === null && row.existingTransactionId === null)).toBe(true);
    expect(preview.totals).toEqual({ rows: 18, new: 18, duplicate: 0, changed: 0, legacyDuplicate: 0, matchesRecurring: 0, skipped: 4 });
    expect(preview.skipped).toHaveLength(4);
  });

  it('detects the sheet month from its title', async () => {
    const preview = await previewSample();

    expect(preview).toMatchObject({ month: { year: 2026, month: 3 }, monthKey: '2026-03', monthSource: 'title' });
    expect(preview.rows.every((row) => row.sourceRef.startsWith('maxfin:2026-03:'))).toBe(true);
  });

  it('summarises the four sections with their counts and sums', async () => {
    const preview = await previewSample();

    expect(preview.sections.map((s) => [s.key, s.count, s.sum])).toEqual([
      ['income', 2, 6000],
      ['bills', 3, 1549.9],
      ['credit', 11, 1916.5],
      ['debit', 2, 245],
    ]);
    expect(preview.sections.map((s) => s.label)).toEqual(['Entradas', 'Contas fixas', 'Cartão', 'Débito/pix']);
    expect(preview.sections.map((s) => s.accountId)).toEqual(['acc-income', 'acc-bills', 'acc-credit', 'acc-debit']);
    expect(preview.sections.map((s) => [s.newCount, s.duplicateCount, s.changedCount])).toEqual([
      [2, 0, 0],
      [3, 0, 0],
      [11, 0, 0],
      [2, 0, 0],
    ]);
  });

  it('suggests the closed-month options for a month before today, without future installments', async () => {
    const preview = await previewSample();

    expect(preview.options).toEqual({ closedMonth: true, payInvoice: true, generateFutureInstallments: false });
    expect(preview.rows.every((row) => row.futureInstallments === 0)).toBe(true);
  });

  it('previews the invoice payment that confirm would record', async () => {
    const preview = await previewSample();

    expect(preview.invoice).toEqual({
      creditAccountId: 'acc-credit',
      sourceAccountId: 'acc-bills',
      month: '2026-03',
      paymentDate: '2026-03-09',
      amount: 1916.5,
      dueDay: 9,
      closingDay: 2,
      alreadyPaid: false,
      willPay: true,
    });
  });

  it('previews every row as paid in a closed month', async () => {
    const preview = await previewSample();

    expect(preview.rows.every((row) => row.paid)).toBe(true);
    // The sheet itself still has two unpaid rows: the closed-month rule overrides them.
    expect(rowOf(preview, REF.freela).paid).toBe(true);
    expect(rowOf(preview, REF.gym).paid).toBe(true);
  });

  it('dates every row on day 01 of the sheet month', async () => {
    const preview = await previewSample();

    expect(new Set(preview.rows.map((row) => row.date))).toEqual(new Set(['2026-03-01']));
  });

  it('routes each row to the account of its section and echoes the accounts and the household', async () => {
    const preview = await previewSample();

    expect(new Set(preview.rows.map((row) => `${row.section}:${row.accountId}`))).toEqual(
      new Set(['income:acc-income', 'bills:acc-bills', 'credit:acc-credit', 'debit:acc-debit']),
    );
    expect(preview.accounts).toEqual({
      income: 'acc-income',
      bills: 'acc-bills',
      credit: 'acc-credit',
      debit: 'acc-debit',
    });
    expect(preview.householdId).toBe(HOUSEHOLD);
  });

  it('suggests system categories for the labels that match one and a new category for the others', async () => {
    const preview = await previewSample();
    const suggestionFor = (key: string, type: 'INCOME' | 'EXPENSE') =>
      preview.categoryMap.find((entry) => entry.key === key && entry.type === type)?.suggestion;

    expect(suggestionFor('Salário', 'INCOME')).toEqual({
      kind: 'system',
      categoryName: CategoryName.SALARY,
      label: 'Salário (sistema)',
    });
    expect(suggestionFor('Saúde', 'EXPENSE')).toEqual({
      kind: 'system',
      categoryName: CategoryName.HEALTHCARE,
      label: 'Saúde (sistema)',
    });
    expect(suggestionFor('Alimentação', 'EXPENSE')).toMatchObject({ kind: 'system', categoryName: CategoryName.FOOD });
    expect(suggestionFor('Casa', 'EXPENSE')).toEqual({ kind: 'create', name: 'Casa', label: 'Casa (nova categoria)' });
    expect(suggestionFor('Compras', 'EXPENSE')).toMatchObject({ kind: 'create', name: 'Compras' });
    expect(suggestionFor('Freela Cliente Y', 'INCOME')).toMatchObject({ kind: 'create', name: 'Freela Cliente Y' });
    expect(suggestionFor('', 'EXPENSE')).toEqual({
      kind: 'default',
      categoryName: CategoryName.OTHER_EXPENSES,
      label: 'Outras Despesas (padrão)',
    });
  });

  it('counts the rows and lists the sections of each category key', async () => {
    const preview = await previewSample();

    expect(preview.categoryMap.find((e) => e.key === 'Casa' && e.type === 'EXPENSE')).toMatchObject({
      count: 2,
      sections: ['bills', 'debit'],
    });
    expect(preview.categoryMap.find((e) => e.key === 'Alimentação')).toMatchObject({
      count: 2,
      sections: ['credit', 'debit'],
    });
  });

  it('suggests an existing custom category for a label that matches it', async () => {
    useCategories([{ id: 'cat-casa', name: 'casa', type: 'EXPENSE' }]);

    const preview = await previewSample();

    expect(preview.categoryMap.find((e) => e.key === 'Casa' && e.type === 'EXPENSE')?.suggestion).toMatchObject({
      kind: 'custom',
      categoryId: 'cat-casa',
      categoryName: 'CUSTOM:cat-casa',
    });
  });
});

describe('buildMaxFinPreview: negative values become credits', () => {
  it('previews the refund of the card block as an INCOME row on the card account', async () => {
    const preview = await previewSample();

    expect(rowOf(preview, REF.refund)).toMatchObject({
      section: 'credit',
      accountId: 'acc-credit',
      type: 'INCOME',
      amount: 156,
      paid: true,
      status: 'new',
      notes: 'valor negativo na planilha: lançado como crédito',
    });
    expect(preview.categoryMap.find((e) => e.key === 'Compras' && e.type === 'INCOME')).toMatchObject({
      count: 1,
      sections: ['credit'],
    });
  });

  it('pays the purchases minus the credits, which is the sheet Total of the card', async () => {
    const preview = await previewSample();

    // 2072.50 of purchases minus the 156.00 refund.
    expect(preview.invoice).toMatchObject({ amount: 1916.5, willPay: true });
    expect(preview.warnings.filter((w) => w.startsWith('Cartão'))).toEqual([]);
  });

  it('does not offer to pay, and says why, when the credits cover the purchases', async () => {
    const sheet = Buffer.from(
      [
        '"Finanças Teste\nMês de março de 2026",,,,,,,,,',
        ',Descrição,Categoria,Entrada - Previsto ,Recebido ,À receber,Saída - Previsto,Realizado ,Saldo,',
        ',Total,,,,,"R$ 0,00",,,',
        ',Loja Z,Compras,,,,"R$ 40,00","R$ 40,00",,',
        ',Estorno Loja Z,Compras,,,,"-R$ 100,00","-R$ 100,00",,',
        ',Total,,,,,"-R$ 60,00",,,',
        ',Total,,,,,"R$ 0,00",,,',
      ].join('\r\n'),
    );

    const preview = await previewSample({ buffer: sheet });

    expect(preview.invoice).toMatchObject({ amount: -60, willPay: false });
    expect(preview.warnings).toContainEqual(expect.stringContaining('cobrem as compras'));
  });
});

describe('buildMaxFinPreview: rows that are already stored', () => {
  it('marks a row as duplicate when the same sourceRef is stored with the same amount and paid flag', async () => {
    useStore([{ id: 'old-rent', sourceRef: REF.rent, accountId: 'acc-bills', amount: 1300, paid: true }]);

    const preview = await previewSample();

    expect(rowOf(preview, REF.rent)).toMatchObject({
      status: 'duplicate',
      statusDetail: null,
      existingTransactionId: 'old-rent',
    });
    expect(preview.totals).toMatchObject({ rows: 18, new: 17, duplicate: 1, changed: 0 });
  });

  it('marks a row as duplicate when the card OFX import merged it into another transaction (external ref)', async () => {
    db.externalRefFindMany.mockResolvedValue([{ ref: REF.rent, transactionId: 'kept-1' }]);

    const preview = await previewSample();

    expect(rowOf(preview, REF.rent)).toMatchObject({ status: 'duplicate', existingTransactionId: 'kept-1' });
    expect(preview.totals).toMatchObject({ duplicate: 1, new: 17 });
  });

  it('treats a row the card review deleted (tombstone) as already imported, with a different anchor row', async () => {
    db.externalRefFindMany.mockResolvedValue([{ ref: `deleted:${REF.rent}`, transactionId: 'anchor-1' }]);

    const preview = await previewSample();

    expect(rowOf(preview, REF.rent)).toMatchObject({ status: 'duplicate', existingTransactionId: 'anchor-1' });
    expect(preview.totals).toMatchObject({ duplicate: 1, new: 17 });
  });

  it('does not call a row reconciled with the card statement "changed" when the bank amount differs by cents', async () => {
    useStore([{ id: 'near-1', sourceRef: REF.rent, accountId: 'acc-bills', amount: 1299.98, paid: true }]);
    db.externalRefFindMany.mockResolvedValue([{ ref: 'ofx:abc:11111111', transactionId: 'near-1' }]);

    const preview = await previewSample();

    expect(rowOf(preview, REF.rent)).toMatchObject({ status: 'duplicate', existingTransactionId: 'near-1' });
    expect(preview.totals).toMatchObject({ changed: 0 });
  });

  it('refuses to replace a row reconciled with the card statement', async () => {
    const row = makeConfirmRow({ section: 'debit', sourceRef: REF.padaria, replace: true });
    useStore([{ id: 'near-1', sourceRef: REF.padaria, accountId: 'acc-debit' }]);
    db.externalRefFindMany.mockResolvedValue([{ ref: 'ofx:abc:11111111', transactionId: 'near-1' }]);

    const result = await confirm([row]);

    expect(result).toMatchObject({ imported: 0, skipped: 1, replaced: 0 });
    expect(db.deleteTransaction).not.toHaveBeenCalled();
    expect(db.createTransaction).not.toHaveBeenCalled();
  });

  it('does not call the row that absorbed others "changed" when its amount differs from the sheet', async () => {
    useStore([{ id: 'kept-1', sourceRef: REF.rent, accountId: 'acc-bills', amount: 999, paid: true }]);
    db.externalRefFindMany.mockResolvedValue([{ ref: 'maxfin:2026-10:credit:99', transactionId: 'kept-1' }]);

    const preview = await previewSample();

    expect(rowOf(preview, REF.rent)).toMatchObject({ status: 'duplicate', existingTransactionId: 'kept-1' });
    expect(preview.totals).toMatchObject({ changed: 0, duplicate: 1 });
    expect(preview.warnings.some((w) => w.includes('mescladas'))).toBe(true);
  });

  it('marks a row as changed, with both amounts, when the same sourceRef is stored with another amount', async () => {
    useStore([{ id: 'old-uber', sourceRef: REF.uber, amount: 20, paid: true }]);

    const preview = await previewSample();

    expect(rowOf(preview, REF.uber)).toMatchObject({
      status: 'changed',
      statusDetail: 'valor 20.00 → 25.00',
      existingTransactionId: 'old-uber',
    });
    expect(preview.totals).toMatchObject({ new: 17, duplicate: 0, changed: 1 });
  });

  it('marks a row as changed when only the paid flag differs from the (closed month) previewed one', async () => {
    useStore([{ id: 'old-freela', sourceRef: REF.freela, accountId: 'acc-income', amount: 800, paid: false }]);

    const preview = await previewSample();

    expect(rowOf(preview, REF.freela)).toMatchObject({
      status: 'changed',
      statusDetail: 'pago não → sim',
      existingTransactionId: 'old-freela',
    });
  });

  it('counts the stored rows per section and keeps the duplicate out of the invoice amount', async () => {
    useStore([
      { id: 'old-rent', sourceRef: REF.rent, accountId: 'acc-bills', amount: 1300, paid: true },
      { id: 'old-market', sourceRef: REF.market, amount: 450, paid: true },
      { id: 'old-uber', sourceRef: REF.uber, amount: 20, paid: true },
      { id: 'old-freela', sourceRef: REF.freela, accountId: 'acc-income', amount: 800, paid: false },
    ]);

    const preview = await previewSample();

    expect(preview.totals).toEqual({ rows: 18, new: 14, duplicate: 2, changed: 2, legacyDuplicate: 0, matchesRecurring: 0, skipped: 4 });
    expect(preview.sections.map((s) => [s.key, s.newCount, s.duplicateCount, s.changedCount])).toEqual([
      ['income', 1, 0, 1],
      ['bills', 2, 1, 0],
      ['credit', 9, 1, 1],
      ['debit', 2, 0, 0],
    ]);
    // The new and changed credit rows only: 1916.50 (purchases minus the refund) minus the 450.00 duplicate.
    expect(preview.invoice).toMatchObject({ amount: 1466.5, willPay: true });
  });

  it('ignores a stored row of another household that has the same sourceRef', async () => {
    useStore([{ id: 'foreign-rent', householdId: 'hh-2', sourceRef: REF.rent, accountId: 'acc-bills', amount: 1300 }]);

    const preview = await previewSample();

    expect(rowOf(preview, REF.rent).status).toBe('new');
  });
});

describe('buildMaxFinPreview: a value whose sign flipped since the last import', () => {
  it('reports an expense that became a refund as changed, not duplicate', async () => {
    useStore([{ id: 'old-refund', sourceRef: REF.refund, amount: 156, paid: true, type: 'EXPENSE' }]);

    const preview = await previewSample();

    expect(rowOf(preview, REF.refund)).toMatchObject({
      type: 'INCOME',
      status: 'changed',
      statusDetail: 'tipo despesa → crédito',
      existingTransactionId: 'old-refund',
    });
  });

  it('reports a credit that became an expense as changed, and an income that became a debit', async () => {
    useStore([
      { id: 'old-market', sourceRef: REF.market, amount: 450, paid: true, type: 'INCOME' },
      { id: 'old-salary', sourceRef: 'maxfin:2026-03:income:7', accountId: 'acc-income', amount: 5200, paid: true, type: 'EXPENSE' },
    ]);

    const preview = await previewSample();

    expect(rowOf(preview, REF.market)).toMatchObject({ status: 'changed', statusDetail: 'tipo crédito → despesa' });
    expect(rowOf(preview, 'maxfin:2026-03:income:7')).toMatchObject({ status: 'changed', statusDetail: 'tipo débito → receita' });
    expect(preview.totals).toMatchObject({ duplicate: 0, changed: 2 });
  });

  it('does not take a stored row of the opposite type for a legacy duplicate', async () => {
    useStore([
      {
        id: 'legacy-credit',
        sourceRef: null,
        accountId: 'acc-debit',
        amount: 35,
        description: 'Pix Padaria',
        type: 'INCOME',
        date: new Date('2026-03-01T00:00:00.000Z'),
      },
    ]);

    const preview = await previewSample();

    expect(rowOf(preview, REF.padaria).status).toBe('new');
  });
});

describe('buildMaxFinPreview: rows imported without a sourceRef', () => {
  const legacyRow = (extra: Partial<StoredRow> = {}): StoredRow => ({
    id: 'legacy-1',
    sourceRef: null,
    accountId: 'acc-debit',
    amount: 35,
    description: 'Pix Padaria',
    // Prisma returns a @db.Date column as UTC midnight, whatever the timezone of the host.
    date: new Date('2026-03-01T00:00:00.000Z'),
    ...extra,
  });

  it('flags a row as legacy-duplicate when an identical stored row has no sourceRef', async () => {
    useStore([legacyRow()]);

    const preview = await previewSample();

    expect(rowOf(preview, REF.padaria)).toMatchObject({ status: 'legacy-duplicate', existingTransactionId: 'legacy-1' });
    expect(rowOf(preview, REF.padaria).statusDetail).toEqual(expect.stringContaining('sem identificador de origem'));
    expect(preview.totals).toMatchObject({ rows: 18, new: 17, legacyDuplicate: 1 });
    expect(preview.sections.find((s) => s.key === 'debit')).toMatchObject({ newCount: 1, duplicateCount: 1 });
  });

  it.each<{ label: string; stored: Partial<StoredRow> }>([
    { label: 'another day', stored: { date: new Date('2026-03-02T00:00:00.000Z') } },
    { label: 'the previous day', stored: { date: new Date('2026-02-28T00:00:00.000Z') } },
    { label: 'another amount', stored: { amount: 36 } },
    { label: 'another description', stored: { description: 'Pix Padaria 2' } },
    { label: 'another account', stored: { accountId: 'acc-bills' } },
    { label: 'a sourceRef of its own', stored: { sourceRef: 'manual:1' } },
  ])('does not flag a stored row with $label as a legacy duplicate', async ({ stored }) => {
    useStore([legacyRow(stored)]);

    const preview = await previewSample();

    expect(rowOf(preview, REF.padaria).status).toBe('new');
    expect(preview.totals.legacyDuplicate).toBe(0);
  });

  it('keeps a legacy duplicate out of the invoice amount', async () => {
    useStore([legacyRow({ id: 'legacy-uber', accountId: 'acc-credit', amount: 25, description: 'Uber' })]);

    const preview = await previewSample();

    expect(rowOf(preview, REF.uber).status).toBe('legacy-duplicate');
    expect(preview.invoice).toMatchObject({ amount: 1891.5 });
  });

  it('looks for legacy rows without sourceRef only, in the household and in the four destination accounts', async () => {
    await previewSample();

    const queries = db.transactionFindMany.mock.calls.map((call) => call[0] as { where: TransactionWhere });
    const legacyQuery = queries.find((query) => query.where.sourceRef === null);
    expect(legacyQuery?.where).toMatchObject({
      householdId: HOUSEHOLD,
      sourceRef: null,
      accountId: { in: ['acc-income', 'acc-bills', 'acc-credit', 'acc-debit'] },
    });
  });
});

describe('buildMaxFinPreview: generated future installments', () => {
  const generatedFor = (number: number, plan: string, extra: Partial<StoredRow> = {}): StoredRow => ({
    id: `ph-${number}`,
    sourceRef: `maxfin:2026-02:credit:9:f${number}`,
    installmentId: plan,
    installmentNumber: number,
    ...extra,
  });

  it('marks an installment row as replaces-future when a generated installment of its plan is stored', async () => {
    useStore([generatedFor(3, PLAN_LOJA_A, { sourceRef: 'maxfin:2026-02:credit:9:f1' })]);

    const preview = await previewSample();

    const row = rowOf(preview, REF.lojaA);
    expect(row).toMatchObject({ status: 'replaces-future', existingTransactionId: 'ph-3' });
    expect(row.statusDetail).toMatch(/\b3\b/);
    expect(preview.totals).toEqual({ rows: 18, new: 18, duplicate: 0, changed: 0, legacyDuplicate: 0, matchesRecurring: 0, skipped: 4 });
    expect(preview.sections.find((s) => s.key === 'credit')).toMatchObject({ newCount: 11, duplicateCount: 0 });
    expect(preview.invoice).toMatchObject({ amount: 1916.5 });
  });

  it('treats a generated installment the card statement consumed (ofx: ref) as the real one: already imported, never a placeholder', async () => {
    useStore([generatedFor(3, PLAN_LOJA_A, { sourceRef: 'maxfin:2026-02:credit:9:f1' })]);
    db.externalRefFindMany.mockResolvedValue([{ ref: 'ofx:abc:11111111', transactionId: 'ph-3' }]);

    const preview = await previewSample();

    const row = rowOf(preview, REF.lojaA);
    expect(row).toMatchObject({ status: 'duplicate', existingTransactionId: 'ph-3' });
    expect(preview.warnings.some((w) => w.includes('conciliadas com o OFX') && w.includes('Loja A'))).toBe(true);
  });

  it('covers every number a prepaid row pays (5/12 +7 covers 5..12)', async () => {
    useStore([6, 8].map((number) => generatedFor(number, PLAN_CURSO_B)));

    const preview = await previewSample();

    const row = rowOf(preview, REF.cursoB);
    expect(row.status).toBe('replaces-future');
    expect(row.statusDetail).toContain('6, 8');
  });

  it.each<{ label: string; stored: StoredRow }>([
    { label: 'a number the row does not cover', stored: generatedFor(4, PLAN_CURSO_B) },
    { label: 'another card', stored: generatedFor(6, PLAN_CURSO_B, { accountId: 'acc-other-card' }) },
    { label: 'another household', stored: generatedFor(6, PLAN_CURSO_B, { householdId: 'hh-2' }) },
    { label: 'a real installment, not a generated one', stored: generatedFor(6, PLAN_CURSO_B, { sourceRef: 'maxfin:2026-02:credit:9' }) },
    { label: 'a typed-by-hand installment', stored: generatedFor(6, PLAN_CURSO_B, { sourceRef: null }) },
  ])('does not replace a stored installment of $label', async ({ stored }) => {
    useStore([stored]);

    const preview = await previewSample();

    expect(rowOf(preview, REF.cursoB).status).toBe('new');
    expect(preview.totals.new).toBe(18);
  });
});

describe('buildMaxFinPreview: installment text outside the card block', () => {
  // Only the credit block carries installment plans: a bills row that looks like an installment must neither
  // consume the card's generated installments nor promise future ones, and must not trigger a plan lookup.
  const BILLS_ONLY_SHEET = Buffer.from(
    [
      '"Finanças Teste\nMês de março de 2026",,,,,,,,,',
      ',,,,,,,,,',
      ',Descrição,Categoria,Entrada - Previsto ,Recebido ,À receber,Saída - Previsto,Realizado ,Saldo,',
      ',Loja A 3/10,Casa,,,,"R$ 90,00","R$ 90,00",,',
      ',Total,,,,,"R$ 90,00",,,',
      ',,,,,,,,,',
      ',Total,,,,,"R$ 0,00",,,',
      ',,,,,,,,,',
      ',Total,,,,,"R$ 0,00",,,',
    ].join('\r\n'),
  );
  const BILLS_AND_CARD_SHEET = Buffer.from(
    [
      '"Finanças Teste\nMês de março de 2026",,,,,,,,,',
      ',,,,,,,,,',
      ',Descrição,Categoria,Entrada - Previsto ,Recebido ,À receber,Saída - Previsto,Realizado ,Saldo,',
      ',Loja A 3/10,Casa,,,,"R$ 90,00","R$ 90,00",,',
      ',Total,,,,,"R$ 90,00",,,',
      ',,,,,,,,,',
      ',Loja A 3/10,Compras,,,,"R$ 90,00","R$ 90,00",,',
      ',Total,,,,,"R$ 90,00",,,',
      ',,,,,,,,,',
      ',Total,,,,,"R$ 0,00",,,',
    ].join('\r\n'),
  );

  it('does not look up installment plans for a bills row and keeps it new', async () => {
    useStore([generatedInstallment(3)]);

    const preview = await previewSample({ buffer: BILLS_ONLY_SHEET, today: MARCH_15, options: OPEN_WITH_FUTURES });

    expect(preview.rows.find((r) => r.description === 'Loja A 3/10')).toMatchObject({
      section: 'bills',
      status: 'new',
      futureInstallments: 0,
    });
    const planLookups = db.transactionFindMany.mock.calls.filter(
      (call) => (call[0] as { where: Record<string, unknown> }).where.installmentId !== undefined,
    );
    expect(planLookups).toHaveLength(0);
  });

  it('supersedes the generated installment with the card row only, not with a bills row of the same text', async () => {
    useStore([generatedInstallment(3)]);

    const preview = await previewSample({ buffer: BILLS_AND_CARD_SHEET, today: MARCH_15, options: OPEN_WITH_FUTURES });

    const rows = preview.rows.filter((r) => r.description === 'Loja A 3/10');
    expect(rows.find((r) => r.section === 'credit')).toMatchObject({ status: 'replaces-future', existingTransactionId: 'ph-3' });
    expect(rows.find((r) => r.section === 'bills')).toMatchObject({ status: 'new', futureInstallments: 0 });
  });
});

describe('buildMaxFinPreview: open month', () => {
  it('suggests the open-month options and does not offer to pay the invoice', async () => {
    const preview = await previewSample({ today: MARCH_15 });

    expect(preview.options).toEqual({ closedMonth: false, payInvoice: false, generateFutureInstallments: true });
    expect(preview.invoice).toMatchObject({ amount: 1916.5, willPay: false });
  });

  it('keeps the paid flag of the sheet', async () => {
    const preview = await previewSample({ today: MARCH_15 });

    expect(preview.rows.filter((row) => !row.paid).map((row) => row.sourceRef)).toEqual([REF.freela, REF.gym]);
  });

  it('never offers to pay the invoice of an open month, even when asked to', async () => {
    const preview = await previewSample({ today: MARCH_15, options: { payInvoice: true } });

    expect(preview.invoice?.willPay).toBe(false);
  });

  it('counts the installments still to come for each installment row', async () => {
    const preview = await previewSample({ today: MARCH_15 });

    const withFutures = preview.rows.filter((row) => row.futureInstallments > 0);
    expect(withFutures.map((row) => [row.sourceRef, row.futureInstallments])).toEqual([
      [REF.lojaA, 7],
      [REF.remedios, 2],
    ]);
    expect(rowOf(preview, REF.cursoB).futureInstallments).toBe(0);
  });

  it('counts only the numbers that are not stored yet', async () => {
    useStore([4, 5].map((number) => ({ id: `manual-${number}`, installmentId: PLAN_LOJA_A, installmentNumber: number })));

    const preview = await previewSample({ today: MARCH_15 });

    expect(rowOf(preview, REF.lojaA).futureInstallments).toBe(5);
    expect(rowOf(preview, REF.remedios).futureInstallments).toBe(2);
  });

  it('counts none when future installments are switched off', async () => {
    const preview = await previewSample({ today: MARCH_15, options: { generateFutureInstallments: false } });

    expect(preview.rows.every((row) => row.futureInstallments === 0)).toBe(true);
  });

  it('counts none for a row that is already imported', async () => {
    useStore([{ id: 'old-loja', sourceRef: REF.lojaA, amount: 90, paid: true }]);

    const preview = await previewSample({ today: MARCH_15 });

    expect(rowOf(preview, REF.lojaA)).toMatchObject({ status: 'duplicate', futureInstallments: 0 });
  });
});

describe('buildMaxFinPreview: warnings', () => {
  it('keeps the warnings of the parser', async () => {
    const preview = await previewSample();

    expect(preview.warnings).toContainEqual(expect.stringContaining('difere do Total previsto'));
  });

  it('adds no account warning for a card that closes on day 2 and a bills account that is not a card', async () => {
    const preview = await previewSample();

    expect(preview.warnings.filter((warning) => warning.includes('Nubank Teste'))).toEqual([]);
    expect(preview.warnings.filter((warning) => warning.includes('conta de contas fixas'))).toEqual([]);
  });

  it('warns when the card has no closing day', async () => {
    const preview = await previewSample({ resolved: makeAccounts({ credit: { closingDay: null } }) });

    expect(preview.warnings).toContainEqual(expect.stringMatching(/Nubank Teste.*dia de fechamento/));
  });

  it('warns when the card closes on day 1, because day-01 rows then fall in the next invoice', async () => {
    const preview = await previewSample({ resolved: makeAccounts({ credit: { closingDay: 1 } }) });

    expect(preview.warnings).toContainEqual(expect.stringMatching(/Nubank Teste.*fecha no dia 1/));
  });

  it('warns, and does not offer to pay, when the bills account is a credit card', async () => {
    const preview = await previewSample({ resolved: makeAccounts({ bills: { type: AccountType.CREDIT } }) });

    expect(preview.warnings).toContainEqual(expect.stringContaining('conta de contas fixas'));
    expect(preview.invoice).toMatchObject({ amount: 1916.5, willPay: false });
  });

  it('warns, and offers no invoice, when the card account is not a credit account', async () => {
    const preview = await previewSample({ resolved: makeAccounts({ credit: { type: AccountType.CHECKING } }) });

    expect(preview.warnings).toContainEqual(expect.stringMatching(/Nubank Teste.*não é um cartão de crédito/));
    expect(preview.invoice).toBeNull();
  });
});

describe('buildMaxFinPreview: month of a CSV downloaded from one tab', () => {
  it('takes the month of the tab in the file name over a stale title, with a warning', async () => {
    const preview = await previewSample({ filename: 'FINANCAS_2026.xlsx - NOV.csv', today: new Date(2026, 11, 15) });

    expect(preview).toMatchObject({ month: { year: 2026, month: 11 }, monthKey: '2026-11', monthSource: 'sheet' });
    expect(preview.warnings).toContain(
      'O título da aba diz março/2026, mas a aba se chama "NOV": usei novembro/2026 (ano do nome do arquivo).',
    );
    expect(preview.rows.every((row) => row.sourceRef.startsWith('maxfin:2026-11:') && row.date === '2026-11-01')).toBe(
      true,
    );
  });

  it('keeps the title month when the tab in the file name agrees with it', async () => {
    const preview = await previewSample({ filename: 'FINANCAS_2026.xlsx - MAR.csv' });

    expect(preview).toMatchObject({ monthKey: '2026-03', monthSource: 'title' });
    expect(preview.warnings.filter((warning) => warning.includes('título da aba'))).toEqual([]);
  });
});

describe('buildMaxFinPreview: CSV of a tab whose title names another month', () => {
  const DECEMBER_TITLED = Buffer.from(SAMPLE_CSV.toString('utf8').replace('Mês de março de 2026', 'Mês de dezembro de 2026'));
  const OCTOBER_TITLED = Buffer.from(SAMPLE_CSV.toString('utf8').replace('Mês de março de 2026', 'Mês de outubro de 2026'));

  it('previews JAN copied from DEZ in a file named for the next year as January of that year', async () => {
    const preview = await previewSample({
      buffer: DECEMBER_TITLED,
      filename: 'FINANCAS_2027.xlsx - JAN.csv',
      today: new Date(2027, 1, 10),
    });

    expect(preview).toMatchObject({ monthKey: '2027-01', monthSource: 'sheet', options: { closedMonth: true } });
    expect(preview.warnings).toContain(
      'O título da aba diz dezembro/2026, mas a aba se chama "JAN": usei janeiro/2027 (ano do nome do arquivo).',
    );
    expect(preview.rows.every((row) => row.sourceRef.startsWith('maxfin:2027-01:') && row.date === '2027-01-01')).toBe(true);
  });

  it('keeps a backward copy in the year of the file name and December in the title year', async () => {
    const backward = await previewSample({ buffer: OCTOBER_TITLED, filename: 'FINANCAS_2026.xlsx - SET.csv' });
    const december = await previewSample({ buffer: DECEMBER_TITLED, filename: 'FINANCAS_2027.xlsx - DEZ.csv' });

    expect(backward).toMatchObject({ monthKey: '2026-09', monthSource: 'sheet' });
    expect(december).toMatchObject({ monthKey: '2026-12', monthSource: 'title' });
  });

  it('with no year but the title, moves JAN copied from DEZ to the next year', async () => {
    const preview = await previewSample({ buffer: DECEMBER_TITLED, filename: 'Planilha.xlsx - JAN.csv', today: new Date(2027, 1, 10) });

    expect(preview).toMatchObject({ monthKey: '2027-01', monthSource: 'sheet' });
    expect(preview.warnings).toContain(
      'O título da aba diz dezembro/2026, mas a aba se chama "JAN": usei janeiro/2027 (ano seguinte ao do título: a aba é uma cópia feita depois dele).',
    );
  });
});

describe('buildMaxFinPreview: input handling', () => {
  it('rejects a file without readable rows, before querying the database', async () => {
    await expect(previewSample({ buffer: Buffer.from('a,b\n') })).rejects.toEqual(isBadRequest('No readable rows found'));

    expect(db.categoryFindMany).not.toHaveBeenCalled();
    expect(db.transactionFindMany).not.toHaveBeenCalled();
  });

  it('re-dates the whole sheet when the user overrides the month', async () => {
    const preview = await previewSample({
      options: { monthOverride: { year: 2026, month: 4 } },
      today: new Date(2026, 4, 10),
    });

    expect(preview).toMatchObject({ month: { year: 2026, month: 4 }, monthKey: '2026-04', monthSource: 'override' });
    expect(preview.rows.every((row) => row.sourceRef.startsWith('maxfin:2026-04:') && row.date === '2026-04-01')).toBe(true);
    expect(preview.invoice).toMatchObject({ month: '2026-04', paymentDate: '2026-04-09' });
  });

  it('has no month key and no invoice when the month cannot be detected', async () => {
    const sheet = Buffer.from(
      ',Descrição,Categoria,Entrada - Previsto ,Recebido ,À receber,Saída - Previsto,Realizado ,Saldo,\n' +
        ',Salário,Salário,"R$ 100,00","R$ 100,00",,,,,\n',
    );

    const preview = await previewSample({ buffer: sheet, filename: 'upload.csv' });

    expect(preview).toMatchObject({ month: null, monthKey: null, monthSource: 'none', invoice: null });
    expect(preview.options.closedMonth).toBe(false);
    expect(preview.warnings).toContainEqual(expect.stringContaining('identificar o mês'));
  });

  it('resolves the destination accounts itself when the caller did not', async () => {
    const resolved = makeAccounts();
    db.accountFindMany.mockResolvedValue([resolved.income, resolved.bills, resolved.credit, resolved.debit]);

    const preview = await buildMaxFinPreview({
      filename: 'FINANCAS - MAR.csv',
      buffer: SAMPLE_CSV,
      accounts: idsOf(resolved),
      today: APRIL_15,
    });

    expect(db.accountFindMany).toHaveBeenCalledTimes(1);
    expect(preview.householdId).toBe(HOUSEHOLD);
    expect(preview.invoice).toMatchObject({ creditAccountId: 'acc-credit', dueDay: 9, closingDay: 2 });
  });
});

describe('buildMaxFinPreview: invoice payment offer', () => {
  it('says the payment already exists and does not promise a second one', async () => {
    db.transactionFindFirst.mockResolvedValue({ id: 'pay-1' });

    const preview = await previewSample({ options: { payInvoice: true } });

    expect(db.transactionFindFirst).toHaveBeenCalledWith({
      where: { householdId: HOUSEHOLD, attachmentUrl: 'invoice_pay:acc-credit:2026-2' },
      select: { id: true },
    });
    expect(preview.invoice).toMatchObject({ alreadyPaid: true, willPay: false, amount: 1916.5 });
  });

  it('looks for the payment of the sheet month only when the card is a credit account', async () => {
    const resolved = makeAccounts({ credit: { type: AccountType.CHECKING } });

    const preview = await previewSample({ resolved });

    expect(preview.invoice).toBeNull();
    expect(db.transactionFindFirst).not.toHaveBeenCalled();
  });

  it('does not offer to pay when the bills account is the card itself', async () => {
    const resolved = makeAccounts();
    resolved.bills = { ...resolved.credit };

    const preview = await previewSample({ resolved });

    expect(preview.warnings).toContainEqual(expect.stringContaining('conta de contas fixas'));
    expect(preview.invoice).toMatchObject({ sourceAccountId: 'acc-credit', willPay: false });
  });

  it('does not offer to pay when every credit row is already imported', async () => {
    const creditRows: Array<[string, number]> = [
      [REF.market, 450],
      [REF.lojaA, 90],
      [REF.cursoB, 640],
      [REF.remedios, 200],
      [REF.refund, 156],
      ['maxfin:2026-03:credit:22', 180],
      ['maxfin:2026-03:credit:23', 75],
      ['maxfin:2026-03:credit:24', 320],
      [REF.uber, 25],
      ['maxfin:2026-03:credit:26', 32.5],
      ['maxfin:2026-03:credit:27', 60],
    ];
    useStore(
      creditRows.map(([sourceRef, amount], index) => ({
        id: `old-${index}`,
        sourceRef,
        amount,
        paid: true,
        type: sourceRef === REF.refund ? 'INCOME' : 'EXPENSE',
      })),
    );

    const preview = await previewSample();

    expect(preview.sections.find((s) => s.key === 'credit')).toMatchObject({ newCount: 0, duplicateCount: 11 });
    expect(preview.invoice).toMatchObject({ amount: 0, willPay: false });
  });
});

// Sheet dates are local midnight while Prisma returns @db.Date columns as UTC midnight. The legacy-duplicate
// match and every day string must hold in any host timezone, so these tests run under several of them.
describe.each(['America/Sao_Paulo', 'Pacific/Auckland', 'UTC', 'Pacific/Kiritimati', 'Etc/GMT+12'])(
  'day handling when the host timezone is %s',
  (timeZone) => {
    const hostTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    beforeEach(() => {
      process.env.TZ = timeZone;
      // Fail loudly where the runtime cannot switch zones: the assertions below would prove nothing there.
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(timeZone);
    });

    afterEach(() => {
      process.env.TZ = hostTimeZone;
    });

    it('flags a stored row without sourceRef as legacy-duplicate by matching its UTC-midnight date to the sheet day', async () => {
      useStore([
        {
          id: 'legacy-1',
          sourceRef: null,
          accountId: 'acc-debit',
          amount: 35,
          description: 'Pix Padaria',
          date: new Date('2026-03-01T00:00:00.000Z'),
        },
      ]);

      const preview = await previewSample({ today: new Date(2026, 3, 15) });

      expect(rowOf(preview, REF.padaria)).toMatchObject({ status: 'legacy-duplicate', existingTransactionId: 'legacy-1' });
    });

    it('previews the rows on day 01 and the invoice on its due day', async () => {
      const preview = await previewSample({ today: new Date(2026, 3, 15) });

      expect(new Set(preview.rows.map((row) => row.date))).toEqual(new Set(['2026-03-01']));
      expect(preview.invoice?.paymentDate).toBe('2026-03-09');
    });

    it('confirms a closed month with local-midnight dates for the row and for the invoice payment', async () => {
      const row = makeConfirmRow({ section: 'credit', sourceRef: 'maxfin:2026-03:credit:16', amount: 100 });

      const result = await confirm([row], { options: CLOSED_WITH_INVOICE });

      expect(createdInputs()[0]?.date).toEqual(new Date(2026, 2, 1));
      expect(db.payCreditCardInvoice).toHaveBeenCalledWith(
        expect.objectContaining({ paymentDate: new Date(2026, 2, 9) }),
      );
      expect(result.invoicePayment?.date).toBe('2026-03-09');
    });

    it('confirms the future installments on the first day of the following months', async () => {
      await confirm([makeLojaARow(8)], { options: OPEN_WITH_FUTURES });

      expect(createdInputs().slice(1).map((input) => input.date)).toEqual([new Date(2026, 3, 1), new Date(2026, 4, 1)]);
    });
  },
);

// ---------------------------------------------------------------------------
// E. Pure helpers
// ---------------------------------------------------------------------------

describe('resolveImportOptions', () => {
  const today = new Date(2026, 9, 3); // 2026-10-03

  it('treats a past month as closed: pay the invoice, no future installments', () => {
    expect(resolveImportOptions({ year: 2026, month: 9 }, undefined, today)).toEqual({
      closedMonth: true,
      payInvoice: true,
      generateFutureInstallments: false,
    });
  });

  it('treats the current month as open: no invoice payment, future installments on', () => {
    expect(resolveImportOptions({ year: 2026, month: 10 }, undefined, today)).toEqual({
      closedMonth: false,
      payInvoice: false,
      generateFutureInstallments: true,
    });
  });

  it('lets explicit values win over the derived defaults', () => {
    expect(
      resolveImportOptions({ year: 2026, month: 9 }, { payInvoice: false, generateFutureInstallments: true }, today),
    ).toEqual({ closedMonth: true, payInvoice: false, generateFutureInstallments: true });
    expect(resolveImportOptions({ year: 2026, month: 10 }, { closedMonth: true }, today)).toEqual({
      closedMonth: true,
      payInvoice: true,
      generateFutureInstallments: false,
    });
  });

  it('falls back to an open month when the sheet month is unknown', () => {
    expect(resolveImportOptions(null, undefined, today)).toEqual({
      closedMonth: false,
      payInvoice: false,
      generateFutureInstallments: true,
    });
  });
});

describe('classifyRow', () => {
  const row = { amount: 640.07, paid: true, type: 'EXPENSE', section: 'credit' } as const;
  const stored = { id: 't1', amount: 640.07, paid: true, type: 'EXPENSE' };
  const generated = [
    { id: 'ph-4', installmentNumber: 4 },
    { id: 'ph-5', installmentNumber: 5 },
  ];

  it('is new when nothing matches', () => {
    expect(classifyRow(row, undefined, [], undefined)).toEqual({
      status: 'new',
      statusDetail: null,
      existingTransactionId: null,
    });
  });

  it('is duplicate when the stored row has the same amount and paid flag', () => {
    expect(classifyRow(row, stored, [], undefined)).toEqual({
      status: 'duplicate',
      statusDetail: null,
      existingTransactionId: 't1',
    });
  });

  it('treats an amount that differs by less than a cent as the same amount', () => {
    expect(classifyRow({ ...row, amount: 640.074 }, stored, [], undefined).status).toBe('duplicate');
    expect(classifyRow({ ...row, amount: 640.08 }, stored, [], undefined).status).toBe('changed');
  });

  it('is changed when the amount differs, and says from what to what', () => {
    expect(classifyRow({ ...row, amount: 11 }, { ...stored, amount: 10 }, [], undefined)).toEqual({
      status: 'changed',
      statusDetail: 'valor 10.00 → 11.00',
      existingTransactionId: 't1',
    });
  });

  it('is changed when only the paid flag differs', () => {
    expect(classifyRow(row, { ...stored, paid: false }, [], undefined)).toEqual({
      status: 'changed',
      statusDetail: 'pago não → sim',
      existingTransactionId: 't1',
    });
  });

  it('describes both differences when the amount and the paid flag differ', () => {
    const result = classifyRow({ ...row, amount: 12.5, paid: false }, { ...stored, amount: 10 }, [], undefined);

    expect(result.status).toBe('changed');
    expect(result.statusDetail).toBe('valor 10.00 → 12.50; pago sim → não');
  });

  it.each<{ label: string; from: 'INCOME' | 'EXPENSE'; to: 'INCOME' | 'EXPENSE'; section: MaxFinSectionKey; detail: string }>([
    { label: 'an expense that became a refund', from: 'EXPENSE', to: 'INCOME', section: 'credit', detail: 'tipo despesa → crédito' },
    { label: 'a refund that became an expense', from: 'INCOME', to: 'EXPENSE', section: 'debit', detail: 'tipo crédito → despesa' },
    { label: 'an income that became a debit', from: 'INCOME', to: 'EXPENSE', section: 'income', detail: 'tipo receita → débito' },
  ])('is changed, not duplicate, for $label with the same amount', ({ from, to, section, detail }) => {
    expect(classifyRow({ ...row, type: to, section }, { ...stored, type: from }, [], undefined)).toEqual({
      status: 'changed',
      statusDetail: detail,
      existingTransactionId: 't1',
    });
  });

  it('lists the type change before the other differences', () => {
    const result = classifyRow({ ...row, type: 'INCOME', amount: 12.5 }, { ...stored, amount: 10 }, [], undefined);

    expect(result.statusDetail).toBe('tipo despesa → crédito; valor 10.00 → 12.50');
  });

  it('is replaces-future when generated future installments of the plan are superseded, listing their numbers', () => {
    const result = classifyRow(row, undefined, [...generated].reverse(), undefined);

    expect(result.status).toBe('replaces-future');
    expect(result.statusDetail).toContain('4, 5');
    expect(['ph-4', 'ph-5']).toContain(result.existingTransactionId);
  });

  it('is legacy-duplicate when only an identical row without sourceRef exists', () => {
    expect(classifyRow(row, undefined, [], 'old-1')).toEqual({
      status: 'legacy-duplicate',
      statusDetail: 'lançamento igual já existe (importado sem identificador de origem)',
      existingTransactionId: 'old-1',
    });
  });

  it('prefers the sourceRef match over generated installments and over a legacy match', () => {
    expect(classifyRow(row, stored, generated, 'old-1')).toMatchObject({ status: 'duplicate', existingTransactionId: 't1' });
    expect(classifyRow({ ...row, amount: 1 }, stored, generated, 'old-1').status).toBe('changed');
  });

  it('prefers generated installments over a legacy match', () => {
    expect(classifyRow(row, undefined, generated, 'old-1')).toMatchObject({
      status: 'replaces-future',
      existingTransactionId: expect.stringMatching(/^ph-/),
    });
  });
});

describe('suggestionToDto', () => {
  it('labels a system suggestion with its pt-BR display name', () => {
    expect(suggestionToDto({ kind: 'system', categoryName: CategoryName.HEALTHCARE })).toEqual({
      kind: 'system',
      categoryName: CategoryName.HEALTHCARE,
      label: 'Saúde (sistema)',
    });
    expect(suggestionToDto({ kind: 'system', categoryName: CategoryName.SALARY }).label).toBe('Salário (sistema)');
  });

  it('labels a suggestion to create a category with the name it would get', () => {
    expect(suggestionToDto({ kind: 'create', name: 'Casa' })).toEqual({
      kind: 'create',
      name: 'Casa',
      label: 'Casa (nova categoria)',
    });
  });

  it('labels the default suggestion of each type', () => {
    expect(suggestionToDto({ kind: 'default', categoryName: CategoryName.OTHER_EXPENSES })).toEqual({
      kind: 'default',
      categoryName: CategoryName.OTHER_EXPENSES,
      label: 'Outras Despesas (padrão)',
    });
    expect(suggestionToDto({ kind: 'default', categoryName: CategoryName.OTHER_INCOME }).label).toBe(
      'Outras Receitas (padrão)',
    );
  });

  it('keeps the id and the CUSTOM: name of an existing custom category', () => {
    const dto = suggestionToDto({ kind: 'custom', categoryId: 'id-1', categoryName: 'CUSTOM:id-1', name: 'Pets' });

    expect(dto).toMatchObject({ kind: 'custom', categoryId: 'id-1', categoryName: 'CUSTOM:id-1', name: 'Pets' });
    expect(dto.label).toBe('Pets (categoria existente)');
  });
});

describe('isUniqueViolation', () => {
  it('recognises a Prisma unique-constraint error by its P2002 code', () => {
    expect(isUniqueViolation(uniqueViolation())).toBe(true);
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
  });

  it('rejects other codes and anything that is not an error-like object', () => {
    for (const value of [{ code: 'P2003' }, new Error('P2002'), { code: 2002 }, {}, null, undefined, 'P2002', 42]) {
      expect(isUniqueViolation(value), String(value)).toBe(false);
    }
  });
});
