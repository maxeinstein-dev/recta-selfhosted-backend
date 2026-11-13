import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountType, CategoryName, TransactionType } from '../../shared/enums/index.js';

// Payments are tagged `invoice_pay:<cardId>:<YYYY>-<zero-based month>` and dated on/after the closing day of the
// invoice they pay, i.e. in the NEXT window. They must be counted by tag, and only once their date has come.
type Row = {
  id: string;
  accountId: string | null;
  householdId: string;
  date: Date;
  amount: { toNumber: () => number };
  categoryName: string | null;
  type: string;
  attachmentUrl: string | null;
  paid: boolean;
};

const store = vi.hoisted(() => ({ rows: [] as unknown[] }));
const updates = vi.hoisted(() => ({ updateMany: vi.fn(), create: vi.fn(), accountUpdate: vi.fn(), deleted: vi.fn() }));

function matches(row: Row, where: Record<string, any>): boolean {
  if (where.OR) return (where.OR as Record<string, any>[]).some((w) => matches(row, w));
  for (const [key, cond] of Object.entries(where)) {
    const value = (row as any)[key];
    if (key === 'date') {
      const t = row.date.getTime();
      if (cond.gte && t < cond.gte.getTime()) return false;
      if (cond.gt && t <= cond.gt.getTime()) return false;
      if (cond.lte && t > cond.lte.getTime()) return false;
      if (cond.lt && t >= cond.lt.getTime()) return false;
    } else if (cond !== null && typeof cond === 'object') {
      if ('equals' in cond && value !== cond.equals) return false;
      if ('startsWith' in cond && !(typeof value === 'string' && value.startsWith(cond.startsWith))) return false;
      if ('not' in cond && value === cond.not) return false;
    } else if (value !== cond) return false;
  }
  return true;
}

const accounts = vi.hoisted(() => ({ byId: {} as Record<string, unknown> }));

const transactionApi = {
  findMany: vi.fn(async (args: { where: Record<string, any>; take?: number }) => {
    const found = (store.rows as Row[]).filter((r) => matches(r, args.where));
    return args.take ? found.slice(0, args.take) : found;
  }),
  findFirst: vi.fn(async (args: { where: Record<string, any> }) => (store.rows as Row[]).find((r) => matches(r, args.where)) ?? null),
  count: vi.fn(async (args: { where: Record<string, any> }) => (store.rows as Row[]).filter((r) => matches(r, args.where)).length),
  create: vi.fn(async (args: { data: Record<string, any> }) => {
    updates.create(args);
    return { id: 'new-payment', ...args.data };
  }),
  updateMany: vi.fn(async (args: unknown) => {
    updates.updateMany(args);
    return { count: 0 };
  }),
  delete: vi.fn(async (args: unknown) => updates.deleted(args)),
};
const accountApi = {
  findFirst: vi.fn(async (args: { where: { id: string } }) => accounts.byId[args.where.id] ?? null),
  findUnique: vi.fn(async (args: { where: { id: string } }) => accounts.byId[args.where.id] ?? null),
  update: vi.fn(async (args: unknown) => {
    updates.accountUpdate(args);
    return {};
  }),
};

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    account: accountApi,
    transaction: transactionApi,
    recurringTransaction: { findMany: async () => [] },
    $transaction: async (cb: (tx: unknown) => unknown) => cb({ account: accountApi, transaction: transactionApi }),
  },
}));
vi.mock('../../shared/services/balance.service.js', () => ({
  recalculateCreditCardLimit: vi.fn(),
  applyTransfer: vi.fn(),
  applyAllocation: vi.fn(),
  applyDeallocation: vi.fn(),
  updateBalanceForNormalTransaction: vi.fn(),
}));

const {
  calculateCreditCardInvoice,
  payCreditCardInvoice,
  undoCreditCardPayment,
  parseInvoicePaymentOrdinal,
  utcToday,
} = await import('./transactions.service.js');

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const decimal = (value: number) => ({ toNumber: () => value });
const CARD = { id: 'card-1', householdId: 'house-1', type: AccountType.CREDIT, isActive: true, closingDay: 10, dueDay: 25, balance: decimal(0) };
const SOURCE = { id: 'bank-1', householdId: 'house-1', type: AccountType.CHECKING, isActive: true, balance: decimal(10000) };
const TODAY = day('2026-10-06');

