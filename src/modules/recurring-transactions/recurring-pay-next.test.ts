import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, rowById, rowsOf, seedAccount, seedRecurrence, seedTransaction } from './__fixtures__/recurring-fake-db.js';

vi.mock('../../shared/db/prisma.js', async () => ({
  prisma: (await import('./__fixtures__/recurring-fake-db.js')).fakePrisma,
}));
const balance = vi.hoisted(() => ({ update: vi.fn(async () => undefined), card: vi.fn(async () => undefined) }));
vi.mock('../../shared/services/balance.service.js', () => ({
  updateBalanceForNormalTransaction: balance.update,
  recalculateCreditCardLimit: balance.card,
}));

const { executeRecurringTransaction, payNextOccurrence } = await import('./recurring-transactions.service.js');

// "Pay before the due date through the app". Invented data only.
const HH = 'hh-1';
const ACC = 'acc-bank';
const OTHER = 'acc-other';
const FIXED = { earlyDiscountDay: 8, earlyDiscountType: 'FIXED', earlyDiscountValue: 25 } as const;

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  seedAccount({ id: ACC, householdId: HH, name: 'Conta Teste', balance: 1000 });
  seedAccount({ id: OTHER, householdId: HH, name: 'Outra', balance: 500 });
});
afterEach(() => vi.useRealTimers());

const at = (y: number, m: number, d: number) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(y, m - 1, d, 14));
};
const occurrences = (recurringId: string) => rowsOf('transaction').filter((t) => t.recurringTransactionId === recurringId);
const bill = (extra: Record<string, unknown> = {}) =>
  seedRecurrence({ householdId: HH, accountId: ACC, description: 'Conta', amount: 200, nextRunAt: '2026-12-10', startDate: '2026-01-10', ...FIXED, ...extra } as never);

