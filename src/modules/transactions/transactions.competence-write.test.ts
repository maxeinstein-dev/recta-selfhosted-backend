import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetStore,
  rowById,
  rowsOf,
  seedAccount,
  seedRecurrence,
  seedTransaction,
} from '../recurring-transactions/__fixtures__/recurring-fake-db.js';
import { followLastAmountInTx } from '../recurring-transactions/recurring-follow.js';
import { executeRecurringTransaction, createRecurringTransaction, updateRecurringTransaction, listRecurringTransactions } from '../recurring-transactions/recurring-transactions.service.js';
import { createRecurringTransactionSchema, updateRecurringTransactionSchema } from '../recurring-transactions/recurring-transactions.schema.js';
import { createTransactionSchema, updateTransactionSchema, listTransactionsQuerySchema } from './transactions.schema.js';
import { createTransaction, updateTransaction } from './transactions.service.js';
import { updateBalanceForNormalTransaction } from '../../shared/services/balance.service.js';

vi.mock('../../shared/db/prisma.js', async () => ({
  prisma: (await import('../recurring-transactions/__fixtures__/recurring-fake-db.js')).fakePrisma,
}));
vi.mock('../../shared/services/balance.service.js', () => ({
  updateBalanceForNormalTransaction: vi.fn(async () => undefined),
  recalculateCreditCardLimit: vi.fn(async () => undefined),
}));
vi.mock('../notifications/budget-notifications.service.js', () => ({ checkBudgetThresholds: vi.fn(async () => undefined) }));

// Invented data only.
const HH = 'hh-1';
const ACC = 'acc-bank';
const UUID = '3f2b8c1e-6a4d-4e0b-9c55-0d1f2a3b4c5d';

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  seedAccount({ id: ACC, householdId: HH, name: 'Conta Teste', balance: 1000 });
});

describe('transaction schemas: competenceMonth', () => {
  const create = { accountId: UUID, categoryName: 'SALARY', amount: 100, date: '2026-09-25' };
  it('accepts a YYYY-MM on create, and absent or null (no reference month)', () => {
    expect(createTransactionSchema.parse({ ...create, competenceMonth: '2026-10' }).competenceMonth).toBe('2026-10');
    expect(createTransactionSchema.parse(create).competenceMonth).toBeUndefined();
    expect(createTransactionSchema.parse({ ...create, competenceMonth: null }).competenceMonth).toBeNull();
  });
  it.each(['2026-13', '2026-00', '2026-1', '26-10', '2026/10', '2026-10-01', '', 'outubro'])('refuses %s', (bad) => {
    expect(createTransactionSchema.safeParse({ ...create, competenceMonth: bad }).success).toBe(false);
    expect(updateTransactionSchema.safeParse({ competenceMonth: bad }).success).toBe(false);
  });
  it('update: a month sets it, null clears it, absent leaves it alone', () => {
    expect(updateTransactionSchema.parse({ competenceMonth: '2026-10' }).competenceMonth).toBe('2026-10');
    expect(updateTransactionSchema.parse({ competenceMonth: null }).competenceMonth).toBeNull();
    expect('competenceMonth' in updateTransactionSchema.parse({ amount: 5 })).toBe(false);
  });
  it('refuses a reference month on a transfer or an allocation', () => {
    const base = { amount: 10, date: '2026-09-25', fromAccountId: UUID, toAccountId: UUID, accountId: UUID, relatedEntityId: UUID };
    expect(createTransactionSchema.safeParse({ ...base, type: 'TRANSFER', competenceMonth: '2026-10' }).success).toBe(false);
    expect(createTransactionSchema.safeParse({ ...base, type: 'ALLOCATION', competenceMonth: '2026-10' }).success).toBe(false);
    expect(createTransactionSchema.safeParse({ ...base, type: 'TRANSFER' }).success).toBe(true);
  });
  it('the list query takes paid=true|false and rejects anything else', () => {
    expect(listTransactionsQuerySchema.parse({ paid: 'false' }).paid).toBe(false);
    expect(listTransactionsQuerySchema.parse({ paid: 'true' }).paid).toBe(true);
    expect(listTransactionsQuerySchema.parse({}).paid).toBeUndefined();
    expect(listTransactionsQuerySchema.safeParse({ paid: 'maybe' }).success).toBe(false);
  });
});

