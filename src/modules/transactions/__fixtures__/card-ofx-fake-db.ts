/**
 * In-memory stand-in for the Prisma calls (and the transaction-service writes) the card OFX importer makes, for
 * unit tests. It keeps the properties the importer relies on: sourceRef unique per household and external refs
 * unique per (household, ref) (both P2002), refs deleted with their transaction, batch `$transaction([...])`
 * all-or-nothing, and the paid flags undoing an invoice payment flips. Dates are 'YYYY-MM-DD' days; filters given
 * as Date are read as local days, like the service writes them.
 */
import { vi } from 'vitest';

export interface FakeTransaction {
  id: string;
  householdId: string;
  accountId: string | null;
  type: 'INCOME' | 'EXPENSE' | 'TRANSFER' | 'ALLOCATION';
  categoryName: string | null;
  amount: number;
  description: string | null;
  /** YYYY-MM-DD */
  date: string;
  notes: string | null;
  paid: boolean;
  sourceRef: string | null;
  attachmentUrl: string | null;
  installmentId: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
  createdAt: number;
}

export interface FakeExternalRef {
  id: string;
  householdId: string;
  transactionId: string;
  ref: string;
}

export interface FakeAccount {
  id: string;
  householdId: string;
  name: string;
  type: 'CHECKING' | 'SAVINGS' | 'CREDIT' | 'CASH' | 'INVESTMENT';
  isActive: boolean;
  dueDay: number | null;
  closingDay: number | null;
}

export interface FakeCategory {
  id: string;
  householdId: string;
  name: string;
  type: 'INCOME' | 'EXPENSE';
}

interface Store {
  transactions: FakeTransaction[];
  refs: FakeExternalRef[];
  accounts: FakeAccount[];
  categories: FakeCategory[];
}

export const store: Store = { transactions: [], refs: [], accounts: [], categories: [] };
let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

export function resetStore(): void {
  store.transactions = [];
  store.refs = [];
  store.accounts = [];
  store.categories = [];
  sequence = 0;
}

function prismaError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function localDay(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toDay(value: unknown): string {
  if (value instanceof Date) return localDay(value);
  return String(value);
}

type Where = Record<string, unknown>;

function matches(record: Record<string, unknown>, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(condition as Where[]).some((c) => matches(record, c))) return false;
      continue;
    }
    const value = record[key];
    if (condition === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (typeof condition !== 'object' || condition instanceof Date) {
      if (key === 'date' ? value !== toDay(condition) : value !== condition) return false;
      continue;
    }
    const c = condition as Record<string, unknown>;
    if ('in' in c && !(c.in as unknown[]).includes(value)) return false;
    if ('not' in c && (c.not === null ? value === null || value === undefined : value === c.not)) return false;
    if ('startsWith' in c && !(typeof value === 'string' && value.startsWith(c.startsWith as string))) return false;
    if ('contains' in c) {
      const text = typeof value === 'string' ? value : '';
      const needle = c.contains as string;
      const found = c.mode === 'insensitive' ? text.toLowerCase().includes(needle.toLowerCase()) : text.includes(needle);
      if (!found) return false;
    }
    if ('gte' in c && !(String(value) >= toDay(c.gte))) return false;
    if ('lte' in c && !(String(value) <= toDay(c.lte))) return false;
  }
  return true;
}

function decimal(n: number) {
  return { toNumber: () => n, toString: () => n.toFixed(2) };
}

/** What Prisma returns: Decimal amounts and @db.Date columns as UTC midnight. */
function project(t: FakeTransaction, select?: Record<string, boolean>): Record<string, unknown> {
  const full: Record<string, unknown> = { ...t, amount: decimal(t.amount), date: new Date(`${t.date}T00:00:00.000Z`) };
  if (!select) return full;
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, full[k]]));
}

function sortBy(rows: FakeTransaction[], orderBy: unknown): FakeTransaction[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<Record<string, 'asc' | 'desc'>>;
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const [field, direction] = Object.entries(key)[0]!;
      const av = (a as unknown as Record<string, string | number>)[field]!;
      const bv = (b as unknown as Record<string, string | number>)[field]!;
      if (av === bv) continue;
      const order = av < bv ? -1 : 1;
      return direction === 'desc' ? -order : order;
    }
    return 0;
  });
}

/** A PrismaPromise look-alike: runs when awaited, or when a batch `$transaction` runs it. */
function lazy<T>(run: () => T) {
  let promise: Promise<T> | null = null;
  const exec = () => (promise ??= Promise.resolve().then(run));
  return {
    exec,
    then<A, B>(resolve?: (v: T) => A, reject?: (e: unknown) => B) {
      return exec().then(resolve, reject);
    },
  };
}

