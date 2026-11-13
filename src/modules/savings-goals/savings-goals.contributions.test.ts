import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    savingsGoal: { findFirst: vi.fn(), update: vi.fn() },
    savingsGoalContribution: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), delete: vi.fn() },
  };
  return { tx, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)), savingsGoalContribution: { findMany: vi.fn() }, savingsGoal: { findFirst: vi.fn() } };
});
vi.mock('../../shared/db/prisma.js', () => ({ prisma: db }));

import { contribute, listContributions, undoContribution } from './savings-goals.contributions.js';

// Invented data only.
const HH = '00000000-0000-4000-8000-0000000000f0';
const GOAL = '00000000-0000-4000-8000-0000000000a1';
const ACC = '00000000-0000-4000-8000-000000000001';
const dec = (n: number) => ({ toNumber: () => n, toString: () => String(n) });
const goalRow = (over: Record<string, unknown> = {}) => ({
  id: GOAL,
  householdId: HH,
  accountId: ACC,
  name: 'Emergency',
  kind: 'RESERVE',
  targetAmount: dec(6000),
  currentAmount: dec(1000),
  monthlyContribution: dec(500),
  contributionDay: 10,
  dueMonth: null,
  ...over,
});
const TODAY = new Date(Date.UTC(2026, 10, 12));