describe('recurrence schemas: competenceOffsetMonths', () => {
  const create = { accountId: UUID, categoryName: 'SALARY', amount: 100, frequency: 'MONTHLY', startDate: '2026-10-25', nextRunAt: '2026-10-25' };
  it('accepts an integer 0..12, absent or null', () => {
    expect(createRecurringTransactionSchema.parse({ ...create, competenceOffsetMonths: 1 }).competenceOffsetMonths).toBe(1);
    expect(createRecurringTransactionSchema.parse({ ...create, competenceOffsetMonths: 12 }).competenceOffsetMonths).toBe(12);
    expect(createRecurringTransactionSchema.parse({ ...create, competenceOffsetMonths: 0 }).competenceOffsetMonths).toBe(0);
    expect(createRecurringTransactionSchema.parse(create).competenceOffsetMonths).toBeUndefined();
    expect(createRecurringTransactionSchema.parse({ ...create, competenceOffsetMonths: null }).competenceOffsetMonths).toBeNull();
  });
  it.each([-1, 13, 1.5, '1'])('refuses %s', (bad) => {
    expect(createRecurringTransactionSchema.safeParse({ ...create, competenceOffsetMonths: bad }).success).toBe(false);
    expect(updateRecurringTransactionSchema.safeParse({ competenceOffsetMonths: bad }).success).toBe(false);
  });
  it('update: null clears it', () => {
    expect(updateRecurringTransactionSchema.parse({ competenceOffsetMonths: null }).competenceOffsetMonths).toBeNull();
  });
});