function insertTransaction(data: Partial<FakeTransaction> & { householdId: string }): FakeTransaction {
  if (data.sourceRef && store.transactions.some((t) => t.householdId === data.householdId && t.sourceRef === data.sourceRef)) {
    throw prismaError('P2002', 'Unique constraint failed on the fields: (`household_id`,`source_ref`)');
  }
  const row: FakeTransaction = {
    id: data.id ?? nextId('tx'),
    accountId: null,
    type: 'EXPENSE',
    categoryName: null,
    amount: 0,
    description: null,
    date: '2026-01-01',
    notes: null,
    paid: true,
    sourceRef: null,
    attachmentUrl: null,
    installmentId: null,
    installmentNumber: null,
    totalInstallments: null,
    createdAt: sequence,
    ...data,
  };
  store.transactions.push(row);
  return row;
}

function insertRefs(data: Array<Omit<FakeExternalRef, 'id'>>, skipDuplicates: boolean): { count: number } {
  const fresh: Array<Omit<FakeExternalRef, 'id'>> = [];
  for (const item of data) {
    const taken = store.refs.some((r) => r.householdId === item.householdId && r.ref === item.ref) ||
      fresh.some((r) => r.householdId === item.householdId && r.ref === item.ref);
    if (taken) {
      if (skipDuplicates) continue;
      throw prismaError('P2002', 'Unique constraint failed on the fields: (`household_id`,`ref`)');
    }
    if (!store.transactions.some((t) => t.id === item.transactionId)) {
      throw prismaError('P2003', 'Foreign key constraint failed on the field: `transaction_id`');
    }
    fresh.push(item);
  }
  for (const item of fresh) store.refs.push({ id: nextId('ref'), ...item });
  return { count: fresh.length };
}

function snapshot(): Store {
  return {
    transactions: store.transactions.map((t) => ({ ...t })),
    refs: store.refs.map((r) => ({ ...r })),
    accounts: store.accounts.map((a) => ({ ...a })),
    categories: store.categories.map((c) => ({ ...c })),
  };
}

function updateData(t: FakeTransaction, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    (t as unknown as Record<string, unknown>)[key] = key === 'date' ? toDay(value) : value;
  }
}

export const fakePrisma = {
  transaction: {
    findMany: vi.fn((args: { where?: Where; select?: Record<string, boolean>; orderBy?: unknown; take?: number }) =>
      lazy(() => {
        const rows = sortBy(store.transactions.filter((t) => matches(t as unknown as Record<string, unknown>, args.where)), args.orderBy);
        return rows.slice(0, args.take ?? rows.length).map((t) => project(t, args.select));
      }),
    ),
    update: vi.fn((args: { where: { id: string }; data: Record<string, unknown> }) =>
      lazy(() => {
        const t = store.transactions.find((row) => row.id === args.where.id);
        if (!t) throw prismaError('P2025', 'Record to update not found.');
        updateData(t, args.data);
        return project(t);
      }),
    ),
    updateMany: vi.fn((args: { where: Where; data: Record<string, unknown> }) =>
      lazy(() => {
        const rows = store.transactions.filter((t) => matches(t as unknown as Record<string, unknown>, args.where));
        for (const t of rows) updateData(t, args.data);
        return { count: rows.length };
      }),
    ),
  },
  transactionExternalRef: {
    findMany: vi.fn((args: { where?: Where; select?: Record<string, boolean> }) =>
      lazy(() => store.refs.filter((r) => matches(r as unknown as Record<string, unknown>, args.where)).map((r) => ({ ...r }))),
    ),
    createMany: vi.fn((args: { data: Array<Omit<FakeExternalRef, 'id'>>; skipDuplicates?: boolean }) =>
      lazy(() => insertRefs(args.data, args.skipDuplicates ?? false)),
    ),
    create: vi.fn((args: { data: Omit<FakeExternalRef, 'id'> }) => lazy(() => insertRefs([args.data], false))),
    deleteMany: vi.fn((args: { where: Where }) =>
      lazy(() => {
        const before = store.refs.length;
        store.refs = store.refs.filter((r) => !matches(r as unknown as Record<string, unknown>, args.where));
        return { count: before - store.refs.length };
      }),
    ),
  },
  account: {
    findFirst: vi.fn((args: { where?: Where; select?: Record<string, boolean> }) =>
      lazy(() => {
        const account = store.accounts.find((a) => matches(a as unknown as Record<string, unknown>, args.where));
        return account ? { ...account } : null;
      }),
    ),
  },
  category: {
    findMany: vi.fn((args: { where?: Where }) =>
      lazy(() => store.categories.filter((c) => matches(c as unknown as Record<string, unknown>, args.where)).map((c) => ({ ...c }))),
    ),
  },
  $transaction: vi.fn(async (operations: Array<{ exec: () => Promise<unknown> }>) => {
    const saved = snapshot();
    try {
      const results: unknown[] = [];
      for (const operation of operations) results.push(await operation.exec());
      return results;
    } catch (error) {
      Object.assign(store, saved);
      throw error;
    }
  }),
};

