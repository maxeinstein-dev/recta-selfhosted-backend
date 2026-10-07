import { beforeEach, describe, expect, it, vi } from 'vitest';
import { matchesWhere, type Row } from '../../shared/__fixtures__/where-eval.js';

// Month planning in the dashboard, the budget summary and the budget alerts follows the reference month
// (competence_month) and falls back to the month of the date. The heatmap is the calendar of the cash and stays by date.
const HH = 'hh-1';
const store = vi.hoisted(() => ({
  transactions: [] as Array<Record<string, unknown>>,
  budgets: [] as Array<Record<string, unknown>>,
  rawCalls: [] as unknown[][],
}));

const decimal = (n: number) => ({ toNumber: () => n });
const out = (r: Record<string, unknown>) => ({ ...r, amount: decimal(r.amount as number), date: new Date(`${r.date}T00:00:00.000Z`), account: r.accountType ? { type: r.accountType } : null });

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    transaction: {
      findMany: vi.fn(async (args: { where?: Record<string, unknown> }) =>
        store.transactions.filter((r) => matchesWhere(r as Row, args.where)).map(out)),
    },
    account: { findMany: vi.fn(async () => []) },
    budget: {
      findMany: vi.fn(async () => store.budgets.map((b) => ({ ...b, monthlyLimit: decimal(b.monthlyLimit as number) }))),
      findFirst: vi.fn(async (args: { where: { month: Date } }) => {
        const wanted = args.where.month.toISOString().slice(0, 7); // a budget month is a UTC-midnight @db.Date value
        const b = store.budgets.find((x) => x.monthKey === wanted);
        return b ? { ...b, monthlyLimit: decimal(b.monthlyLimit as number) } : null;
      }),
    },
    recurringTransaction: { findMany: vi.fn(async () => []) },
    category: { findMany: vi.fn(async () => []) },
    householdMember: { findMany: vi.fn(async () => [{ userId: 'u-1', user: { id: 'u-1' } }]) },
    notification: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async (...args: unknown[]) => {
      store.rawCalls.push(args);
      return [];
    }),
  },
}));
vi.mock('../notifications/notifications.service.js', () => ({ createNotification: vi.fn(async () => undefined) }));

const { getDashboardOverview } = await import('./dashboard.service.js');
const { getBudgetSummary } = await import('../budgets/budgets.service.js');
const { checkBudgetThresholds } = await import('../notifications/budget-notifications.service.js');
const { prisma } = await import('../../shared/db/prisma.js');
const { createNotification } = await import('../notifications/notifications.service.js');

let seq = 0;
function tx(over: Record<string, unknown>) {
  seq += 1;
  store.transactions.push({ id: `t-${seq}`, householdId: HH, type: 'EXPENSE', categoryName: 'GROCERIES', amount: -10, competenceMonth: null, accountId: 'acc', accountType: 'CHECKING', ...over });
}

beforeEach(() => {
  store.transactions.length = 0;
  store.budgets.length = 0;
  store.rawCalls.length = 0;
  seq = 0;
  vi.clearAllMocks();
});

describe('dashboard overview', () => {
  it('without reference months the figures are the ones of the date ranges (regression)', async () => {
    tx({ date: '2026-10-05', type: 'INCOME', amount: 1000, categoryName: 'SALARY' });
    tx({ date: '2026-10-31', amount: -300 });
    tx({ date: '2026-09-30', amount: -100 });
    tx({ date: '2026-11-01', amount: -900 });
    const o = await getDashboardOverview({ householdId: HH, month: '2026-10' });
    expect(o.summary).toEqual({ totalIncome: 1000, totalExpense: 300, balance: 700 });
    const months = o.monthlyComparison;
    expect(months).toHaveLength(6);
    expect(months[5]).toMatchObject({ income: 1000, expense: 300 });
    expect(months[4]).toMatchObject({ income: 0, expense: 100 });
  });

  it('moves an income dated 25 Sep that refers to October into the October summary and out of September', async () => {
    tx({ date: '2026-10-05', type: 'INCOME', amount: 1000, categoryName: 'SALARY' });
    tx({ date: '2026-09-25', competenceMonth: '2026-10', type: 'INCOME', amount: 600, categoryName: 'OTHER_INCOME' });
    const oct = await getDashboardOverview({ householdId: HH, month: '2026-10' });
    expect(oct.summary.totalIncome).toBe(1600);
    // the previous month of October (September) lost it: trend compares 1600 against 0
    expect(oct.trend.incomeChange).toBe(100);
    expect(oct.monthlyComparison[5]!.income).toBe(1600);
    expect(oct.monthlyComparison[4]!.income).toBe(0);
    const sep = await getDashboardOverview({ householdId: HH, month: '2026-09' });
    expect(sep.summary.totalIncome).toBe(0);
  });

  it('the category breakdown and the budget-vs-realized use the reference month too', async () => {
    store.budgets.push({ id: 'b1', householdId: HH, categoryName: 'GROCERIES', monthlyLimit: 500, month: new Date(Date.UTC(2026, 9, 1)), type: 'EXPENSE' });
    tx({ date: '2026-09-29', competenceMonth: '2026-10', amount: -120 });
    const o = await getDashboardOverview({ householdId: HH, month: '2026-10' });
    expect(o.categoryBreakdown.find((c) => c.name === 'GROCERIES')?.expense).toBe(120);
  });

  it('the heatmap stays on the calendar (date): it does not read the reference month', async () => {
    tx({ date: '2026-09-29', competenceMonth: '2026-10', amount: -120 });
    await getDashboardOverview({ householdId: HH, month: '2026-10' });
    const sql = store.rawCalls.map((c) => (c[0] as TemplateStringsArray).join('?')).join('\n');
    expect(sql).toContain('EXTRACT(DAY FROM date)');
    expect(sql).not.toContain('competence');
  });
});

