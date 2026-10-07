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
const updates = vi.hoisted(() => ({ updateMany: vi.fn(), create: vi.fn(), accountUpdate: vi.fn() }));

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
  parseInvoicePaymentOrdinal,
  utcToday,
} = await import('./transactions.service.js');

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const decimal = (value: number) => ({ toNumber: () => value });
const CARD = { id: 'card-1', householdId: 'house-1', type: AccountType.CREDIT, isActive: true, closingDay: 2, dueDay: 9, balance: decimal(0) };
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

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  store.rows = [];
  accounts.byId = { [CARD.id]: CARD, [SOURCE.id]: SOURCE };
});

describe('parseInvoicePaymentOrdinal', () => {
  it('reads the zero-based tag month of this card only', () => {
    expect(parseInvoicePaymentOrdinal('invoice_pay:card-1:2026-9', 'card-1')).toBe(2026 * 12 + 9);
    expect(parseInvoicePaymentOrdinal('invoice_pay:card-1:2026-09', 'card-1')).toBe(2026 * 12 + 9);
    expect(parseInvoicePaymentOrdinal('invoice_pay:card-2:2026-9', 'card-1')).toBeNull();
    expect(parseInvoicePaymentOrdinal('invoice_pay:card-1:garbage', 'card-1')).toBeNull();
    expect(parseInvoicePaymentOrdinal(null, 'card-1')).toBeNull();
  });
});

describe('utcToday', () => {
  it('is the UTC date, whatever the local time zone offset of the instant', () => {
    expect(utcToday(new Date('2026-10-06T23:30:00-03:00'))).toEqual(day('2026-10-07'));
    expect(utcToday(new Date('2026-10-06T00:30:00+05:00'))).toEqual(day('2026-10-05'));
    expect(utcToday(new Date('2026-10-06T00:00:00.000Z'))).toEqual(day('2026-10-06'));
  });
});

