import { beforeEach, describe, expect, it, vi } from 'vitest';
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

// The forecast strategies through the service, on the in-memory database. Invented data only.
const HH = '11111111-1111-4111-8111-111111111111';
const ACC = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  seedAccount({ id: ACC, householdId: HH, name: 'Conta Teste', balance: 0 });
});

const occurrences = (recurringId: string) => rowsOf('transaction').filter((t) => t.recurringTransactionId === recurringId);
const confirmed = (recId: string, amounts: number[], opts: { category?: string; type?: 'INCOME' | 'EXPENSE' } = {}) =>
  amounts.forEach((amount, i) =>
    // newest first in the list: the first amount gets the latest month
    seedTransaction({
      householdId: HH, accountId: ACC, description: 'x', amount, date: `2026-0${9 - i}-05`, paid: true, recurringTransactionId: recId,
      type: opts.type ?? 'INCOME', categoryName: opts.category ?? 'SALARY',
    }));

describe('execute: the occurrence is born with the strategy amount', () => {
  it('LAST (the default of an existing recurrence): the stored amount, as before the strategies existed', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Vale', amount: 500, nextRunAt: '2026-10-05', categoryName: 'SALARY' });
    confirmed(rec.id, [300]);
    await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 9, 5) });
    expect(occurrences(rec.id).find((t) => t.date === '2026-10-05')).toMatchObject({ amount: 500, type: 'INCOME' });
  });

  it('FIXED: the typed amount, not the confirmed ones', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Vale', amount: 500, nextRunAt: '2026-10-05', categoryName: 'SALARY', forecastStrategy: 'FIXED' });
    confirmed(rec.id, [300, 200]);
    await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 9, 5) });
    expect(occurrences(rec.id).find((t) => t.date === '2026-10-05')).toMatchObject({ amount: 500 });
  });

  it('CONSERVATIVE income: the smallest of the last 6 CONFIRMED (a pending one and an older one do not count)', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Vale', amount: 500, nextRunAt: '2026-10-05', categoryName: 'SALARY', forecastStrategy: 'CONSERVATIVE' });
    // 7 confirmed (newest first): the 7th (50) is older than the window of 6
    [700, 650, 800, 720, 690, 710, 50].forEach((amount, i) =>
      seedTransaction({ householdId: HH, accountId: ACC, description: 'x', amount, date: `2026-03-${String(20 - i).padStart(2, '0')}`, paid: true, recurringTransactionId: rec.id, type: 'INCOME', categoryName: 'SALARY' }));
    // a pending occurrence with a tiny value, newer than all
    seedTransaction({ householdId: HH, accountId: ACC, description: 'x', amount: 10, date: '2026-09-05', paid: false, recurringTransactionId: rec.id, type: 'INCOME', categoryName: 'SALARY' });
    await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 9, 5) });
    expect(occurrences(rec.id).find((t) => t.date === '2026-10-05')).toMatchObject({ amount: 650 });
  });

  it('CONSERVATIVE expense: the largest of the last 3; the window of the recurrence overrides the default', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Luz', amount: 80, nextRunAt: '2026-10-05', categoryName: 'UTILITIES', forecastStrategy: 'CONSERVATIVE' });
    confirmed(rec.id, [100, 120, 110, 900], { type: 'EXPENSE', category: 'UTILITIES' });
    await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 9, 5) });
    expect(occurrences(rec.id).find((t) => t.date === '2026-10-05')).toMatchObject({ amount: 120, type: 'EXPENSE' });

    const wide = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Agua', amount: 80, nextRunAt: '2026-10-05', categoryName: 'UTILITIES', forecastStrategy: 'CONSERVATIVE', forecastWindow: 4 });
    confirmed(wide.id, [100, 120, 110, 900], { type: 'EXPENSE', category: 'UTILITIES' });
    await executeRecurringTransaction(wide.id, HH, { date: new Date(2026, 9, 5) });
    expect(occurrences(wide.id).find((t) => t.date === '2026-10-05')).toMatchObject({ amount: 900 });
  });

  it('CONSERVATIVE with fewer confirmed than N uses those; with none, the recurrence amount', async () => {
    const some = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Vale', amount: 500, nextRunAt: '2026-10-05', categoryName: 'SALARY', forecastStrategy: 'CONSERVATIVE' });
    confirmed(some.id, [420, 380]);
    await executeRecurringTransaction(some.id, HH, { date: new Date(2026, 9, 5) });
    expect(occurrences(some.id).find((t) => t.date === '2026-10-05')).toMatchObject({ amount: 380 });

    const none = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Bonus', amount: 90, nextRunAt: '2026-10-05', categoryName: 'SALARY', forecastStrategy: 'CONSERVATIVE' });
    await executeRecurringTransaction(none.id, HH, { date: new Date(2026, 9, 5) });
    expect(occurrences(none.id)[0]).toMatchObject({ amount: 90 });
  });

  it('PER_BUSINESS_DAY with an offset: the business days of the MONTH IT COUNTS FOR (deposited 25/10, counts for 11/2026)', async () => {
    const rec = seedRecurrence({
      householdId: HH, accountId: ACC, description: 'Vale', amount: 1, nextRunAt: '2026-10-25', categoryName: 'SALARY',
      forecastStrategy: 'PER_BUSINESS_DAY', dailyRate: 36, competenceOffsetMonths: 1,
    });
    await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 9, 25) });
    // 19 business days in 2026-11 x 36,00; the month of the date (october, 21 days) must not be used
    expect(occurrences(rec.id)[0]).toMatchObject({ amount: 684, competenceMonth: '2026-11', date: '2026-10-25' });
  });

  it('PER_BUSINESS_DAY without an offset uses the month of the date, with the safety margin and "dias sem vale"', async () => {
    const rec = seedRecurrence({
      householdId: HH, accountId: ACC, description: 'Vale', amount: 1, nextRunAt: '2026-12-01', categoryName: 'SALARY',
      forecastStrategy: 'PER_BUSINESS_DAY', dailyRate: 36, safetyBusinessDays: 1, nonWorkingDays: ['12-24'],
    });
    await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 11, 1) });
    // december 2026: 22 business days, 24/12 (Thursday) is a "dia sem vale" -> 21, minus 1 of margin -> 20
    expect(occurrences(rec.id)[0]).toMatchObject({ amount: 720 });
  });

  it('the occurrence of a PAID execution moves the balance by the strategy amount', async () => {
    const rec = seedRecurrence({
      householdId: HH, accountId: ACC, description: 'Vale', amount: 1, nextRunAt: '2026-12-01', categoryName: 'SALARY',
      forecastStrategy: 'PER_BUSINESS_DAY', dailyRate: 36,
    });
    const { updateBalanceForNormalTransaction } = await import('../../shared/services/balance.service.js');
    await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 11, 1), paid: true });
    expect(updateBalanceForNormalTransaction).toHaveBeenCalledWith(expect.anything(), ACC, 792);
  });

  it('a confirmed value joins the history that the next occurrence reads (CONSERVATIVE learns it)', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Vale', amount: 500, nextRunAt: '2026-10-05', categoryName: 'SALARY', forecastStrategy: 'CONSERVATIVE' });
    confirmed(rec.id, [600, 640]);
    // the user confirms a lower value in a pending occurrence: it is now the smallest of the confirmed ones
    seedTransaction({ householdId: HH, accountId: ACC, description: 'x', amount: 560, date: '2026-09-25', paid: true, recurringTransactionId: rec.id, type: 'INCOME', categoryName: 'SALARY' });
    await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 9, 5) });
    expect(occurrences(rec.id).find((t) => t.date === '2026-10-05')).toMatchObject({ amount: 560 });
  });
});

