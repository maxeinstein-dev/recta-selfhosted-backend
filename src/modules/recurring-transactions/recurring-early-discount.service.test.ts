import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePrisma, resetStore, rowById, rowsOf, seedAccount, seedRecurrence, seedTransaction } from './__fixtures__/recurring-fake-db.js';
import { followLastAmountInTx } from './recurring-follow.js';
import { createRecurringTransactionSchema, updateRecurringTransactionSchema } from './recurring-transactions.schema.js';

vi.mock('../../shared/db/prisma.js', async () => ({
  prisma: (await import('./__fixtures__/recurring-fake-db.js')).fakePrisma,
}));
vi.mock('../../shared/services/balance.service.js', () => ({
  updateBalanceForNormalTransaction: vi.fn(async () => undefined),
  recalculateCreditCardLimit: vi.fn(async () => undefined),
}));

const { createRecurringTransaction, executeRecurringTransaction, listRecurringTransactions, updateRecurringTransaction } = await import(
  './recurring-transactions.service.js'
);

// Early-payment discount through the service, on the in-memory database. Invented data only.
const HH = '11111111-1111-4111-8111-111111111111';
const ACC = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  seedAccount({ id: ACC, householdId: HH, name: 'Conta Teste', balance: 0 });
});
afterEach(() => vi.useRealTimers());

const occurrences = (recurringId: string) => rowsOf('transaction').filter((t) => t.recurringTransactionId === recurringId);
const base = { householdId: HH, accountId: ACC, categoryName: 'UTILITIES', amount: 200, frequency: 'MONTHLY', startDate: '2099-01-10', nextRunAt: '2099-01-10' };
const parse = (extra: Record<string, unknown>) => createRecurringTransactionSchema.parse({ ...base, ...extra });
const safe = (extra: Record<string, unknown>) => createRecurringTransactionSchema.safeParse({ ...base, ...extra });

describe('request validation (create)', () => {
  it('accepts day + type + value, or none of them', () => {
    expect(safe({}).success).toBe(true);
    expect(safe({ earlyDiscountDay: 8, earlyDiscountType: 'FIXED', earlyDiscountValue: 25 }).success).toBe(true);
    expect(safe({ earlyDiscountDay: 8, earlyDiscountType: 'PERCENT', earlyDiscountValue: 8 }).success).toBe(true);
    expect(safe({ earlyDiscountDay: null, earlyDiscountType: null, earlyDiscountValue: null }).success).toBe(true);
  });

  it('refuses type or value without the day, and a day without type and value', () => {
    expect(safe({ earlyDiscountType: 'FIXED', earlyDiscountValue: 25 }).success).toBe(false);
    expect(safe({ earlyDiscountValue: 25 }).success).toBe(false);
    expect(safe({ earlyDiscountType: 'FIXED' }).success).toBe(false);
    expect(safe({ earlyDiscountDay: 8 }).success).toBe(false);
    expect(safe({ earlyDiscountDay: 8, earlyDiscountType: 'FIXED' }).success).toBe(false);
    expect(safe({ earlyDiscountDay: 8, earlyDiscountValue: 25 }).success).toBe(false);
  });

  it('refuses a day outside 1..31 and an unknown type', () => {
    for (const earlyDiscountDay of [0, 32, -1, 8.5]) {
      expect(safe({ earlyDiscountDay, earlyDiscountType: 'FIXED', earlyDiscountValue: 25 }).success, String(earlyDiscountDay)).toBe(false);
    }
    expect(safe({ earlyDiscountDay: 8, earlyDiscountType: 'HALF', earlyDiscountValue: 25 }).success).toBe(false);
  });

  it('a fixed discount must be above zero and below the amount (it never leaves zero or less)', () => {
    const d = { earlyDiscountDay: 8, earlyDiscountType: 'FIXED' };
    expect(safe({ ...d, earlyDiscountValue: 0 }).success).toBe(false);
    expect(safe({ ...d, earlyDiscountValue: -5 }).success).toBe(false);
    expect(safe({ ...d, earlyDiscountValue: 200 }).success).toBe(false);
    expect(safe({ ...d, earlyDiscountValue: 250 }).success).toBe(false);
    expect(safe({ ...d, earlyDiscountValue: 199.99 }).success).toBe(true);
  });

  it('a percentage must be above 0 and below 100', () => {
    const d = { earlyDiscountDay: 8, earlyDiscountType: 'PERCENT' };
    for (const earlyDiscountValue of [0, -1, 100, 150]) expect(safe({ ...d, earlyDiscountValue }).success, String(earlyDiscountValue)).toBe(false);
    expect(safe({ ...d, earlyDiscountValue: 99.5 }).success).toBe(true);
  });

  it('refuses a discount on a negative amount', () => {
    expect(safe({ amount: -50, earlyDiscountDay: 8, earlyDiscountType: 'PERCENT', earlyDiscountValue: 5 }).success).toBe(false);
  });
});

