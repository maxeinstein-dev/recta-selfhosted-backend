/**
 * In-memory stand-in for the Prisma calls the recurring-transactions module, the monthly-sheet importer and the
 * "follow the last amount" rule make. Dates are 'YYYY-MM-DD' days (read back as UTC midnight, like a @db.Date
 * column), amounts are numbers (read back as decimal-likes), interactive transactions are all-or-nothing, and
 * transaction.sourceRef is unique per household (P2002), like the real table.
 */
import { vi } from 'vitest';
import { dayString } from '../recurring-dates.js';

type Row = Record<string, unknown> & { id: string };
type Where = Record<string, unknown>;

const SPECS: Record<string, { unique: string[][]; defaults: () => Record<string, unknown> }> = {
  transaction: {
    unique: [['householdId', 'sourceRef']],
    defaults: () => ({
      description: null, notes: null, sourceRef: null, paid: true, accountId: null, recurringTransactionId: null,
      installmentId: null, installmentNumber: null, totalInstallments: null, attachmentUrl: null, type: 'EXPENSE',
    }),
  },
  recurringTransaction: {
    unique: [],
    defaults: () => ({ description: null, endDate: null, lastRunDate: null, isActive: true, followLastAmount: false, frequency: 'MONTHLY' }),
  },
  account: { unique: [], defaults: () => ({ balance: 0, isActive: true, type: 'CHECKING', name: 'Conta' }) },
  category: { unique: [], defaults: () => ({}) },
};

type Store = Record<string, Row[]>;
export const store: Store = {};
let sequence = 0;

export function resetStore(): void {
  for (const name of Object.keys(SPECS)) store[name] = [];
  sequence = 0;
}
resetStore();

function prismaError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function toStored(field: string, value: unknown): unknown {
  if (value instanceof Date) return dayString(value);
  if (field === 'amount' && value !== null && typeof value === 'object') return Number(String(value));
  return value;
}

function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    const value = row[key];
    if (condition === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (typeof condition !== 'object' || condition instanceof Date) {
      if (value !== toStored(key, condition)) return false;
      continue;
    }
    const c = condition as Record<string, unknown>;
    if ('in' in c && !(c.in as unknown[]).includes(value)) return false;
    if ('not' in c && (c.not === null ? value === null || value === undefined : value === c.not)) return false;
    if ('gte' in c && !(String(value) >= String(toStored(key, c.gte)))) return false;
    if ('gt' in c && !(String(value) > String(toStored(key, c.gt)))) return false;
    if ('lte' in c && !(String(value) <= String(toStored(key, c.lte)))) return false;
    if ('contains' in c && !(typeof value === 'string' && value.includes(c.contains as string))) return false;
    if ('lt' in c && !(String(value) < String(toStored(key, c.lt)))) return false;
  }
  return true;
}

const decimal = (n: number) => ({ toNumber: () => n, toString: () => n.toFixed(2), equals: (other: { toNumber(): number }) => other.toNumber() === n });

function project(row: Row, select?: Record<string, boolean>): Record<string, unknown> {
  const full: Record<string, unknown> = { ...row };
  if (typeof row.amount === 'number') full.amount = decimal(row.amount);
  for (const f of ['date', 'startDate', 'nextRunAt', 'endDate', 'lastRunDate']) {
    if (typeof row[f] === 'string') full[f] = new Date(`${row[f]}T00:00:00.000Z`);
  }
  if (!select) return full;
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, full[k]]));
}

/** `include: { account: ... }` on a row that has an accountId. */
function withInclude(out: Record<string, unknown>, row: Row, include?: Record<string, unknown>): Record<string, unknown> {
  if (include?.account) {
    const account = store.account!.find((a) => a.id === row.accountId);
    out.account = account ? { id: account.id, name: account.name, type: account.type } : null;
  }
  return out;
}

function build(name: string, data: Record<string, unknown>): Row {
  sequence += 1;
  const row: Row = { id: `${name}-${String(sequence).padStart(5, '0')}`, createdAt: sequence, ...SPECS[name]!.defaults() } as Row;
  for (const [field, value] of Object.entries(data)) if (value !== undefined) row[field] = toStored(field, value);
  return row;
}