describe('a confirmed value does not overwrite the amount of FIXED, CONSERVATIVE or PER_BUSINESS_DAY', () => {
  const NOW = new Date(2026, 9, 5, 12, 0, 0);
  const confirmLast = async (strategy: 'LAST' | 'FIXED' | 'CONSERVATIVE' | 'PER_BUSINESS_DAY') => {
    const rec = seedRecurrence({
      householdId: HH, accountId: ACC, description: 'Vale', amount: 500, nextRunAt: '2026-11-05', categoryName: 'SALARY',
      forecastStrategy: strategy, followLastAmount: true, ...(strategy === 'PER_BUSINESS_DAY' ? { dailyRate: 36 } : {}),
    });
    const occ = seedTransaction({ householdId: HH, accountId: ACC, description: 'Vale', amount: 500, date: '2026-10-05', paid: false, recurringTransactionId: rec.id, type: 'INCOME', categoryName: 'SALARY' });
    const before = { id: occ.id, householdId: HH, recurringTransactionId: rec.id, date: new Date('2026-10-05T00:00:00.000Z'), amount: 500 };
    const followed = await followLastAmountInTx(fakePrisma as never, before, { amount: 640 }, NOW);
    return { rec, followed };
  };

  it('LAST (with followLastAmount) still adopts it: today\'s behaviour', async () => {
    const { rec, followed } = await confirmLast('LAST');
    expect(followed).toEqual({ id: rec.id, amount: 640 });
    expect(rowById('recurringTransaction', rec.id).amount).toBe(640);
  });
  for (const strategy of ['FIXED', 'CONSERVATIVE', 'PER_BUSINESS_DAY'] as const) {
    it(`${strategy}: the recurrence amount stays`, async () => {
      const { rec, followed } = await confirmLast(strategy);
      expect(followed).toBeNull();
      expect(rowById('recurringTransaction', rec.id).amount).toBe(500);
    });
  }
});