describe('create', () => {
  it('stores the discount and answers the value as a number', async () => {
    const created = await createRecurringTransaction(parse({ earlyDiscountDay: 8, earlyDiscountType: 'PERCENT', earlyDiscountValue: 8 }));
    expect(created).toMatchObject({ earlyDiscountDay: 8, earlyDiscountType: 'PERCENT', earlyDiscountValue: 8, amount: 200 });
    expect(rowById('recurringTransaction', created.id)).toMatchObject({ earlyDiscountDay: 8, earlyDiscountType: 'PERCENT', earlyDiscountValue: 8 });
  });

  it('a recurrence without discount stores nulls and answers null (as before, plus three null fields)', async () => {
    const created = await createRecurringTransaction(parse({}));
    expect(created).toMatchObject({ earlyDiscountDay: null, earlyDiscountType: null, earlyDiscountValue: null });
  });
});

describe('update', () => {
  it('sets, changes and clears the discount', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Conta', amount: 200, nextRunAt: '2099-01-10' });
    const set = await updateRecurringTransaction(rec.id, HH, updateRecurringTransactionSchema.parse({ earlyDiscountDay: 8, earlyDiscountType: 'FIXED', earlyDiscountValue: 25 }));
    expect(set).toMatchObject({ earlyDiscountDay: 8, earlyDiscountType: 'FIXED', earlyDiscountValue: 25 });
    // only the value changes: merged with the stored day and type
    await updateRecurringTransaction(rec.id, HH, updateRecurringTransactionSchema.parse({ earlyDiscountValue: 30 }));
    expect(rowById('recurringTransaction', rec.id)).toMatchObject({ earlyDiscountDay: 8, earlyDiscountType: 'FIXED', earlyDiscountValue: 30 });
    const cleared = await updateRecurringTransaction(rec.id, HH, updateRecurringTransactionSchema.parse({ earlyDiscountDay: null, earlyDiscountType: null, earlyDiscountValue: null }));
    expect(cleared).toMatchObject({ earlyDiscountDay: null, earlyDiscountType: null, earlyDiscountValue: null });
  });

  it('refuses, with a 400, a merge that leaves the discount incomplete or incoherent', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Conta', amount: 200, nextRunAt: '2099-01-10' });
    // type and value without the day
    await expect(updateRecurringTransaction(rec.id, HH, updateRecurringTransactionSchema.parse({ earlyDiscountType: 'FIXED', earlyDiscountValue: 25 }))).rejects.toMatchObject({ statusCode: 400 });
    // clearing only the day of a stored discount
    const withDiscount = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Outra', amount: 200, nextRunAt: '2099-01-10', earlyDiscountDay: 8, earlyDiscountType: 'FIXED', earlyDiscountValue: 25 });
    await expect(updateRecurringTransaction(withDiscount.id, HH, updateRecurringTransactionSchema.parse({ earlyDiscountDay: null }))).rejects.toMatchObject({ statusCode: 400 });
    // lowering the amount below the stored fixed discount
    await expect(updateRecurringTransaction(withDiscount.id, HH, updateRecurringTransactionSchema.parse({ amount: 20 }))).rejects.toMatchObject({ statusCode: 400 });
    // a stored fixed discount of 25 turned into a percentage of 25 is fine; 100 is not (schema)
    expect(updateRecurringTransactionSchema.safeParse({ earlyDiscountType: 'PERCENT', earlyDiscountValue: 100 }).success).toBe(true);
    await expect(updateRecurringTransaction(withDiscount.id, HH, updateRecurringTransactionSchema.parse({ earlyDiscountType: 'PERCENT', earlyDiscountValue: 100 }))).rejects.toMatchObject({ statusCode: 400 });
    expect(rowById('recurringTransaction', withDiscount.id)).toMatchObject({ earlyDiscountType: 'FIXED', earlyDiscountValue: 25, amount: 200 });
  });
});

describe('list', () => {
  it('a recurrence without discount has no discount fields beyond the null columns', async () => {
    seedRecurrence({ householdId: HH, accountId: ACC, description: 'Conta', amount: 200, nextRunAt: '2099-01-10' });
    const [item] = await listRecurringTransactions({ householdId: HH });
    expect(item).toMatchObject({ earlyDiscountDay: null, earlyDiscountType: null, earlyDiscountValue: null });
    expect(item).not.toHaveProperty('earlyDiscount');
  });

  it('exposes the discount of the next occurrence while it can still be had', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2099, 0, 5, 12));
    seedRecurrence({ householdId: HH, accountId: ACC, description: 'Conta', amount: 200, nextRunAt: '2099-01-10', earlyDiscountDay: 8, earlyDiscountType: 'FIXED', earlyDiscountValue: 25 });
    const [item] = await listRecurringTransactions({ householdId: HH });
    // `amount` is still the full amount; the discount is on the side
    expect(item).toMatchObject({ amount: 200, earlyDiscount: { limitDate: '2099-01-08', fullAmount: 200, discountedAmount: 175, savings: 25 } });
  });
});