function collides(name: string, candidate: Row, others: Row[]): boolean {
  return SPECS[name]!.unique.some((fields) => {
    if (fields.some((f) => candidate[f] === null || candidate[f] === undefined)) return false;
    return others.some((o) => o !== candidate && fields.every((f) => o[f] === candidate[f]));
  });
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<Record<string, 'asc' | 'desc'>>;
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const [field, direction] = Object.entries(key)[0]!;
      const av = a[field] as string | number;
      const bv = b[field] as string | number;
      if (av === bv) continue;
      return (av < bv ? -1 : 1) * (direction === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

function table(name: string) {
  const rows = () => store[name]!;
  return {
    findMany: vi.fn(async (args: { where?: Where; select?: Record<string, boolean>; orderBy?: unknown; include?: Record<string, unknown> } = {}) =>
      sortRows(rows().filter((r) => matches(r, args.where)), args.orderBy).map((r) => withInclude(project(r, args.select), r, args.include))),
    findFirst: vi.fn(async (args: { where?: Where; select?: Record<string, boolean>; orderBy?: unknown; include?: Record<string, unknown> } = {}) => {
      const found = sortRows(rows().filter((r) => matches(r, args.where)), args.orderBy)[0];
      return found ? withInclude(project(found, args.select), found, args.include) : null;
    }),
    findUnique: vi.fn(async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
      const found = rows().find((r) => r.id === args.where.id);
      return found ? project(found, args.select) : null;
    }),
    create: vi.fn(async (args: { data: Record<string, unknown>; select?: Record<string, boolean>; include?: Record<string, unknown> }) => {
      const row = build(name, args.data);
      if (collides(name, row, rows())) throw prismaError('P2002', `Unique constraint failed: ${name}`);
      rows().push(row);
      return withInclude(project(row, args.select), row, args.include);
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows().find((r) => r.id === args.where.id);
      if (!row) throw prismaError('P2025', 'Record to update not found.');
      const next: Row = { ...row };
      for (const [field, value] of Object.entries(args.data)) next[field] = toStored(field, value);
      if (collides(name, next, rows().filter((r) => r !== row))) throw prismaError('P2002', 'Unique constraint failed');
      Object.assign(row, next);
      return project(row);
    }),
    groupBy: vi.fn(async (args: { by: string[]; where?: Where; _max: Record<string, boolean> }) => {
      const field = args.by[0]!;
      const groups = new Map<unknown, Row[]>();
      for (const r of rows().filter((row) => matches(row, args.where))) {
        const list = groups.get(r[field]) ?? [];
        list.push(r);
        groups.set(r[field], list);
      }
      return [...groups.entries()].map(([key, list]) => {
        const out: Record<string, unknown> = { [field]: key, _max: {} };
        for (const f of Object.keys(args._max)) {
          const top = list.map((r) => r[f] as string).sort().pop();
          (out._max as Record<string, unknown>)[f] = top === undefined ? null : new Date(`${top}T00:00:00.000Z`);
        }
        return out;
      });
    }),
    updateMany: vi.fn(async (args: { where?: Where; data: Record<string, unknown> }) => {
      const found = rows().filter((r) => matches(r, args.where));
      for (const row of found) for (const [field, value] of Object.entries(args.data)) row[field] = toStored(field, value);
      return { count: found.length };
    }),
  };
}

function snapshot(): Store {
  return Object.fromEntries(Object.entries(store).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
}

export const fakePrisma = {
  transaction: table('transaction'),
  recurringTransaction: table('recurringTransaction'),
  account: table('account'),
  category: table('category'),
  /** External refs (card statement import) do not exist in these scenarios: nothing is linked. */
  transactionExternalRef: {
    findMany: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    createMany: vi.fn(async () => ({ count: 0 })),
  },
  /** Row locks (SELECT ... FOR UPDATE) have nothing to lock in memory. */
  $queryRaw: vi.fn(async () => []),
  /** The advisory lock apply takes (no real locking; tests look at the calls). */
  $executeRaw: vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    if (!strings.join('?').includes('pg_advisory_xact_lock')) throw new Error(`Unexpected raw query: ${strings.join('?')}`);
    return 0;
  }),
  $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    const saved = snapshot();
    try {
      return await callback(fakePrisma);
    } catch (error) {
      for (const key of Object.keys(store)) delete store[key];
      Object.assign(store, saved);
      throw error;
    }
  }),
};

// ---- Transactions service stand-ins (they keep the account balance like the real one) -----------------------

function move(account: Row | undefined, type: unknown, amount: number, sign: 1 | -1): void {
  if (!account) return;
  const delta = (type === 'INCOME' ? 1 : -1) * sign * amount;
  account.balance = Math.round(((account.balance as number) + delta) * 100) / 100;
}

