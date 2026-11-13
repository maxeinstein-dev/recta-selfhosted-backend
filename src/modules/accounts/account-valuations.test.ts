import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';

const db = vi.hoisted(() => ({
  account: vi.fn(),
  upsert: vi.fn(),
  list: vi.fn(),
  findOne: vi.fn(),
  del: vi.fn(),
}));

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    account: { findFirst: db.account },
    accountValuation: { upsert: db.upsert, findMany: db.list, findFirst: db.findOne, delete: db.del },
  },
}));

const { listValuations, saveValuation, deleteValuation, valuationBodySchema } = await import('./account-valuations.js');

// Invented data only.
const dec = (n: number) => new Prisma.Decimal(n);
const row = (id: string, date: string, amount: number) => ({ id, accountId: 'a1', date: new Date(`${date}T00:00:00Z`), amount: dec(amount) });

beforeEach(() => {
  vi.clearAllMocks();
  db.account.mockResolvedValue({ id: 'a1', type: 'INVESTMENT' });
});

describe('valuationBodySchema', () => {
  it('accepts a past day and an amount with at most two decimals', () => {
    expect(valuationBodySchema.parse({ date: '2026-09-30', amount: 10500.5 })).toEqual({ date: '2026-09-30', amount: 10500.5 });
    expect(valuationBodySchema.parse({ date: '2026-09-30', amount: '0' }).amount).toBe(0);
  });

  it.each([
    ['a negative amount', { date: '2026-09-30', amount: -1 }],
    ['three decimals', { date: '2026-09-30', amount: 1.005 }],
    ['null', { date: '2026-09-30', amount: null }],
    ['false', { date: '2026-09-30', amount: false }],
    ['a bad date', { date: '30/09/2026', amount: 1 }],
    ['an impossible day', { date: '2026-02-31', amount: 1 }],
    ['a future day', { date: '2999-01-01', amount: 1 }],
  ])('rejects %s', (_name, body) => {
    expect(valuationBodySchema.safeParse(body).success).toBe(false);
  });
});

describe('saveValuation', () => {
  it('stores one value per account and day (upsert) and returns it in reais', async () => {
    db.upsert.mockResolvedValue(row('v1', '2026-09-30', 10500.5));
    const out = await saveValuation('a1', 'h1', { date: '2026-09-30', amount: 10500.5 });
    expect(db.account).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'a1', householdId: 'h1' } }));
    const arg = db.upsert.mock.calls[0]![0];
    expect(arg.where).toEqual({ accountId_date: { accountId: 'a1', date: new Date('2026-09-30T00:00:00Z') } });
    expect(arg.create.amount.toFixed(2)).toBe('10500.50');
    expect(arg.update.amount.toFixed(2)).toBe('10500.50');
    expect(out).toEqual({ id: 'v1', accountId: 'a1', date: '2026-09-30', amount: 10500.5 });
  });

  it('refuses an account of another household without writing', async () => {
    db.account.mockResolvedValue(null);
    await expect(saveValuation('a1', 'other', { date: '2026-09-30', amount: 1 })).rejects.toThrow(/not found/i);
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it.each(['CHECKING', 'SAVINGS', 'CASH', 'CREDIT'])('refuses a %s account: only investments have a market value', async (type) => {
    db.account.mockResolvedValue({ id: 'a1', type });
    await expect(saveValuation('a1', 'h1', { date: '2026-09-30', amount: 1 })).rejects.toThrow(/investment/i);
    expect(db.upsert).not.toHaveBeenCalled();
  });
});

describe('listValuations', () => {
  it('lists the newest first, as day strings and numbers', async () => {
    db.list.mockResolvedValue([row('v2', '2026-10-31', 11000), row('v1', '2026-09-30', 10500.5)]);
    const out = await listValuations('a1', 'h1');
    expect(db.list.mock.calls[0]![0].orderBy).toEqual({ date: 'desc' });
    expect(out.map((v) => [v.date, v.amount])).toEqual([['2026-10-31', 11000], ['2026-09-30', 10500.5]]);
  });

  it('refuses an account of another household', async () => {
    db.account.mockResolvedValue(null);
    await expect(listValuations('a1', 'other')).rejects.toThrow(/not found/i);
    expect(db.list).not.toHaveBeenCalled();
  });
});

describe('deleteValuation', () => {
  it('deletes only a value that belongs to that account of that household', async () => {
    db.findOne.mockResolvedValue(row('v1', '2026-09-30', 1));
    await deleteValuation('a1', 'h1', 'v1');
    expect(db.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'v1', accountId: 'a1', account: { householdId: 'h1' } } }));
    expect(db.del).toHaveBeenCalledWith({ where: { id: 'v1' } });
  });

  it('answers not found for a value of someone else', async () => {
    db.findOne.mockResolvedValue(null);
    await expect(deleteValuation('a1', 'h1', 'v9')).rejects.toThrow(/not found/i);
    expect(db.del).not.toHaveBeenCalled();
  });
});