describe('list: what the next occurrence is expected to carry', () => {
  it('PER_BUSINESS_DAY: reference month with the offset, business days, rate, margin and amount', async () => {
    seedRecurrence({
      householdId: HH, accountId: ACC, description: 'Vale', amount: 1, nextRunAt: '2026-10-25', categoryName: 'SALARY',
      forecastStrategy: 'PER_BUSINESS_DAY', dailyRate: 36, safetyBusinessDays: 2, competenceOffsetMonths: 1,
    });
    const [row] = await listRecurringTransactions({ householdId: HH });
    expect(row).toMatchObject({
      dailyRate: 36,
      forecast: { strategy: 'PER_BUSINESS_DAY', referenceMonth: '2026-11', amount: 612, businessDays: 19, safetyBusinessDays: 2, countedBusinessDays: 17, dailyRate: 36 },
    });
  });

  it('CONSERVATIVE reads the confirmed history; LAST just echoes the amount; dailyRate is null when unset', async () => {
    const cons = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Salario', amount: 500, nextRunAt: '2026-10-05', categoryName: 'SALARY', forecastStrategy: 'CONSERVATIVE' });
    confirmed(cons.id, [700, 640, 800]);
    seedRecurrence({ householdId: HH, accountId: ACC, description: 'Luz', amount: 90, nextRunAt: '2026-10-07', categoryName: 'UTILITIES' });
    const rows = await listRecurringTransactions({ householdId: HH });
    const byName = Object.fromEntries(rows.map((r) => [r.description, r]));
    expect(byName.Salario).toMatchObject({ forecast: { strategy: 'CONSERVATIVE', referenceMonth: '2026-10', amount: 640, window: 6, usedValues: [700, 640, 800] } });
    expect(byName.Luz).toMatchObject({ dailyRate: null, forecast: { strategy: 'LAST', amount: 90, referenceMonth: '2026-10' } });
  });
});

