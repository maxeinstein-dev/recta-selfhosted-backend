import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  savingsGoal: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  savingsGoalContribution: { findMany: vi.fn() },
  account: { findFirst: vi.fn(), findMany: vi.fn() },
}));
vi.mock('../../shared/db/prisma.js', () => ({ prisma: db }));

import { assertPlanConsistent, createSavingsGoal, listSavingsGoals, savingsSummary, thisMonthOf, updateSavingsGoal } from './savings-goals.service.js';

// Invented data only.
const HH = '00000000-0000-4000-8000-0000000000f0';
const ACC = '00000000-0000-4000-8000-000000000001';
const dec = (n: number) => ({ toNumber: () => n });
const row = (over: Record<string, unknown> = {}) => ({
  id: 'g1',
  householdId: HH,
  accountId: ACC,
  name: 'Emergency',
  kind: 'RESERVE',
  targetAmount: dec(6000),
  currentAmount: dec(1000),
  monthlyContribution: dec(500),
  contributionDay: 10,
  dueMonth: null,
  targetDate: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.account.findFirst.mockResolvedValue({ id: ACC });
});

describe('assertPlanConsistent', () => {
  const ok = { kind: 'RESERVE' as const, accountId: ACC, monthlyContribution: 500, contributionDay: 10, dueMonth: null };
  it('accepts a reserve with or without a plan', () => {
    expect(() => assertPlanConsistent(ok)).not.toThrow();
    expect(() => assertPlanConsistent({ ...ok, accountId: null, monthlyContribution: null, contributionDay: null })).not.toThrow();
  });
  it('a monthly contribution needs an account and a day', () => {
    expect(() => assertPlanConsistent({ ...ok, accountId: null })).toThrow(/account/);
    expect(() => assertPlanConsistent({ ...ok, contributionDay: null })).toThrow(/contributionDay/);
  });
  it('a provision needs due month, account and day; a reserve must not have a due month', () => {
    const prov = { ...ok, kind: 'PROVISION' as const, monthlyContribution: null, dueMonth: '2027-03' };
    expect(() => assertPlanConsistent(prov)).not.toThrow();
    expect(() => assertPlanConsistent({ ...prov, dueMonth: null })).toThrow(/dueMonth/);
    expect(() => assertPlanConsistent({ ...prov, accountId: null })).toThrow(/account/);
    expect(() => assertPlanConsistent({ ...prov, contributionDay: null })).toThrow(/contributionDay/);
    expect(() => assertPlanConsistent({ ...ok, dueMonth: '2027-03' })).toThrow(/provisions/);
  });
});

describe('thisMonthOf', () => {
  it('pending when planned and nothing made; done once something was; none without a plan', () => {
    expect(thisMonthOf(row() as never, '2026-11', 0, 0)).toEqual({ month: '2026-11', status: 'pending', date: '2026-11-10', plannedAmount: 500, contributedAmount: 0 });
    expect(thisMonthOf(row() as never, '2026-11', 50000, 1)).toEqual({ month: '2026-11', status: 'done', date: '2026-11-10', plannedAmount: 0, contributedAmount: 500 });
    expect(thisMonthOf(row({ monthlyContribution: null, contributionDay: null }) as never, '2026-11', 0, 0)).toMatchObject({ status: 'none', date: null });
  });
});

describe('createSavingsGoal / updateSavingsGoal validate the plan', () => {
  it('create refuses a monthly contribution without an account', async () => {
    await expect(
      createSavingsGoal({ householdId: HH, name: 'X', targetAmount: 100, currentAmount: 0, monthlyContribution: 10, contributionDay: 5 } as never),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(db.savingsGoal.create).not.toHaveBeenCalled();
  });

  it('create refuses an account of another household (404) and stores the plan fields otherwise', async () => {
    db.account.findFirst.mockResolvedValueOnce(null);
    await expect(
      createSavingsGoal({ householdId: HH, accountId: ACC, name: 'X', targetAmount: 100, currentAmount: 0 } as never),
    ).rejects.toMatchObject({ statusCode: 404 });
    db.savingsGoal.create.mockResolvedValue(row());
    const out = await createSavingsGoal({ householdId: HH, accountId: ACC, name: 'X', targetAmount: 6000, currentAmount: 0, monthlyContribution: 500, contributionDay: 10 } as never);
    expect(db.savingsGoal.create.mock.calls[0]![0].data).toMatchObject({ kind: 'RESERVE', contributionDay: 10, dueMonth: null });
    expect(out).toMatchObject({ monthlyContribution: 500, kind: 'RESERVE' });
  });

  it('update checks the RESULTING state: removing the account while a monthly contribution stays is refused', async () => {
    db.savingsGoal.findUnique.mockResolvedValue(row());
    await expect(updateSavingsGoal('g1', { accountId: null })).rejects.toMatchObject({ statusCode: 400 });
    expect(db.savingsGoal.update).not.toHaveBeenCalled();
    db.savingsGoal.update.mockResolvedValue(row({ accountId: null, monthlyContribution: null }));
    await updateSavingsGoal('g1', { accountId: null, monthlyContribution: null });
    expect(db.savingsGoal.update.mock.calls[0]![0].data).toMatchObject({ accountId: null, monthlyContribution: null });
  });

  it('turning a provision back into a reserve clears the due month', async () => {
    db.savingsGoal.findUnique.mockResolvedValue(row({ kind: 'PROVISION', dueMonth: '2027-03', monthlyContribution: null }));
    db.savingsGoal.update.mockResolvedValue(row());
    await updateSavingsGoal('g1', { kind: 'RESERVE' });
    expect(db.savingsGoal.update.mock.calls[0]![0].data).toMatchObject({ kind: 'RESERVE', dueMonth: null });
  });
});

describe('listSavingsGoals', () => {
  it('adds thisMonth to each goal from the contributions of the month', async () => {
    db.savingsGoal.findMany.mockResolvedValue([row({ id: 'g1' }), row({ id: 'g2' })]);
    db.savingsGoalContribution.findMany.mockResolvedValue([{ goalId: 'g2', amount: dec(500) }]);
    const out = await listSavingsGoals({ householdId: HH, today: new Date(Date.UTC(2026, 10, 12)) });
    expect(out.map((g) => g.thisMonth.status)).toEqual(['pending', 'done']);
    expect(db.savingsGoalContribution.findMany.mock.calls[0]![0].where).toMatchObject({ householdId: HH, month: '2026-11' });
  });
});

describe('savingsSummary', () => {
  it('free = balance minus what the goals keep; the balance itself is untouched', async () => {
    db.savingsGoal.findMany.mockResolvedValue([row({ id: 'a', currentAmount: dec(1000) }), row({ id: 'b', currentAmount: dec(250.5) })]);
    db.account.findMany.mockResolvedValue([{ id: ACC, name: 'Wallet', type: 'CHECKING', balance: dec(3000) }]);
    const out = await savingsSummary(HH);
    expect(out.accounts).toEqual([{ accountId: ACC, name: 'Wallet', type: 'CHECKING', balance: 3000, allocated: 1250.5, free: 1749.5 }]);
    expect(out.totalAllocated).toBe(1250.5);
  });
});