describe('createTransaction with a reference month', () => {
  const input = { householdId: HH, accountId: ACC, categoryName: 'OTHER_INCOME', type: 'INCOME' as const, amount: 500, description: 'Vale', date: new Date(2026, 8, 25), paid: true, isSplit: false };

  it('stores it and returns it; the balance moves once by the amount (the month does not matter for money)', async () => {
    const created = await createTransaction({ ...input, competenceMonth: '2026-10' } as never);
    expect(created).toMatchObject({ competenceMonth: '2026-10', amount: 500 });
    expect(rowsOf('transaction')[0]).toMatchObject({ competenceMonth: '2026-10', date: '2026-09-25' });
    expect(updateBalanceForNormalTransaction).toHaveBeenCalledTimes(1);
    expect(updateBalanceForNormalTransaction).toHaveBeenCalledWith(expect.anything(), ACC, 500);
  });

  it('leaves it null when not given (old behaviour)', async () => {
    await createTransaction(input as never);
    expect(rowsOf('transaction')[0]!.competenceMonth).toBeNull();
  });

  it('refuses a reference month more than 24 months from the date', async () => {
    await expect(createTransaction({ ...input, competenceMonth: '2028-09' } as never)).resolves.toBeTruthy();
    await expect(createTransaction({ ...input, competenceMonth: '2028-10' } as never)).rejects.toMatchObject({ statusCode: 400 });
    await expect(createTransaction({ ...input, competenceMonth: '2024-08' } as never)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('updateTransaction with a reference month', () => {
  function pending(over: Record<string, unknown> = {}) {
    return seedTransaction({ householdId: HH, accountId: ACC, description: 'Vale', amount: 500, type: 'INCOME', categoryName: 'OTHER_INCOME', date: '2026-09-25', paid: false, competenceMonth: '2026-10', ...over });
  }

  it('sets, changes and clears the reference month', async () => {
    const t = pending({ competenceMonth: null });
    await updateTransaction(t.id, HH, { competenceMonth: '2026-11' });
    expect(rowById('transaction', t.id).competenceMonth).toBe('2026-11');
    await updateTransaction(t.id, HH, { competenceMonth: null });
    expect(rowById('transaction', t.id).competenceMonth).toBeNull();
  });

  it('leaves it alone when the update does not mention it', async () => {
    const t = pending();
    await updateTransaction(t.id, HH, { description: 'Vale refeicao' });
    expect(rowById('transaction', t.id).competenceMonth).toBe('2026-10');
  });

  it('refuses a month out of the 24-month window, and a date edit that leaves the stored month out of it', async () => {
    const t = pending();
    await expect(updateTransaction(t.id, HH, { competenceMonth: '2029-01' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(updateTransaction(t.id, HH, { date: new Date(2029, 0, 10) })).rejects.toMatchObject({ statusCode: 400 });
    expect(rowById('transaction', t.id)).toMatchObject({ competenceMonth: '2026-10', date: '2026-09-25' });
  });

  it('refuses a reference month on a transfer row', async () => {
    const t = seedTransaction({ householdId: HH, accountId: ACC, description: 'Mover', amount: 50, date: '2026-09-25' });
    (t as Record<string, unknown>).type = 'TRANSFER';
    await expect(updateTransaction(t.id, HH, { competenceMonth: '2026-10' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('confirming receipt (amount + date + paid) moves the balance once with the actual amount, keeps the reference month and follows the amount', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Vale', amount: 500, nextRunAt: '2026-10-25', startDate: '2026-09-25', categoryName: 'OTHER_INCOME', followLastAmount: true, competenceOffsetMonths: 1 });
    const t = pending({ recurringTransactionId: rec.id });
    const update = { amount: 520, date: new Date(2026, 8, 27), paid: true };
    await updateTransaction(t.id, HH, update, {
      inTransaction: async (tx) => {
        await followLastAmountInTx(tx, { id: t.id, householdId: HH, recurringTransactionId: rec.id, date: new Date('2026-09-25T00:00:00Z'), amount: 500 }, update, new Date(2026, 8, 27));
      },
    });
    expect(rowById('transaction', t.id)).toMatchObject({ amount: 520, date: '2026-09-27', paid: true, competenceMonth: '2026-10' });
    expect(rowById('recurringTransaction', rec.id).amount).toBe(520);
    expect(updateBalanceForNormalTransaction).toHaveBeenCalledTimes(1);
    expect(updateBalanceForNormalTransaction).toHaveBeenCalledWith(expect.anything(), ACC, 520);

    // The same confirmation again (double click): already paid with the same values, so the balance does not move again
    await updateTransaction(t.id, HH, update);
    expect(updateBalanceForNormalTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('recurrence with a competence offset', () => {
  const rec = (over: Record<string, unknown> = {}) =>
    seedRecurrence({ householdId: HH, accountId: ACC, description: 'Vale', amount: 500, nextRunAt: '2026-09-25', startDate: '2026-09-25', categoryName: 'OTHER_INCOME', ...over });

  it('an occurrence is born with the month of its date plus the offset', async () => {
    const r = rec({ competenceOffsetMonths: 1 });
    await executeRecurringTransaction(r.id, HH, { date: new Date(2026, 8, 25) });
    expect(rowsOf('transaction')[0]).toMatchObject({ date: '2026-09-25', competenceMonth: '2026-10', paid: false, type: 'INCOME' });
  });

  it('crosses the year (Dec + 1 = Jan) and supports 2 months', async () => {
    const a = rec({ competenceOffsetMonths: 1, nextRunAt: '2026-12-25', startDate: '2026-12-25' });
    await executeRecurringTransaction(a.id, HH, { date: new Date(2026, 11, 25) });
    const b = rec({ competenceOffsetMonths: 2, description: 'Outro', nextRunAt: '2026-11-25', startDate: '2026-11-25' });
    await executeRecurringTransaction(b.id, HH, { date: new Date(2026, 10, 25) });
    const months = rowsOf('transaction').map((t) => t.competenceMonth);
    expect(months).toEqual(['2027-01', '2027-01']);
  });

  it('offset 0 stamps the month of the date; no offset leaves the reference month null (regression)', async () => {
    const zero = rec({ competenceOffsetMonths: 0 });
    await executeRecurringTransaction(zero.id, HH, { date: new Date(2026, 8, 25) });
    const none = rec({ description: 'Sem', nextRunAt: '2026-09-26', startDate: '2026-09-26' });
    await executeRecurringTransaction(none.id, HH, { date: new Date(2026, 8, 26) });
    const txs = rowsOf('transaction');
    expect(txs.find((t) => t.recurringTransactionId === zero.id)!.competenceMonth).toBe('2026-09');
    expect(txs.find((t) => t.recurringTransactionId === none.id)!.competenceMonth).toBeNull();
  });

  it('a skipped run (the month already has its occurrence) does not stamp or create anything', async () => {
    const r = rec({ competenceOffsetMonths: 1 });
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Vale', amount: 480, date: '2026-09-02', recurringTransactionId: r.id, competenceMonth: null });
    const result = await executeRecurringTransaction(r.id, HH, { date: new Date(2026, 8, 25) });
    expect(result.skipped).toBe(true);
    expect(rowsOf('transaction')).toHaveLength(1);
    expect(rowsOf('transaction')[0]!.competenceMonth).toBeNull();
  });

  it('create and update store the offset and the list returns it; null clears; existing occurrences are not rewritten', async () => {
    const created = await createRecurringTransaction({
      householdId: HH, accountId: ACC, categoryName: 'OTHER_INCOME', amount: 500, description: 'Vale', frequency: 'MONTHLY',
      startDate: new Date(2027, 0, 25), nextRunAt: new Date(2027, 0, 25), isActive: true, followLastAmount: true, competenceOffsetMonths: 1,
    } as never);
    expect(created.competenceOffsetMonths).toBe(1);
    const old = seedTransaction({ householdId: HH, accountId: ACC, description: 'Vale', amount: 500, date: '2026-12-25', recurringTransactionId: created.id, competenceMonth: '2027-01' });
    const updated = await updateRecurringTransaction(created.id, HH, { competenceOffsetMonths: 2 });
    expect(updated.competenceOffsetMonths).toBe(2);
    expect(rowById('transaction', old.id).competenceMonth).toBe('2027-01');
    const listed = await listRecurringTransactions({ householdId: HH } as never);
    expect(listed[0]).toMatchObject({ id: created.id, competenceOffsetMonths: 2 });
    const cleared = await updateRecurringTransaction(created.id, HH, { competenceOffsetMonths: null });
    expect(cleared.competenceOffsetMonths).toBeNull();
    const untouched = await updateRecurringTransaction(created.id, HH, { description: 'Vale 2' });
    expect(untouched.competenceOffsetMonths).toBeNull();
  });
});
