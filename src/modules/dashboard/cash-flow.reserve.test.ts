import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  account: { findMany: vi.fn() },
  transaction: { findMany: vi.fn() },
  recurringTransaction: { findMany: vi.fn() },
  category: { findMany: vi.fn() },
  employment: { findMany: vi.fn() },
  savingsGoal: { findMany: vi.fn() },
  savingsGoalContribution: { findMany: vi.fn() },
}));
vi.mock('../../shared/db/prisma.js', () => ({ prisma: db }));
vi.mock('../transactions/transactions.service.js', () => ({
  calculateCreditCardInvoice: vi.fn(),
  utcToday: () => new Date(Date.UTC(2026, 10, 10)),
}));

import { loadCashFlow } from './cash-flow.loader.js';

// Invented data only. Today is 2026-11-10.
const TODAY = new Date(Date.UTC(2026, 10, 10));
const dec = (n: number) => ({ toNumber: () => n });
const HH = '00000000-0000-4000-8000-0000000000f0';
const CHK = '00000000-0000-4000-8000-000000000001';
const SAV = '00000000-0000-4000-8000-000000000002';
const INV = '00000000-0000-4000-8000-000000000003';

const account = (id: string, over: Record<string, unknown> = {}) => ({
  id, householdId: HH, name: id === CHK ? 'Checking' : 'Other', type: 'CHECKING', balance: dec(3000), currency: 'BRL', isActive: true, linkedAccountId: null, ...over,
});
const goal = (over: Record<string, unknown> = {}) => ({
  id: 'g1',
  householdId: HH,
  accountId: CHK,
  name: 'Emergency',
  kind: 'RESERVE',
  targetAmount: dec(6000),
  currentAmount: dec(1000),
  monthlyContribution: dec(500),
  contributionDay: 15,
  dueMonth: null,
  ...over,
});

function setup(s: { accounts?: unknown[]; goals?: unknown[]; done?: unknown[] } = {}) {
  db.account.findMany.mockResolvedValue(s.accounts ?? [account(CHK)]);
  db.recurringTransaction.findMany.mockResolvedValue([]);
  db.category.findMany.mockResolvedValue([]);
  db.employment.findMany.mockResolvedValue([]);
  db.transaction.findMany.mockResolvedValue([]);
  // honours the account filter the loader sends, as the database does
  db.savingsGoal.findMany.mockImplementation(async (args: { where: { accountId: { in: string[] } } }) => (s.goals ?? []).filter((g) => args.where.accountId.in.includes((g as { accountId: string }).accountId)));
  db.savingsGoalContribution.findMany.mockResolvedValue(s.done ?? []);
}
const run = (over: { accountId?: string; days?: number } = {}) => loadCashFlow({ householdId: HH, days: over.days ?? 60, today: TODAY, accountId: over.accountId });
const events = (out: Awaited<ReturnType<typeof run>>) => out.days.flatMap((d) => d.events);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cash flow: reserves', () => {
  it('without goals nothing changes: same balance, no reserve events, allocated 0', async () => {
    setup();
    const out = await run();
    expect(out.startingBalance).toBe(3000);
    expect(out.allocated).toBe(0);
    expect(out.totalBalance).toBe(3000);
    expect(events(out)).toEqual([]);
  });

  it('the planned contribution of each month enters as an outflow on its day, source reserve', async () => {
    setup({ goals: [goal()] });
    const out = await run();
    const reserve = events(out).filter((e) => e.source === 'reserve');
    expect(reserve.map((e) => [e.date, e.amount, e.sourceId, e.accountId, e.certainty])).toEqual([
      ['2026-11-15', -500, 'g1', CHK, 'expected'],
      ['2026-12-15', -500, 'g1', CHK, 'expected'],
    ]);
    expect(reserve[0]!.description).toContain('Emergency');
  });

  it('the starting balance is the FREE one: balance minus what the goals keep; the total is reported beside it', async () => {
    setup({ goals: [goal(), goal({ id: 'g2', name: 'Trip', currentAmount: dec(250.5), monthlyContribution: null, contributionDay: null })] });
    const out = await run();
    expect(out.allocated).toBe(1250.5);
    expect(out.startingBalance).toBe(1749.5);
    expect(out.totalBalance).toBe(3000);
    // and the planned contribution lowers the free balance on its day
    const nov15 = out.days.find((d) => d.date === '2026-11-15')!;
    expect(nov15.endBalance).toBe(1249.5);
  });

  it('a month already contributed to is not planned again', async () => {
    setup({ goals: [goal()], done: [{ goalId: 'g1', month: '2026-11' }] });
    const out = await run();
    expect(events(out).filter((e) => e.source === 'reserve').map((e) => e.date)).toEqual(['2026-12-15']);
  });

  it('this month with the day already past and not done: overdue, counts today', async () => {
    setup({ goals: [goal({ contributionDay: 5 })] });
    const out = await run();
    const first = events(out).find((e) => e.source === 'reserve')!;
    expect(first).toMatchObject({ date: '2026-11-10', overdue: true, originalDate: '2026-11-05' });
  });

  it('only goals of the accounts in the projection count (one account asked: the others are out)', async () => {
    setup({ accounts: [account(CHK), account(SAV)], goals: [goal(), goal({ id: 'g2', accountId: SAV, name: 'Other', currentAmount: dec(400) })] });
    const out = await run({ accountId: CHK });
    expect(out.allocated).toBe(1000);
    expect(events(out).every((e) => e.accountId === CHK)).toBe(true);
    const query = db.savingsGoal.findMany.mock.calls[0]![0];
    expect(query.where).toMatchObject({ householdId: HH, accountId: { in: [CHK] } });
  });

  it('a goal kept in an account outside the cash set (investment) is not in the projection', async () => {
    setup({ accounts: [account(CHK), account(INV, { type: 'INVESTMENT' })], goals: [goal({ id: 'g2', accountId: INV })] });
    const out = await run();
    expect(out.allocated).toBe(0);
    expect(events(out)).toEqual([]);
    expect(db.savingsGoal.findMany.mock.calls[0]![0].where.accountId).toEqual({ in: [CHK] });
  });

  it('a provision without a monthly value plans what is missing evenly up to the due month', async () => {
    setup({ goals: [goal({ kind: 'PROVISION', dueMonth: '2027-01', monthlyContribution: null, targetAmount: dec(1500), currentAmount: dec(0) })] });
    const out = await run({ days: 90 });
    expect(events(out).filter((e) => e.source === 'reserve').map((e) => [e.date, e.amount])).toEqual([
      ['2026-11-15', -500],
      ['2026-12-15', -500],
      ['2027-01-15', -500],
    ]);
  });

  it('events past the period are left out, as for every source', async () => {
    setup({ goals: [goal()] });
    const out = await run({ days: 3 });
    expect(events(out)).toEqual([]);
  });
});