describe('payNextOccurrence', () => {
  it('before the limit day: creates the occurrence PAID with the discounted amount, today, and advances the recurrence', async () => {
    at(2026, 12, 5);
    const rec = bill();
    const result = await payNextOccurrence(rec.id, HH, {});
    expect(result.skipped).toBe(false);
    expect(occurrences(rec.id)).toHaveLength(1);
    expect(occurrences(rec.id)[0]).toMatchObject({ amount: 175, paid: true, date: '2026-12-05', accountId: ACC, type: 'EXPENSE', recurringTransactionId: rec.id });
    // advanced from the SCHEDULED occurrence (10/12), not from the payment day
    expect(rowById('recurringTransaction', rec.id)).toMatchObject({ nextRunAt: '2027-01-10', lastRunDate: '2026-12-05', amount: 200 });
    expect(balance.update).toHaveBeenCalledWith(expect.anything(), ACC, -175);
  });

  it('on the limit day still discounted; the day after, the full amount', async () => {
    at(2026, 12, 8);
    const a = bill();
    await payNextOccurrence(a.id, HH, {});
    expect(occurrences(a.id)[0]).toMatchObject({ amount: 175 });
    at(2026, 12, 9);
    const b = bill();
    await payNextOccurrence(b.id, HH, {});
    expect(occurrences(b.id)[0]).toMatchObject({ amount: 200 });
  });

  it('a percentage is rounded up to the cent', async () => {
    at(2026, 12, 5);
    const rec = bill({ amount: 123.45, earlyDiscountType: 'PERCENT', earlyDiscountValue: 8 });
    await payNextOccurrence(rec.id, HH, {});
    expect(occurrences(rec.id)[0]).toMatchObject({ amount: 113.58 });
  });

  it('a recurrence without discount: the recurrence amount', async () => {
    at(2026, 12, 5);
    const rec = bill({ earlyDiscountDay: null, earlyDiscountType: null, earlyDiscountValue: null });
    await payNextOccurrence(rec.id, HH, {});
    expect(occurrences(rec.id)[0]).toMatchObject({ amount: 200, paid: true });
  });

  it('the body wins: amount, date and account', async () => {
    at(2026, 12, 5);
    const rec = bill();
    await payNextOccurrence(rec.id, HH, { amount: 180.5, date: new Date(2026, 11, 4), accountId: OTHER });
    expect(occurrences(rec.id)[0]).toMatchObject({ amount: 180.5, date: '2026-12-04', accountId: OTHER, paid: true });
    expect(balance.update).toHaveBeenCalledWith(expect.anything(), OTHER, -180.5);
  });

  it('refuses an account that is not of the household, without creating anything', async () => {
    at(2026, 12, 5);
    const rec = bill();
    await expect(payNextOccurrence(rec.id, HH, { accountId: 'acc-stranger' })).rejects.toMatchObject({ statusCode: 404 });
    expect(occurrences(rec.id)).toHaveLength(0);
    expect(rowById('recurringTransaction', rec.id).nextRunAt).toBe('2026-12-10');
  });

  it('the occurrence carries the reference month, like the one the job creates', async () => {
    at(2026, 12, 5);
    const rec = bill({ competenceOffsetMonths: 1 });
    await payNextOccurrence(rec.id, HH, {});
    expect(occurrences(rec.id)[0]).toMatchObject({ competenceMonth: '2027-01' });
  });

  it('paying in the month before the occurrence, with that month already occupied: works, counts for the occurrence month', async () => {
    at(2026, 11, 28);
    const rec = bill();
    // the occurrence of 10/11 was already generated
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Conta', amount: 200, date: '2026-11-10', paid: true, recurringTransactionId: rec.id });
    await payNextOccurrence(rec.id, HH, {});
    const created = occurrences(rec.id).find((t) => t.date === '2026-11-28');
    expect(created).toMatchObject({ amount: 175, paid: true, competenceMonth: '2026-12' });
    // the November one is untouched and the recurrence moved on from December
    expect(occurrences(rec.id).find((t) => t.date === '2026-11-10')).toMatchObject({ amount: 200, competenceMonth: null });
    expect(rowById('recurringTransaction', rec.id)).toMatchObject({ nextRunAt: '2027-01-10' });
  });

  it('paid in another month than the occurrence with an offset: the reference month is the occurrence month plus the offset', async () => {
    at(2026, 11, 28);
    const rec = bill({ competenceOffsetMonths: 1 });
    await payNextOccurrence(rec.id, HH, {});
    expect(occurrences(rec.id)[0]).toMatchObject({ date: '2026-11-28', competenceMonth: '2027-01' });
  });

  it('paid in the month of the occurrence without offset: no competence month, like the job', async () => {
    at(2026, 12, 5);
    const rec = bill();
    await payNextOccurrence(rec.id, HH, {});
    expect(occurrences(rec.id)[0]).toMatchObject({ date: '2026-12-05', competenceMonth: null });
  });

  it('an occurrence of the month already paid ahead (dated in another month, competence = the month) is a 409', async () => {
    at(2026, 11, 29);
    const rec = bill();
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Conta', amount: 175, date: '2026-11-28', paid: true, recurringTransactionId: rec.id, competenceMonth: '2026-12' });
    await expect(payNextOccurrence(rec.id, HH, {})).rejects.toMatchObject({ statusCode: 409 });
    expect(occurrences(rec.id)).toHaveLength(1);
    expect(rowById('recurringTransaction', rec.id).nextRunAt).toBe('2026-12-10');
  });

  it('the job for the month of an occurrence paid ahead (dated in November, competence December) creates nothing', async () => {
    at(2026, 12, 10);
    const rec = bill();
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Conta', amount: 175, date: '2026-11-28', paid: true, recurringTransactionId: rec.id, competenceMonth: '2026-12' });
    const job = await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 11, 10) });
    expect(job.skipped).toBe(true);
    expect(occurrences(rec.id)).toHaveLength(1);
  });

  it('the job still creates the December occurrence when only the November one exists (no competence month)', async () => {
    at(2026, 12, 10);
    const rec = bill();
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Conta', amount: 200, date: '2026-11-10', paid: true, recurringTransactionId: rec.id });
    const job = await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 11, 10) });
    expect(job.skipped).toBe(false);
    expect(occurrences(rec.id)).toHaveLength(2);
  });

  it('followLastAmount: paying the discounted amount keeps the full amount; another amount is followed', async () => {
    at(2026, 12, 5);
    const a = bill({ followLastAmount: true });
    await payNextOccurrence(a.id, HH, {});
    expect(rowById('recurringTransaction', a.id).amount).toBe(200);
    const b = bill({ followLastAmount: true });
    await payNextOccurrence(b.id, HH, { amount: 230 });
    expect(rowById('recurringTransaction', b.id).amount).toBe(230);
  });

  it('twice in a row: the second would pay an occurrence more than a month ahead and is a 409, nothing created', async () => {
    at(2026, 12, 5);
    const rec = bill();
    await payNextOccurrence(rec.id, HH, {});
    // the next one is 10/01: 36 days after the payment date
    await expect(payNextOccurrence(rec.id, HH, {})).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/more than a month ahead/i) });
    expect(occurrences(rec.id)).toHaveLength(1);
    expect(rowById('recurringTransaction', rec.id).nextRunAt).toBe('2027-01-10');
  });

  it('the limit is 31 days after the payment date: 31 passes, 32 is refused', async () => {
    at(2026, 11, 9);
    const ok = bill();
    await expect(payNextOccurrence(ok.id, HH, {})).resolves.toMatchObject({ skipped: false });
    at(2026, 11, 8);
    const tooFar = bill();
    await expect(payNextOccurrence(tooFar.id, HH, {})).rejects.toMatchObject({ statusCode: 409 });
    expect(occurrences(tooFar.id)).toHaveLength(0);
    // the date of the body is the reference, not the clock
    await expect(payNextOccurrence(tooFar.id, HH, { date: new Date(2026, 10, 9) })).resolves.toMatchObject({ skipped: false });
  });

  it('weekly and yearly recurrences follow the same 31-day rule', async () => {
    at(2026, 12, 5);
    const weekly = bill({ frequency: 'WEEKLY', nextRunAt: '2026-12-12' });
    await expect(payNextOccurrence(weekly.id, HH, {})).resolves.toMatchObject({ skipped: false });
    const yearly = bill({ frequency: 'YEARLY', nextRunAt: '2027-12-10' });
    await expect(payNextOccurrence(yearly.id, HH, {})).rejects.toMatchObject({ statusCode: 409 });
    expect(occurrences(yearly.id)).toHaveLength(0);
  });

  it('a month that already has its occurrence (generated by the job) is a 409 and nothing moves', async () => {
    at(2026, 12, 5);
    const rec = bill();
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Conta', amount: 200, date: '2026-12-01', paid: false, recurringTransactionId: rec.id });
    await expect(payNextOccurrence(rec.id, HH, {})).rejects.toMatchObject({ statusCode: 409 });
    expect(occurrences(rec.id)).toHaveLength(1);
    expect(rowById('recurringTransaction', rec.id).nextRunAt).toBe('2026-12-10');
  });

  it('the job right after (the same month): creates no second occurrence', async () => {
    at(2026, 12, 5);
    const rec = bill();
    await payNextOccurrence(rec.id, HH, {});
    const job = await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 11, 10) });
    expect(job.skipped).toBe(true);
    expect(occurrences(rec.id)).toHaveLength(1);
  });

  it('a stale read: if the recurrence was advanced meanwhile (nextRunAt moved) nothing is created', async () => {
    at(2026, 12, 5);
    const rec = bill();
    const { prisma } = await import('../../shared/db/prisma.js');
    const model = (prisma as never as { recurringTransaction: { findFirst: (...a: unknown[]) => Promise<unknown> } }).recurringTransaction;
    const original = model.findFirst.bind(model);
    let calls = 0;
    const spy = vi.spyOn(model, 'findFirst').mockImplementation(async (...args: unknown[]) => {
      calls += 1;
      const row = (await original(...args)) as Record<string, unknown> | null;
      // the read of the execution (before its transaction) sees the old nextRunAt; then another writer advances it
      if (calls === 2) queueMicrotask(() => { rowById('recurringTransaction', rec.id).nextRunAt = '2027-01-10'; });
      return row;
    });
    await expect(payNextOccurrence(rec.id, HH, {})).rejects.toMatchObject({ statusCode: 409 });
    spy.mockRestore();
    expect(occurrences(rec.id)).toHaveLength(0);
  });

  it('refuses an inactive recurrence, clearly, creating nothing', async () => {
    at(2026, 12, 5);
    const rec = bill({ isActive: false });
    await expect(payNextOccurrence(rec.id, HH, {})).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/inactive/i) });
    expect(occurrences(rec.id)).toHaveLength(0);
  });

  it('refuses a recurrence that ended before its next occurrence', async () => {
    at(2026, 12, 5);
    const rec = bill({ endDate: '2026-11-30' });
    await expect(payNextOccurrence(rec.id, HH, {})).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/ended/i) });
    expect(occurrences(rec.id)).toHaveLength(0);
    expect(rowById('recurringTransaction', rec.id).nextRunAt).toBe('2026-12-10');
  });

  it('accepts a recurrence whose end date is the occurrence day itself', async () => {
    at(2026, 12, 5);
    const rec = bill({ endDate: '2026-12-10' });
    await expect(payNextOccurrence(rec.id, HH, {})).resolves.toMatchObject({ skipped: false });
  });

  it('another household is a 404', async () => {
    at(2026, 12, 5);
    const rec = bill();
    await expect(payNextOccurrence(rec.id, 'hh-other', {})).rejects.toMatchObject({ statusCode: 404 });
  });
});
