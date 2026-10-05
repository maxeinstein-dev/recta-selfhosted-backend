import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetStore,
  rowById,
  rowsOf,
  seedAccount,
  seedRecurrence,
  seedTransaction,
} from './__fixtures__/recurring-fake-db.js';
import { calculateNextRunDate, executeRecurringTransaction, listRecurringTransactions, occurrenceDateFor } from './recurring-transactions.service.js';
import { anchorDayOf, startDayFor } from './recurring-dates.js';
import { fakePrisma } from './__fixtures__/recurring-fake-db.js';

vi.mock('../../shared/db/prisma.js', async () => ({
  prisma: (await import('./__fixtures__/recurring-fake-db.js')).fakePrisma,
}));
vi.mock('../../shared/services/balance.service.js', () => ({
  updateBalanceForNormalTransaction: vi.fn(async () => undefined),
  recalculateCreditCardLimit: vi.fn(async () => undefined),
}));

// Invented data only.
const HH = 'hh-1';
const ACC = 'acc-bank';

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  seedAccount({ id: ACC, householdId: HH, name: 'Conta Teste', balance: 1000 });
});

const occurrences = (recurringId: string) => rowsOf('transaction').filter((t) => t.recurringTransactionId === recurringId);

describe('executeRecurringTransaction idempotency guard (monthly)', () => {
  it('creates the pending occurrence once and moves the recurrence on', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia', amount: 100, nextRunAt: '2026-10-05' });
    const result = await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 9, 5), paid: false });
    expect(result.skipped).toBe(false);
    expect(occurrences(rec.id)).toHaveLength(1);
    expect(occurrences(rec.id)[0]).toMatchObject({ amount: 100, paid: false, date: '2026-10-05' });
    expect(rowById('recurringTransaction', rec.id)).toMatchObject({ nextRunAt: '2026-11-05', lastRunDate: '2026-10-05' });
  });

  it('does not create a second occurrence for a month that already has one (another day of the month)', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia', amount: 100, nextRunAt: '2026-10-05' });
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Energia', amount: 90, date: '2026-10-01', paid: true, recurringTransactionId: rec.id });
    const result = await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 9, 20), paid: false });
    expect(result.skipped).toBe(true);
    expect(occurrences(rec.id)).toHaveLength(1);
    expect(occurrences(rec.id)[0]).toMatchObject({ amount: 90 });
    // The recurrence still moves on, so the cron does not retry it every day.
    expect(rowById('recurringTransaction', rec.id)).toMatchObject({ nextRunAt: '2026-11-20', lastRunDate: '2026-10-20' });
  });

  it('is safe to run twice (cron re-run, or the recurrence executed by hand after the cron)', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia', amount: 100, nextRunAt: '2026-10-05' });
    await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 9, 5) });
    const second = await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 9, 5) });
    expect(second.skipped).toBe(true);
    expect(occurrences(rec.id)).toHaveLength(1);
  });

  it('still creates the occurrence of another month, and ignores transactions of other recurrences', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia', amount: 100, nextRunAt: '2026-11-05' });
    const other = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Agua', amount: 50, nextRunAt: '2026-11-05' });
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Energia', amount: 90, date: '2026-10-05', recurringTransactionId: rec.id });
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Agua', amount: 50, date: '2026-11-02', recurringTransactionId: other.id });
    const result = await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 10, 5) });
    expect(result.skipped).toBe(false);
    expect(occurrences(rec.id)).toHaveLength(2);
  });

  it('reads the month of a stored date (UTC midnight) like the one of a local date', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia', amount: 100, nextRunAt: '2026-10-01' });
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Energia', amount: 90, date: '2026-10-31', recurringTransactionId: rec.id });
    // No input date: the run date is the stored nextRunAt (UTC midnight of the 1st).
    const result = await executeRecurringTransaction(rec.id, HH, {});
    expect(result.skipped).toBe(true);
  });

  it('does not apply to recurrences that legitimately run several times a month', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Feira', amount: 40, nextRunAt: '2026-10-12', frequency: 'WEEKLY' });
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Feira', amount: 40, date: '2026-10-05', recurringTransactionId: rec.id });
    const result = await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 9, 12) });
    expect(result.skipped).toBe(false);
    expect(occurrences(rec.id)).toHaveLength(2);
  });

  it('keeps refusing an inactive recurrence', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia', amount: 100, nextRunAt: '2026-10-05', isActive: false });
    await expect(executeRecurringTransaction(rec.id, HH, {})).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('calculateNextRunDate: monthly, anchored to the day of startDate', () => {
  const next = (from: string, anchor?: number) => {
    const d = calculateNextRunDate(new Date(`${from}T00:00:00.000Z`), 'MONTHLY', anchor);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  it('clamps to a short month and returns to the anchor afterwards (no drift)', () => {
    expect(next('2026-01-31', 31)).toBe('2026-02-28');
    expect(next('2026-02-28', 31)).toBe('2026-03-31');
    expect(next('2026-10-31', 31)).toBe('2026-11-30');
    expect(next('2026-11-30', 31)).toBe('2026-12-31');
    expect(next('2026-12-31', 31)).toBe('2027-01-31');
    expect(next('2026-03-30', 30)).toBe('2026-04-30');
  });

  it('without an anchor it keeps the current day, and a later current day wins over the anchor', () => {
    expect(next('2026-10-15')).toBe('2026-11-15');
    expect(next('2026-10-20', 5)).toBe('2026-11-20');
  });

  it('anchorDayOf / startDayFor: the start date carries the true anchor day', () => {
    expect(anchorDayOf(new Date('2026-07-31T00:00:00.000Z'))).toBe(31);
    expect(startDayFor('2026-11-30', 31)).toBe('2026-10-31');
    expect(startDayFor('2026-02-28', 30)).toBe('2026-01-30');
    expect(startDayFor('2026-11-30', 30)).toBe('2026-11-30');
    expect(startDayFor('2026-11-12', 12)).toBe('2026-11-12');
  });

  it('executing walks a day-31 recurrence Oct 31 -> Nov 30 -> Dec 31', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia', amount: 100, nextRunAt: '2026-10-31', startDate: '2026-07-31' });
    await executeRecurringTransaction(rec.id, HH, {});
    expect(rowById('recurringTransaction', rec.id).nextRunAt).toBe('2026-11-30');
    await executeRecurringTransaction(rec.id, HH, {});
    expect(rowById('recurringTransaction', rec.id).nextRunAt).toBe('2026-12-31');
  });
});

describe('execute: the guard runs under the recurrence lock, inside the database transaction', () => {
  it('takes the lock before looking for the month occurrence and before creating anything', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia', amount: 100, nextRunAt: '2026-10-05' });
    fakePrisma.$executeRaw.mockClear();
    fakePrisma.transaction.findFirst.mockClear();
    fakePrisma.transaction.create.mockClear();
    await executeRecurringTransaction(rec.id, HH, {});
    const lock = fakePrisma.$executeRaw.mock.invocationCallOrder[0]!;
    expect(lock).toBeLessThan(fakePrisma.transaction.findFirst.mock.invocationCallOrder[0]!);
    expect(lock).toBeLessThan(fakePrisma.transaction.create.mock.invocationCallOrder[0]!);
    expect(String(fakePrisma.$executeRaw.mock.calls[0]![1])).toBe(`recurring:${rec.id}`);
  });
});