let seq = 0;
const purchase = (date: string, amount: number): Row => ({
  id: `p${++seq}`,
  accountId: CARD.id,
  householdId: CARD.householdId,
  date: day(date),
  amount: decimal(amount),
  categoryName: CategoryName.OTHER_EXPENSES,
  type: TransactionType.EXPENSE,
  attachmentUrl: null,
  paid: false,
});
/** `invoiceMonth` is 1-based (YYYY-MM) as the API speaks; the tag is zero-based. */
const payment = (date: string, amount: number, invoiceMonth: string): Row => {
  const [y, m] = invoiceMonth.split('-').map(Number);
  return {
    id: `pay${++seq}`,
    accountId: SOURCE.id,
    householdId: CARD.householdId,
    date: day(date),
    amount: decimal(amount),
    categoryName: CategoryName.OTHER_EXPENSES,
    type: TransactionType.EXPENSE,
    attachmentUrl: `invoice_pay:${CARD.id}:${y}-${m - 1}`,
    paid: true,
  };
};

const invoice = async (month: string, today: Date = TODAY) =>
  (await calculateCreditCardInvoice(CARD.id, month, CARD.householdId, { limit: 5 }, { today })).data;

// The opening debt of a card with no transaction before the invoice month. It must be what was owed before the month,
// never the card's current balance: that balance already holds the purchases of later invoices.
const withBalance = (balance: number) => {
  accounts.byId = { ...accounts.byId, [CARD.id]: { ...CARD, balance: decimal(balance) } };
};

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  store.rows = [];
  accounts.byId = { [CARD.id]: CARD, [SOURCE.id]: SOURCE };
});

describe('invoice opening debt of a card with no earlier history', () => {
  it('a new card with one purchase of 800 on 03/11 (closing day 10): the purchase is in November only', async () => {
    store.rows = [purchase('2026-11-03', 800)];
    withBalance(800); // updated by the purchase, as the card balance is
    const oct = await invoice('2026-10');
    expect(oct.previousBalance).toBe(0);
    expect(oct.total).toBe(0);
    const nov = await invoice('2026-11');
    expect(nov.previousBalance).toBe(0);
    expect(nov.currentExpenses).toBe(800);
    expect(nov.total).toBe(800);
    expect(nov.dueDate).toBe('2026-11-25');
  });

  it('December carries November only as the unpaid November invoice, not the purchase a second time', async () => {
    store.rows = [purchase('2026-11-03', 800)];
    withBalance(800);
    const dec = await invoice('2026-12');
    expect(dec.previousBalance).toBe(800);
    expect(dec.currentExpenses).toBe(0);
    expect(dec.total).toBe(800);
  });

  it('a later purchase does not leak into an earlier month either (the balance includes everything after the month)', async () => {
    store.rows = [purchase('2026-11-03', 800), purchase('2026-12-02', 300)];
    withBalance(1100);
    const oct = await invoice('2026-10');
    expect(oct.previousBalance).toBe(0);
    expect(oct.total).toBe(0);
    const nov = await invoice('2026-11');
    expect(nov.previousBalance).toBe(0);
    expect(nov.total).toBe(800);
  });
});

describe('invoice opening debt of a card with history (unchanged)', () => {
  it('earlier purchases set the opening debt; the balance is not used', async () => {
    store.rows = [purchase('2026-09-05', 300), purchase('2026-11-03', 800)];
    withBalance(1100);
    const oct = await invoice('2026-10');
    expect(oct.previousBalance).toBe(300);
    expect(oct.total).toBe(300);
    const nov = await invoice('2026-11');
    expect(nov.previousBalance).toBe(300);
    expect(nov.currentExpenses).toBe(800);
    expect(nov.total).toBe(1100);
  });
});