describe('execute: the occurrence is born with the amount the rule gives for the day it is generated', () => {
  const rule = { earlyDiscountDay: 8, earlyDiscountType: 'PERCENT', earlyDiscountValue: 8 } as const;

  it('generated up to the limit day: the discounted amount (percentage rounded up)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 11, 7, 9));
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Conta', amount: 123.45, nextRunAt: '2026-12-10', ...rule });
    await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 11, 10) });
    expect(occurrences(rec.id)[0]).toMatchObject({ amount: 113.58, date: '2026-12-10' });
    // the recurrence keeps the full amount
    expect(rowById('recurringTransaction', rec.id)).toMatchObject({ amount: 123.45 });
  });

  it('generated on the limit day itself: still discounted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 11, 8, 23, 30));
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Conta', amount: 200, nextRunAt: '2026-12-10', earlyDiscountDay: 8, earlyDiscountType: 'FIXED', earlyDiscountValue: 25 });
    await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 11, 10) });
    expect(occurrences(rec.id)[0]).toMatchObject({ amount: 175 });
  });

  it('generated after the limit day (the job runs on the due date): the full amount', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 11, 10, 1));
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Conta', amount: 200, nextRunAt: '2026-12-10', earlyDiscountDay: 8, earlyDiscountType: 'FIXED', earlyDiscountValue: 25 });
    await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 11, 10) });
    expect(occurrences(rec.id)[0]).toMatchObject({ amount: 200 });
  });

  it('a recurrence without discount is born exactly as before, whatever the day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 11, 7, 9));
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Conta', amount: 123.45, nextRunAt: '2026-12-10' });
    await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 11, 10) });
    expect(occurrences(rec.id)[0]).toMatchObject({ amount: 123.45 });
  });
});

describe('followLastAmount: a payment with the discount does not become the full amount', () => {
  const NOW = new Date(2026, 11, 8, 12);
  const before = (tx: ReturnType<typeof seedTransaction>) => ({
    id: tx.id,
    householdId: HH,
    recurringTransactionId: tx.recurringTransactionId as string | null,
    date: new Date(`${tx.date}T00:00:00.000Z`),
    amount: tx.amount as number,
  });
  const setup = (discount: Record<string, unknown>) => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Conta', amount: 200, nextRunAt: '2027-01-10', followLastAmount: true, ...discount });
    const tx = seedTransaction({ householdId: HH, accountId: ACC, description: 'Conta', amount: 200, date: '2026-12-10', paid: false, recurringTransactionId: rec.id });
    return { rec, tx };
  };
  const run = (tx: ReturnType<typeof seedTransaction>, amount: number) =>
    followLastAmountInTx(fakePrisma as never, before(tx), { amount }, NOW);

  it('fixed: paying the discounted amount leaves the recurrence at the full amount', async () => {
    const { rec, tx } = setup({ earlyDiscountDay: 8, earlyDiscountType: 'FIXED', earlyDiscountValue: 25 });
    expect(await run(tx, 175)).toBeNull();
    expect(rowById('recurringTransaction', rec.id).amount).toBe(200);
  });

  it('percentage: paying the discounted amount (rounded up) leaves it at the full amount', async () => {
    const { rec, tx } = setup({ amount: 123.45, earlyDiscountDay: 8, earlyDiscountType: 'PERCENT', earlyDiscountValue: 8 });
    expect(await run(tx, 113.58)).toBeNull();
    expect(rowById('recurringTransaction', rec.id).amount).toBe(123.45);
  });

  it('an amount that is neither the full nor the discounted one is still followed, as the new full price', async () => {
    const { rec, tx } = setup({ earlyDiscountDay: 8, earlyDiscountType: 'FIXED', earlyDiscountValue: 25 });
    expect(await run(tx, 230)).toEqual({ id: rec.id, amount: 230 });
    expect(rowById('recurringTransaction', rec.id).amount).toBe(230);
  });

  it('the full amount is not a change either (as before)', async () => {
    const { tx } = setup({ earlyDiscountDay: 8, earlyDiscountType: 'FIXED', earlyDiscountValue: 25 });
    expect(await run(tx, 200)).toBeNull();
  });

  it('without a discount, an amount equal to what would be a discount is followed, exactly as before', async () => {
    const { rec, tx } = setup({});
    expect(await run(tx, 175)).toEqual({ id: rec.id, amount: 175 });
  });
});