function isoDay(year: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

/** Invoice period of a card month ('YYYY-MM'): closing day of the previous month to the day before this one's. */
function invoicePeriod(cardId: string, month: string): { start: string; end: string } {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1;
  const closingDay = store.accounts.find((a) => a.id === cardId)?.closingDay ?? null;
  if (closingDay) return { start: isoDay(year, index - 1, closingDay), end: isoDay(year, index, closingDay - 1) };
  return { start: isoDay(year, index, 1), end: isoDay(year, index + 1, 0) };
}

/** The invoice's technical id, as transactions.service writes it (zero-based month). */
function technicalId(cardId: string, month: string): string {
  return `invoice_pay:${cardId}:${Number(month.slice(0, 4))}-${Number(month.slice(5, 7)) - 1}`;
}

export const fakeServices = {
  createTransaction: vi.fn(async (input: Record<string, unknown>) => {
    const row = insertTransaction({
      householdId: input.householdId as string,
      accountId: (input.accountId as string) ?? null,
      type: input.type as FakeTransaction['type'],
      categoryName: (input.categoryName as string) ?? null,
      amount: input.amount as number,
      description: (input.description as string) ?? null,
      date: toDay(input.date),
      notes: (input.notes as string) ?? null,
      paid: input.paid !== false,
      sourceRef: (input.sourceRef as string) ?? null,
      installmentId: (input.installmentId as string) ?? null,
      installmentNumber: (input.installmentNumber as number) ?? null,
      totalInstallments: (input.totalInstallments as number) ?? null,
    });
    return { ...row };
  }),
  deleteTransaction: vi.fn(async (id: string, householdId: string) => {
    const before = store.transactions.length;
    store.transactions = store.transactions.filter((t) => !(t.id === id && t.householdId === householdId));
    if (store.transactions.length === before) throw prismaError('NOT_FOUND', 'Transaction not found');
    store.refs = store.refs.filter((r) => r.transactionId !== id);
  }),
  updateTransaction: vi.fn(async (id: string, householdId: string, input: Record<string, unknown>) => {
    const t = store.transactions.find((row) => row.id === id && row.householdId === householdId);
    if (!t) throw prismaError('NOT_FOUND', 'Transaction not found');
    updateData(t, input);
    return { ...t };
  }),
  /** Records the payment; marks the card's unpaid purchases of the invoice period as paid (like step 8 of the real one). */
  payCreditCardInvoice: vi.fn(async (input: Record<string, unknown>) => {
    const month = input.month as string;
    const period = invoicePeriod(input.accountId as string, month);
    const payment = insertTransaction({
      householdId: input.householdId as string,
      accountId: input.sourceAccountId as string,
      type: 'EXPENSE',
      categoryName: 'OTHER_EXPENSES',
      amount: input.amount as number,
      description: (input.description as string) ?? null,
      date: toDay(input.paymentDate),
      attachmentUrl: technicalId(input.accountId as string, month),
    });
    for (const t of store.transactions) {
      if (t.accountId === input.accountId && !t.paid && t.attachmentUrl === null && t.date >= period.start && t.date <= period.end) {
        t.paid = true;
      }
    }
    return { paymentTransaction: { ...payment } };
  }),
  /** Deletes the payment and, like the real one, marks unpaid every card purchase from the invoice start to its date. */
  undoCreditCardPayment: vi.fn(async (input: { accountId: string; transactionId: string }, householdId: string) => {
    const payment = store.transactions.find((t) => t.id === input.transactionId && t.householdId === householdId);
    if (!payment?.attachmentUrl) throw prismaError('NOT_FOUND', 'Payment transaction not found');
    const [, , key] = payment.attachmentUrl.split(':');
    const [year, monthIndex] = key!.split('-').map(Number);
    const { start } = invoicePeriod(input.accountId, `${year}-${String(monthIndex! + 1).padStart(2, '0')}`);
    for (const t of store.transactions) {
      if (t.accountId === input.accountId && t.paid && t.attachmentUrl === null && t.date >= start && t.date <= payment.date) {
        t.paid = false;
      }
    }
    store.transactions = store.transactions.filter((t) => t.id !== payment.id);
    return { undoneTransaction: { ...payment } };
  }),
  createCategory: vi.fn(async (input: { householdId: string; name: string; type: 'INCOME' | 'EXPENSE' }) => {
    const category = { id: nextId('cat'), householdId: input.householdId, name: input.name, type: input.type };
    store.categories.push(category);
    return { ...category };
  }),
};

/** Seed helpers. */
export function seedAccount(account: Partial<FakeAccount> & Pick<FakeAccount, 'id' | 'householdId'>): FakeAccount {
  const row: FakeAccount = { name: account.id, type: 'CHECKING', isActive: true, dueDay: null, closingDay: null, ...account };
  store.accounts.push(row);
  return row;
}

export function seedTransaction(data: Partial<FakeTransaction> & { householdId: string }): FakeTransaction {
  return insertTransaction(data);
}

export function seedRef(data: Omit<FakeExternalRef, 'id'>): void {
  insertRefs([data], false);
}

export function seedCategory(data: Omit<FakeCategory, 'id'> & { id?: string }): FakeCategory {
  const category = { id: data.id ?? nextId('cat'), ...data };
  store.categories.push(category);
  return category;
}