describe('budget summary', () => {
  it('spends a category in the reference month of the transaction', async () => {
    store.budgets.push({ id: 'b1', householdId: HH, categoryName: 'GROCERIES', monthlyLimit: 500, month: new Date(Date.UTC(2026, 9, 1)), type: 'EXPENSE' });
    tx({ date: '2026-10-05', amount: -100 });
    tx({ date: '2026-09-29', competenceMonth: '2026-10', amount: -50 });
    tx({ date: '2026-10-30', competenceMonth: '2026-11', amount: -70 });
    const oct = await getBudgetSummary({ householdId: HH, month: '2026-10' } as never);
    expect(oct.budgets[0]!.spending).toBe(150);
    const nov = await getBudgetSummary({ householdId: HH, month: '2026-11' } as never);
    expect(nov.budgets[0]!.spending).toBe(70);
  });

  it('a date range is still by date', async () => {
    store.budgets.push({ id: 'b1', householdId: HH, categoryName: 'GROCERIES', monthlyLimit: 500, month: new Date(Date.UTC(2026, 9, 1)), type: 'EXPENSE' });
    tx({ date: '2026-09-29', competenceMonth: '2026-10', amount: -50 });
    const r = await getBudgetSummary({ householdId: HH, startDate: new Date(2026, 8, 1), endDate: new Date(2026, 8, 30) } as never);
    expect(r.budgets[0]!.spending).toBe(50);
  });
});

describe('budget alerts', () => {
  it('look for the budget and the spending of the reference month, not of the date month', async () => {
    store.budgets.push({ id: 'b-oct', householdId: HH, categoryName: 'GROCERIES', monthlyLimit: 100, monthKey: '2026-10', month: new Date(2026, 9, 1), type: 'EXPENSE' });
    tx({ date: '2026-09-29', competenceMonth: '2026-10', amount: -80 });
    await checkBudgetThresholds(HH, 'GROCERIES', new Date(2026, 8, 29), 80, 'EXPENSE', '2026-10');
    expect(prisma.budget.findFirst).toHaveBeenCalledTimes(1);
    const call = (prisma.budget.findFirst as unknown as { mock: { calls: Array<[{ where: { month: Date } }]> } }).mock.calls[0]![0];
    expect(call.where.month.getUTCMonth()).toBe(9);
    // it counted the 80 of the referenced row: 80% is over the 75% threshold, so the member is notified
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('without a reference month they use the month of the date, as before', async () => {
    store.budgets.push({ id: 'b-sep', householdId: HH, categoryName: 'GROCERIES', monthlyLimit: 100, monthKey: '2026-09', month: new Date(2026, 8, 1), type: 'EXPENSE' });
    tx({ date: '2026-09-29', amount: -80 });
    await checkBudgetThresholds(HH, 'GROCERIES', new Date(2026, 8, 29), 80, 'EXPENSE');
    const call = (prisma.budget.findFirst as unknown as { mock: { calls: Array<[{ where: { month: Date } }]> } }).mock.calls[0]![0];
    expect(call.where.month.getUTCMonth()).toBe(8);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });
});