function setup(goal: unknown = goalRow(), existingInMonth: Array<{ amount: ReturnType<typeof dec> }> = []) {
  db.tx.$queryRaw.mockResolvedValue(goal ? [{ id: GOAL }] : []);
  db.tx.savingsGoal.findFirst.mockResolvedValue(goal);
  db.tx.savingsGoalContribution.findMany.mockResolvedValue(existingInMonth);
  db.tx.savingsGoalContribution.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'c1', date: new Date(Date.UTC(2026, 10, 12)), ...data }));
  db.tx.savingsGoal.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...(goal as object), ...data }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('contribute', () => {
  it('locks the goal row first (two simultaneous contributions must queue, not race)', async () => {
    setup();
    await contribute({ goalId: GOAL, householdId: HH, amount: 500, today: TODAY });
    expect(db.tx.$queryRaw).toHaveBeenCalledTimes(1);
    const order = [db.tx.$queryRaw.mock.invocationCallOrder[0], db.tx.savingsGoal.findFirst.mock.invocationCallOrder[0]];
    expect(order[0]).toBeLessThan(order[1]!);
    // it must be a row lock (FOR UPDATE), not a plain read: without it the queue does not exist
    expect((db.tx.$queryRaw.mock.calls[0]![0] as string[]).join('?')).toMatch(/FOR UPDATE/);
  });

  it('records the contribution and raises currentAmount in the same transaction; no transaction row, no balance', async () => {
    setup();
    const out = await contribute({ goalId: GOAL, householdId: HH, amount: 250.5, today: TODAY });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    const created = db.tx.savingsGoalContribution.create.mock.calls[0]![0].data;
    expect(created).toMatchObject({ goalId: GOAL, householdId: HH, month: '2026-11' });
    expect(String(created.amount)).toBe('250.5');
    expect(db.tx.savingsGoal.update.mock.calls[0]![0].data.currentAmount).toEqual({ increment: expect.anything() });
    expect(out.contribution).toMatchObject({ id: 'c1', month: '2026-11', amount: 250.5 });
  });

  it('without an amount, takes the amount planned for the month', async () => {
    setup();
    await contribute({ goalId: GOAL, householdId: HH, today: TODAY });
    expect(String(db.tx.savingsGoalContribution.create.mock.calls[0]![0].data.amount)).toBe('500');
  });

  it('without an amount and nothing planned: 400', async () => {
    setup(goalRow({ monthlyContribution: null }));
    await expect(contribute({ goalId: GOAL, householdId: HH, today: TODAY })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('a second contribution in a month that already has one is refused (409) unless confirmed', async () => {
    setup(goalRow(), [{ amount: dec(500) }]);
    await expect(contribute({ goalId: GOAL, householdId: HH, amount: 500, today: TODAY })).rejects.toMatchObject({ statusCode: 409 });
    expect(db.tx.savingsGoalContribution.create).not.toHaveBeenCalled();
    await contribute({ goalId: GOAL, householdId: HH, amount: 500, confirmDuplicate: true, today: TODAY });
    expect(db.tx.savingsGoalContribution.create).toHaveBeenCalledTimes(1);
  });

  it('the month is the one of the given date, not of today', async () => {
    setup();
    await contribute({ goalId: GOAL, householdId: HH, amount: 100, date: '2026-12-10', today: TODAY });
    expect(db.tx.savingsGoalContribution.findMany.mock.calls[0]![0].where).toMatchObject({ goalId: GOAL, month: '2026-12' });
  });

  it('a goal of another household (or missing) is 404 and nothing is written', async () => {
    setup(null);
    await expect(contribute({ goalId: GOAL, householdId: HH, amount: 100, today: TODAY })).rejects.toMatchObject({ statusCode: 404 });
    expect(db.tx.savingsGoalContribution.create).not.toHaveBeenCalled();
    expect(db.tx.savingsGoal.update).not.toHaveBeenCalled();
  });

  it('the lock is scoped to the household: the raw query carries it', async () => {
    setup();
    await contribute({ goalId: GOAL, householdId: HH, amount: 100, today: TODAY });
    const values = db.tx.$queryRaw.mock.calls[0]!.slice(1);
    expect(values).toContain(GOAL);
    expect(values).toContain(HH);
  });

  it('a goal without an account cannot receive a contribution (nowhere to take the money from)', async () => {
    setup(goalRow({ accountId: null }));
    await expect(contribute({ goalId: GOAL, householdId: HH, amount: 100, today: TODAY })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('cannot go past the target', async () => {
    setup(goalRow({ currentAmount: dec(5900) }));
    await expect(contribute({ goalId: GOAL, householdId: HH, amount: 100.01, today: TODAY })).rejects.toMatchObject({ statusCode: 400 });
    await contribute({ goalId: GOAL, householdId: HH, amount: 100, today: TODAY });
    expect(db.tx.savingsGoalContribution.create).toHaveBeenCalledTimes(1);
  });

  it('rejects an amount with more than two decimals (money is whole cents)', async () => {
    setup();
    await expect(contribute({ goalId: GOAL, householdId: HH, amount: 10.005, today: TODAY })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('undoContribution', () => {
  const row = (amount: number) => ({ id: 'c1', goalId: GOAL, householdId: HH, amount: dec(amount), month: '2026-11', date: new Date(Date.UTC(2026, 10, 10)), createdAt: new Date(Date.UTC(2026, 10, 10)) });

  it('deletes the row and gives the amount back, under the goal lock', async () => {
    setup();
    db.tx.savingsGoalContribution.findFirst.mockResolvedValue(row(300));
    await undoContribution({ goalId: GOAL, householdId: HH, contributionId: 'c1' });
    expect(db.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.tx.savingsGoalContribution.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
    expect(String(db.tx.savingsGoal.update.mock.calls[0]![0].data.currentAmount)).toBe('700');
  });

  it('never leaves the kept amount below zero (the amount was edited down by hand meanwhile)', async () => {
    setup(goalRow({ currentAmount: dec(100) }));
    db.tx.savingsGoalContribution.findFirst.mockResolvedValue(row(300));
    await undoContribution({ goalId: GOAL, householdId: HH, contributionId: 'c1' });
    expect(String(db.tx.savingsGoal.update.mock.calls[0]![0].data.currentAmount)).toBe('0');
  });

  it('a contribution of another goal/household is 404', async () => {
    setup();
    db.tx.savingsGoalContribution.findFirst.mockResolvedValue(null);
    await expect(undoContribution({ goalId: GOAL, householdId: HH, contributionId: 'c1' })).rejects.toMatchObject({ statusCode: 404 });
    expect(db.tx.savingsGoalContribution.findFirst.mock.calls[0]![0].where).toMatchObject({ id: 'c1', goalId: GOAL, householdId: HH });
  });
});

describe('listContributions', () => {
  it('lists the contributions of a goal of the household, optionally of one month', async () => {
    db.savingsGoal.findFirst.mockResolvedValue(goalRow());
    db.savingsGoalContribution.findMany.mockResolvedValue([{ id: 'c1', goalId: GOAL, amount: dec(300), date: new Date(Date.UTC(2026, 10, 10)), month: '2026-11', createdAt: new Date(Date.UTC(2026, 10, 10)) }]);
    const out = await listContributions({ goalId: GOAL, householdId: HH, month: '2026-11' });
    expect(out).toEqual([expect.objectContaining({ id: 'c1', amount: 300, date: '2026-11-10', month: '2026-11' })]);
    expect(db.savingsGoalContribution.findMany.mock.calls[0]![0].where).toMatchObject({ goalId: GOAL, householdId: HH, month: '2026-11' });
  });
});