describe('calculateCreditCardInvoice payments by invoice tag', () => {
  // Sep invoice (window 2026-08-02..2026-09-01) = 4793.57, paid 2026-09-02 (first day of the Oct window);
  // Oct invoice (window 2026-09-02..2026-10-01) = 5384.98, due 2026-10-09.
  const seedSepAndOct = () => {
    store.rows = [purchase('2026-08-20', 4793.57), purchase('2026-09-15', 5384.98)];
  };

  it('subtracts a payment dated after the closing day of its own invoice from the next previousBalance', async () => {
    seedSepAndOct();
    store.rows.push(payment('2026-09-02', 4793.57, '2026-09'));

    const oct = await invoice('2026-10');

    expect(oct.previousBalance).toBeCloseTo(0, 2);
    expect(oct.currentExpenses).toBeCloseTo(5384.98, 2);
    expect(oct.total).toBeCloseTo(5384.98, 2);
    expect(oct.isPaid).toBe(false);
  });

  it('does not count a payment dated in the future (unpaid until its date), neither as previous nor as current', async () => {
    seedSepAndOct();
    store.rows.push(payment('2026-09-02', 4793.57, '2026-09'), payment('2026-10-09', 5384.98, '2026-10'));

    const oct = await invoice('2026-10');
    expect(oct.currentPayments).toBe(0);
    expect(oct.total).toBeCloseTo(5384.98, 2);
    expect(oct.isPaid).toBe(false);

    // The same payment, once its date has come, is the invoice's own current payment
    const afterDue = await invoice('2026-10', day('2026-10-09'));
    expect(afterDue.currentPayments).toBeCloseTo(5384.98, 2);
    expect(afterDue.total).toBe(0);
    expect(afterDue.isPaid).toBe(true);

    // ...and a future payment for the invoice itself never leaks into the following invoice's carry
    const nov = await invoice('2026-11');
    expect(nov.previousBalance).toBeCloseTo(5384.98, 2);
  });

  it('counts a payment tagged for the same invoice as currentPayments even when dated after its closing', async () => {
    seedSepAndOct();
    store.rows.push(payment('2026-09-02', 4793.57, '2026-09'));

    const sep = await invoice('2026-09');

    expect(sep.currentPayments).toBeCloseTo(4793.57, 2);
    expect(sep.total).toBeCloseTo(0, 2);
    expect(sep.isPaid).toBe(true);
    expect(sep.paymentTransactions).toHaveLength(1);
  });

  it('keeps counting legacy payments dated inside the invoice window', async () => {
    seedSepAndOct();
    store.rows.push(payment('2026-09-20', 1000, '2026-10'));

    const oct = await invoice('2026-10');

    expect(oct.currentPayments).toBe(1000);
    expect(oct.total).toBeCloseTo(4384.98 + 4793.57, 2);
    expect(oct.isPaid).toBe(false);
  });

  it('does not subtract a payment tagged for a later invoice from an earlier one (advance payments)', async () => {
    seedSepAndOct();
    store.rows.push(payment('2026-08-25', 300, '2026-10'));

    const sep = await invoice('2026-09');
    expect(sep.previousBalance).toBe(0);
    expect(sep.currentPayments).toBe(0);

    const oct = await invoice('2026-10');
    expect(oct.currentPayments).toBe(300);
  });

  it('ignores payments of other cards', async () => {
    seedSepAndOct();
    const other = payment('2026-09-02', 4793.57, '2026-09');
    other.attachmentUrl = 'invoice_pay:card-2:2026-8';
    store.rows.push(other);

    expect((await invoice('2026-10')).previousBalance).toBeCloseTo(4793.57, 2);
  });

  it('counts a payment dated today and, by default, uses the UTC date of now', async () => {
    seedSepAndOct();
    store.rows.push(payment('2026-09-02', 4793.57, '2026-09'), payment('2026-10-06', 100, '2026-10'));
    vi.useFakeTimers();
    try {
      // 2026-10-06 22:00 in UTC-3 is already 2026-10-07 01:00 UTC: payment of the 6th is in the past either way
      vi.setSystemTime(new Date('2026-10-06T22:00:00-03:00'));
      const oct = (await calculateCreditCardInvoice(CARD.id, '2026-10', CARD.householdId, { limit: 5 })).data;
      expect(oct.currentPayments).toBe(100);

      // 2026-10-05 21:00 in UTC-3 is 2026-10-06 00:00 UTC: the payment dated the 6th (UTC date-only) counts
      vi.setSystemTime(new Date('2026-10-05T21:00:00-03:00'));
      const early = (await calculateCreditCardInvoice(CARD.id, '2026-10', CARD.householdId, { limit: 5 })).data;
      expect(early.currentPayments).toBe(100);

      vi.setSystemTime(new Date('2026-10-05T20:59:00-03:00'));
      const before = (await calculateCreditCardInvoice(CARD.id, '2026-10', CARD.householdId, { limit: 5 })).data;
      expect(before.currentPayments).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('payCreditCardInvoice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates the payment dated today, tagged with the invoice month, for the invoice remaining after earlier payments', async () => {
    store.rows = [purchase('2026-08-20', 4793.57), purchase('2026-09-15', 5384.98), payment('2026-09-02', 4793.57, '2026-09')];

    const result = await payCreditCardInvoice({
      householdId: CARD.householdId,
      accountId: CARD.id,
      sourceAccountId: SOURCE.id,
      month: '2026-10',
    } as never);

    expect(result.invoiceTotal).toBeCloseTo(5384.98, 2);
    expect(result.previousBalance).toBeCloseTo(0, 2);
    expect(updates.create).toHaveBeenCalledTimes(1);
    const data = updates.create.mock.calls[0][0].data;
    expect(data.attachmentUrl).toBe('invoice_pay:card-1:2026-9');
    expect(data.date).toEqual(new Date('2026-10-06T12:00:00Z'));
    expect(data.amount.toNumber()).toBeCloseTo(5384.98, 2);
  });

  it('finds a payment made today for the current statement when computing what is still owed', async () => {
    // Paid today (after the 2026-10-01 end of the window) for invoice 2026-10: nothing remains
    store.rows = [purchase('2026-09-15', 1000), payment('2026-10-06', 1000, '2026-10')];

    await expect(
      payCreditCardInvoice({ householdId: CARD.householdId, accountId: CARD.id, sourceAccountId: SOURCE.id, month: '2026-10' } as never)
    ).rejects.toThrow(/greater than zero/);
  });
});
