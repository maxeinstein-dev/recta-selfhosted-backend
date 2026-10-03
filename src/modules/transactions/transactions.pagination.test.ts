import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountType } from '../../shared/enums/index.js';

// Cursor pagination is delegated to Prisma, so the guard is the shape of the paginated query: a total order
// (ending on the unique id) plus the cursor. A date-only order made the invoice pages overlap and skip rows.
const db = vi.hoisted(() => ({
  accountFindFirst: vi.fn(),
  transactionFindMany: vi.fn(),
  transactionFindFirst: vi.fn(),
  transactionCount: vi.fn(),
}));

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    account: { findFirst: db.accountFindFirst },
    transaction: { findMany: db.transactionFindMany, findFirst: db.transactionFindFirst, count: db.transactionCount },
  },
}));

const { PAGINATED_TRANSACTION_ORDER, calculateCreditCardInvoice, listTransactions } = await import('./transactions.service.js');

const decimal = (value: number) => ({ toNumber: () => value });
const CARD = { id: 'card-1', householdId: 'house-1', type: AccountType.CREDIT, isActive: true, closingDay: 2, dueDay: 9, balance: decimal(0) };

/** The findMany call that pages (the one asking for one row more than the limit). */
function pagedCall(limit: number): Record<string, unknown> {
  const call = db.transactionFindMany.mock.calls.map(([args]) => args as Record<string, unknown>).find((args) => args.take === limit + 1);
  expect(call, 'a findMany with take = limit + 1').toBeDefined();
  return call!;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.accountFindFirst.mockResolvedValue(CARD);
  db.transactionFindMany.mockResolvedValue([]);
  db.transactionFindFirst.mockResolvedValue(null);
  db.transactionCount.mockResolvedValue(0);
});

describe('paginated transaction order', () => {
  it('is a total order that ends on the unique id', () => {
    expect(PAGINATED_TRANSACTION_ORDER).toEqual([{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]);
  });
});

describe('calculateCreditCardInvoice pagination', () => {
  it('orders the first page by the total order', async () => {
    await calculateCreditCardInvoice(CARD.id, '2026-10', CARD.householdId, { limit: 25 });

    const call = pagedCall(25);
    expect(call.orderBy).toEqual(PAGINATED_TRANSACTION_ORDER);
    expect(call.cursor).toBeUndefined();
  });

  it('continues after the cursor row with the same order', async () => {
    await calculateCreditCardInvoice(CARD.id, '2026-10', CARD.householdId, { limit: 25, cursor: 'tx-25' });

    const call = pagedCall(25);
    expect(call.orderBy).toEqual(PAGINATED_TRANSACTION_ORDER);
    expect(call.cursor).toEqual({ id: 'tx-25' });
    expect(call.skip).toBe(1);
  });
});

describe('listTransactions pagination', () => {
  it('uses the same total order', async () => {
    await listTransactions({ householdId: CARD.householdId, limit: 20, cursor: 'tx-20' } as Parameters<typeof listTransactions>[0]);

    const call = pagedCall(20);
    expect(call.orderBy).toEqual(PAGINATED_TRANSACTION_ORDER);
    expect(call.cursor).toEqual({ id: 'tx-20' });
  });
});