describe('listRecurringTransactions: lastOccurrenceDate', () => {
  it('is the latest occurrence date up to today + 31 days, per recurrence, household-scoped', async () => {
    const today = new Date();
    const iso = (offset: number) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const a = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia', amount: 100, nextRunAt: iso(40) });
    const b = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Agua', amount: 50, nextRunAt: iso(40) });
    const c = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Sem historico', amount: 10, nextRunAt: iso(40) });
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Energia', amount: 1, date: iso(-60), recurringTransactionId: a.id });
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Energia', amount: 1, date: iso(-5), recurringTransactionId: a.id });
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Energia', amount: 1, date: iso(25), recurringTransactionId: a.id });
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Energia', amount: 1, date: iso(90), recurringTransactionId: a.id }); // beyond the limit
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Agua', amount: 1, date: iso(-10), recurringTransactionId: b.id });
    seedTransaction({ householdId: 'hh-2', accountId: ACC, description: 'Agua', amount: 1, date: iso(10), recurringTransactionId: b.id });
    const list = await listRecurringTransactions({ householdId: HH } as never);
    const by = Object.fromEntries(list.map((r) => [r.id, r.lastOccurrenceDate]));
    expect(by).toEqual({ [a.id]: iso(25), [b.id]: iso(-10), [c.id]: null });
  });
});

describe('occurrenceDateFor: a late run keeps the scheduled day', () => {
  const today = new Date(2026, 9, 20);
  const stored = new Date('2026-10-05T00:00:00.000Z');
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  it('monthly: the occurrence is dated nextRunAt, not the day the cron ran', () => {
    expect(ymd(occurrenceDateFor('MONTHLY', stored, today))).toBe('2026-10-05');
    expect(ymd(occurrenceDateFor('MONTHLY', new Date('2026-10-20T00:00:00.000Z'), today))).toBe('2026-10-20');
  });

  it('other frequencies keep dating on the processing day', () => {
    expect(ymd(occurrenceDateFor('WEEKLY', stored, today))).toBe('2026-10-20');
  });

  it('executed late, a recurrence keeps its day for the following months (Oct 5, Nov 5 ...)', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia', amount: 100, nextRunAt: '2026-10-05', startDate: '2026-10-05' });
    await executeRecurringTransaction(rec.id, HH, { date: occurrenceDateFor('MONTHLY', new Date('2026-10-05T00:00:00.000Z'), today) });
    expect(rowsOf('transaction').map((t) => t.date)).toEqual(['2026-10-05']);
    expect(rowById('recurringTransaction', rec.id).nextRunAt).toBe('2026-11-05');
  });
});