export const fakeServices = {
  createTransaction: vi.fn(async (input: Record<string, unknown>, _userId?: string, hooks?: { inTransaction?: (tx: unknown, created: { id: string }) => Promise<void> }) => {
    const account = store.account!.find((a) => a.id === input.accountId);
    if (!account) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
    const row = build('transaction', {
      householdId: input.householdId, accountId: input.accountId, type: input.type ?? 'EXPENSE', categoryName: input.categoryName,
      amount: input.amount, description: input.description ?? null, date: input.date, notes: input.notes ?? null,
      paid: input.paid !== false, sourceRef: input.sourceRef ?? null, recurringTransactionId: input.recurringTransactionId ?? null,
    });
    if (collides('transaction', row, store.transaction!)) throw prismaError('P2002', 'Unique constraint failed');
    const saved = snapshot();
    store.transaction!.push(row);
    if (row.paid) move(account, row.type, row.amount as number, 1);
    if (hooks?.inTransaction) {
      try {
        await hooks.inTransaction(fakePrisma, { id: row.id });
      } catch (error) {
        for (const key of Object.keys(store)) delete store[key];
        Object.assign(store, saved);
        throw error;
      }
    }
    return { ...project(row), amount: row.amount };
  }),
  /** Same balance rules as the real updateTransaction for amount and paid changes; hooks run in the transaction. */
  updateTransaction: vi.fn(
    async (id: string, householdId: string, input: Record<string, unknown>, hooks?: { inTransaction?: (tx: unknown) => Promise<void> }) => {
      const row = store.transaction!.find((t) => t.id === id && t.householdId === householdId);
      if (!row) throw Object.assign(new Error('Transaction not found'), { statusCode: 404 });
      const account = store.account!.find((a) => a.id === row.accountId);
      const saved = snapshot();
      try {
        if (row.paid) move(account, row.type, row.amount as number, -1);
        const next: Row = { ...row };
        for (const [field, value] of Object.entries(input)) if (value !== undefined) next[field] = toStored(field, value);
        if (collides('transaction', next, store.transaction!.filter((t) => t !== row))) throw prismaError('P2002', 'Unique constraint failed');
        Object.assign(row, next);
        if (row.paid) move(account, row.type, row.amount as number, 1);
        if (hooks?.inTransaction) await hooks.inTransaction(fakePrisma);
      } catch (error) {
        for (const key of Object.keys(store)) delete store[key];
        Object.assign(store, saved);
        throw error;
      }
      return { ...project(row), amount: row.amount };
    },
  ),
  deleteTransaction: vi.fn(async (id: string, householdId: string) => {
    const row = store.transaction!.find((t) => t.id === id && t.householdId === householdId);
    if (!row) throw Object.assign(new Error('Transaction not found'), { statusCode: 404 });
    if (row.paid) move(store.account!.find((a) => a.id === row.accountId), row.type, row.amount as number, -1);
    store.transaction = store.transaction!.filter((t) => t !== row);
  }),
  reset(): void {
    fakeServices.createTransaction.mockClear();
    fakeServices.updateTransaction.mockClear();
  },
};

// ---- Seed helpers -------------------------------------------------------------------------------------------

export function seedAccount(data: { id: string; householdId: string; name?: string; type?: string; balance?: number }): Row {
  const row = build('account', data);
  store.account!.push(row);
  return row;
}

export interface SeedTx {
  id?: string;
  householdId: string;
  accountId: string;
  description: string | null;
  amount: number;
  /** YYYY-MM-DD */
  date: string;
  type?: 'INCOME' | 'EXPENSE';
  paid?: boolean;
  categoryName?: string;
  sourceRef?: string | null;
  recurringTransactionId?: string | null;
  installmentId?: string | null;
  installmentNumber?: number | null;
  totalInstallments?: number | null;
  attachmentUrl?: string | null;
}

export function seedTransaction(data: SeedTx): Row {
  const row = build('transaction', { categoryName: 'OTHER_EXPENSES', ...data });
  store.transaction!.push(row);
  return row;
}

export interface SeedRecurrence {
  id?: string;
  householdId: string;
  accountId: string;
  description: string | null;
  amount: number;
  /** YYYY-MM-DD */
  nextRunAt: string;
  startDate?: string;
  categoryName?: string;
  frequency?: string;
  isActive?: boolean;
  followLastAmount?: boolean;
  endDate?: string | null;
}

export function seedRecurrence(data: SeedRecurrence): Row {
  const row = build('recurringTransaction', { categoryName: 'UTILITIES', startDate: data.nextRunAt, ...data });
  store.recurringTransaction!.push(row);
  return row;
}

export const rowsOf = (name: keyof typeof SPECS): Row[] => store[name]!;
export const rowById = (name: keyof typeof SPECS, id: string): Row => store[name]!.find((r) => r.id === id)!;