describe('create and update', () => {
  const base = { householdId: HH, accountId: ACC, categoryName: 'SALARY', amount: 700, frequency: 'MONTHLY', startDate: '2099-01-05', nextRunAt: '2099-01-05' };
  const parse = (extra: Record<string, unknown>) => createRecurringTransactionSchema.parse({ ...base, ...extra });

  it('a recurrence created the old way is LAST with neutral parameters', async () => {
    const input = parse({});
    expect(input).toMatchObject({ forecastStrategy: 'LAST', safetyBusinessDays: 0, nonWorkingDays: [], optionalHolidays: [] });
    const created = await createRecurringTransaction(input);
    expect(rowById('recurringTransaction', created.id)).toMatchObject({ forecastStrategy: 'LAST', forecastWindow: null, dailyRate: null, safetyBusinessDays: 0 });
  });

  it('stores the PER_BUSINESS_DAY fields (normalized) and answers dailyRate as a number', async () => {
    const created = await createRecurringTransaction(
      parse({ forecastStrategy: 'PER_BUSINESS_DAY', dailyRate: 36, safetyBusinessDays: 1, nonWorkingDays: ['07-08', '06-24', '06-24'], optionalHolidays: ['CARNIVAL', 'CARNIVAL'] }),
    );
    expect(created.dailyRate).toBe(36);
    expect(rowById('recurringTransaction', created.id)).toMatchObject({ dailyRate: 36, safetyBusinessDays: 1, nonWorkingDays: ['06-24', '07-08'], optionalHolidays: ['CARNIVAL'] });
  });

  it('refuses PER_BUSINESS_DAY without a daily rate, and on a non-monthly recurrence', async () => {
    await expect(createRecurringTransaction(parse({ forecastStrategy: 'PER_BUSINESS_DAY' }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(createRecurringTransaction(parse({ forecastStrategy: 'PER_BUSINESS_DAY', dailyRate: 36, frequency: 'WEEKLY' }))).rejects.toMatchObject({ statusCode: 400 });
    expect(rowsOf('recurringTransaction')).toHaveLength(0);
  });

  it('a strategy other than LAST does not keep followLastAmount', async () => {
    const created = await createRecurringTransaction(parse({ forecastStrategy: 'FIXED', followLastAmount: true }));
    expect(rowById('recurringTransaction', created.id).followLastAmount).toBe(false);
    const last = await createRecurringTransaction(parse({ followLastAmount: true }));
    expect(rowById('recurringTransaction', last.id).followLastAmount).toBe(true);
  });

  it('update: switching the strategy validates the merged recurrence and clears followLastAmount', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Vale', amount: 500, nextRunAt: '2099-01-05', categoryName: 'SALARY', followLastAmount: true });
    await expect(updateRecurringTransaction(rec.id, HH, updateRecurringTransactionSchema.parse({ forecastStrategy: 'PER_BUSINESS_DAY' }))).rejects.toMatchObject({ statusCode: 400 });
    expect(rowById('recurringTransaction', rec.id)).toMatchObject({ forecastStrategy: 'LAST', followLastAmount: true });

    const updated = await updateRecurringTransaction(rec.id, HH, updateRecurringTransactionSchema.parse({ forecastStrategy: 'PER_BUSINESS_DAY', dailyRate: 36 }));
    expect(updated).toMatchObject({ forecastStrategy: 'PER_BUSINESS_DAY', dailyRate: 36, followLastAmount: false });
    // a later edit that does not mention the rate keeps it and stays valid
    await updateRecurringTransaction(rec.id, HH, updateRecurringTransactionSchema.parse({ safetyBusinessDays: 1 }));
    expect(rowById('recurringTransaction', rec.id)).toMatchObject({ dailyRate: 36, safetyBusinessDays: 1 });
    // the rate cannot be cleared while the strategy needs it
    await expect(updateRecurringTransaction(rec.id, HH, updateRecurringTransactionSchema.parse({ dailyRate: null }))).rejects.toMatchObject({ statusCode: 400 });
  });

  it('update: back to LAST, the other parameters stay stored but unused', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Vale', amount: 500, nextRunAt: '2099-01-05', categoryName: 'SALARY', forecastStrategy: 'PER_BUSINESS_DAY', dailyRate: 36 });
    await updateRecurringTransaction(rec.id, HH, updateRecurringTransactionSchema.parse({ forecastStrategy: 'LAST', followLastAmount: true }));
    expect(rowById('recurringTransaction', rec.id)).toMatchObject({ forecastStrategy: 'LAST', followLastAmount: true, dailyRate: 36 });
  });
});

describe('request validation', () => {
  const base = { accountId: ACC, categoryName: 'SALARY', amount: 700, frequency: 'MONTHLY', startDate: '2026-10-05', nextRunAt: '2026-10-05' };

  it('refuses an unknown strategy, a window out of 1..36, a non-positive rate, a negative or huge margin', () => {
    for (const bad of [
      { forecastStrategy: 'MEDIAN' }, { forecastWindow: 0 }, { forecastWindow: 37 }, { forecastWindow: 1.5 },
      { dailyRate: 0 }, { dailyRate: -3 }, { safetyBusinessDays: -1 }, { safetyBusinessDays: 32 }, { safetyBusinessDays: 1.5 },
    ]) {
      expect(createRecurringTransactionSchema.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it('refuses a "dia sem vale" that is not MM-DD or YYYY-MM-DD, or a holiday that does not exist', () => {
    expect(createRecurringTransactionSchema.safeParse({ ...base, nonWorkingDays: ['24/06'] }).success).toBe(false);
    expect(createRecurringTransactionSchema.safeParse({ ...base, nonWorkingDays: ['02-30'] }).success).toBe(false);
    expect(createRecurringTransactionSchema.safeParse({ ...base, optionalHolidays: ['EASTER'] }).success).toBe(false);
    expect(createRecurringTransactionSchema.safeParse({ ...base, nonWorkingDays: ['06-24', '2026-07-08'], optionalHolidays: ['CORPUS_CHRISTI'] }).success).toBe(true);
  });
  it('update accepts null for the window and the rate (clears them)', () => {
    expect(updateRecurringTransactionSchema.parse({ forecastWindow: null, dailyRate: null })).toEqual({ forecastWindow: null, dailyRate: null });
  });
});
