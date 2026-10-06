import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, seedAccount, seedRecurrence } from './__fixtures__/recurring-fake-db.js';

// The occurrence amount comes from expectedAmountFor, and it is asked for the month the occurrence COUNTS for
// (its reference month), not the month of its date. Invented data only.
const spy = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('./expected-amount.js', () => ({
  expectedAmountFor: (...args: unknown[]) => {
    spy.calls.push(args);
    return (args[0] as { amount: number }).amount;
  },
}));
vi.mock('../../shared/db/prisma.js', async () => ({
  prisma: (await import('./__fixtures__/recurring-fake-db.js')).fakePrisma,
}));
vi.mock('../../shared/services/balance.service.js', () => ({
  updateBalanceForNormalTransaction: vi.fn(async () => undefined),
  recalculateCreditCardLimit: vi.fn(async () => undefined),
}));

const { executeRecurringTransaction } = await import('./recurring-transactions.service.js');

beforeEach(() => {
  resetStore();
  spy.calls.length = 0;
  seedAccount({ id: 'acc', householdId: 'hh', name: 'Conta', balance: 0 });
});

describe('expectedAmountFor is asked for the reference month', () => {
  it('with an offset: the month after the date', async () => {
    const r = seedRecurrence({ householdId: 'hh', accountId: 'acc', description: 'Vale', amount: 500, nextRunAt: '2026-09-25', competenceOffsetMonths: 1 });
    await executeRecurringTransaction(r.id, 'hh', { date: new Date(2026, 8, 25) });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]![2]).toBe('2026-10');
  });
  it('without an offset: the month of the date', async () => {
    const r = seedRecurrence({ householdId: 'hh', accountId: 'acc', description: 'Luz', amount: 100, nextRunAt: '2026-09-25' });
    await executeRecurringTransaction(r.id, 'hh', { date: new Date(2026, 8, 25) });
    expect(spy.calls[0]![2]).toBe('2026-09');
  });
});
