import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchesWhere, type Row } from '../../shared/__fixtures__/where-eval.js';

// Own share (cota propria) next to the realized amount of the budget summary and of the dashboard overview.
// Invented data only. The fake database runs the real `where` of each query over in-memory rows, shares included.
const HH = '11111111-1111-4111-8111-111111111111';
const OTHER_HH = '99999999-9999-4999-8999-999999999999';
const store = vi.hoisted(() => ({
  transactions: [] as Array<Record<string, unknown>>,
  shares: [] as Array<Record<string, unknown>>,
  budgets: [] as Array<Record<string, unknown>>,
  shareQueries: 0,
}));
const dec = (n: number) => ({ toNumber: () => n, valueOf: () => n });

vi.mock('../../shared/middleware/auth.middleware.js', () => ({ authMiddleware: () => async () => undefined, getAuthUser: () => ({ uid: 'f1', email: 'a@example.com' }) }));
vi.mock('../../shared/middleware/authorization.middleware.js', () => ({
  requireHouseholdMember: vi.fn(async () => ({})),
  requireEditor: vi.fn(async () => ({})),
  ensurePersonalHousehold: vi.fn(async () => '11111111-1111-4111-8111-111111111111'),
}));
vi.mock('../../shared/db/prisma.js', () => {
  const txRow = (r: Record<string, unknown>) => ({ ...r, amount: dec(r.amount as number), date: new Date(`${r.date}T00:00:00.000Z`), account: r.accountType ? { type: r.accountType } : null });
  return {
    prisma: {
      transaction: { findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => store.transactions.filter((r) => matchesWhere(r as Row, args.where)).map(txRow)) },
      transactionShare: {
        findMany: vi.fn(async (args: { where: Record<string, unknown> & { transaction: Record<string, unknown> } }) => {
          store.shareQueries += 1;
          const { transaction, ...own } = args.where;
          return store.shares
            .filter((s) => matchesWhere(s as Row, own))
            .map((s) => ({ s, tx: store.transactions.find((t) => t.id === s.transactionId) }))
            .filter(({ tx }) => tx && matchesWhere(tx as Row, transaction))
            .map(({ s, tx }) => ({ transactionId: s.transactionId, amount: dec(s.amount as number), transaction: { amount: dec(tx!.amount as number), categoryName: tx!.categoryName } }));
        }),
      },
      account: { findMany: vi.fn(async () => []) },
      budget: { findMany: vi.fn(async () => store.budgets.map((b) => ({ ...b, monthlyLimit: dec(b.monthlyLimit as number) }))) },
      recurringTransaction: { findMany: vi.fn(async () => []) },
      category: { findMany: vi.fn(async () => []) },
      $queryRaw: vi.fn(async () => []),
    },
  };
});

const { budgetRoutes } = await import('./budgets.routes.js');
const { dashboardRoutes } = await import('../dashboard/dashboard.routes.js');
const { getBudgetSummary } = await import('./budgets.service.js');
const { getDashboardOverview } = await import('../dashboard/dashboard.service.js');
const { ownAmountCents, deductionCents } = await import('../people/own-share.js');

let seq = 0;
function tx(over: Record<string, unknown> = {}) {
  seq += 1;
  const row = { id: `t-${seq}`, householdId: HH, type: 'EXPENSE', categoryName: 'GROCERIES', amount: -100, date: '2026-10-05', competenceMonth: null, accountId: 'acc', accountType: 'CHECKING', ...over };
  store.transactions.push(row);
  return row.id as string;
}
function share(transactionId: string, amount: number, over: Record<string, unknown> = {}) {
  seq += 1;
  store.shares.push({ id: `s-${seq}`, householdId: HH, transactionId, personId: `p-${seq}`, direction: 'THEY_OWE_ME', amount, ...over });
}
const budget = (over: Record<string, unknown> = {}) =>
  store.budgets.push({ id: `b-${store.budgets.length}`, householdId: HH, categoryName: 'GROCERIES', monthlyLimit: 500, month: new Date(Date.UTC(2026, 9, 1)), type: 'EXPENSE', ...over });

beforeEach(() => {
  store.transactions.length = 0;
  store.shares.length = 0;
  store.budgets.length = 0;
  store.shareQueries = 0;
  seq = 0;
});

type Line = { categoryName: string; spending: number; ownSpent: number; percentage: number; isOverBudget: boolean };
const summary = async () =>
  (await getBudgetSummary({ householdId: HH, month: '2026-10' } as never)) as { budgets: Line[]; totalSpending: number; totalOwnSpending: number };
const overview = () => getDashboardOverview({ householdId: HH, month: '2026-10' });

describe('own share arithmetic', () => {
  it('amount minus what people owe, never below zero, on absolute amounts', () => {
    expect(ownAmountCents(10000, 0)).toBe(10000);
    expect(ownAmountCents(-10000, 3000)).toBe(7000);
    expect(ownAmountCents(10000, 10000)).toBe(0);
    expect(ownAmountCents(10000, 25000)).toBe(0);
    expect(deductionCents({ amountCents: 10000, theirCents: 25000 })).toBe(10000);
    expect(deductionCents({ amountCents: 10000, theirCents: 4000 })).toBe(4000);
  });
});

describe('budget summary: ownSpent', () => {
  it('without shares ownSpent equals spending, in the category and in the totals', async () => {
    budget();
    budget({ categoryName: 'GENERAL' });
    tx();
    tx({ amount: -50.5 });
    const r = await summary();
    expect(r.budgets.map((b) => [b.spending, b.ownSpent])).toEqual([[150.5, 150.5], [150.5, 150.5]]);
    expect(r.totalOwnSpending).toBe(r.totalSpending);
  });

  it('a partial split takes the other person part off ownSpent only; spending and percentage keep the full value', async () => {
    budget();
    const id = tx({ amount: -100 });
    share(id, 30);
    const [b] = (await summary()).budgets;
    expect(b).toMatchObject({ spending: 100, ownSpent: 70, percentage: 20, isOverBudget: false });
  });

  it('a total split leaves ownSpent at zero', async () => {
    budget();
    share(tx({ amount: -80 }), 80);
    expect((await summary()).budgets[0]).toMatchObject({ spending: 80, ownSpent: 0 });
  });

  it('several people on one expense, and several expenses, add up', async () => {
    budget();
    const a = tx({ amount: -120 });
    share(a, 30.25);
    share(a, 19.75);
    const b = tx({ amount: -60 });
    share(b, 10.1);
    tx({ amount: -40 });
    const r = await summary();
    expect(r.budgets[0]).toMatchObject({ spending: 220 });
    expect(r.budgets[0]!.ownSpent).toBe(159.9);
  });

  it('a share bigger than the transaction floors that transaction at zero, it does not eat the others', async () => {
    budget();
    share(tx({ amount: -50 }), 70);
    tx({ amount: -30 });
    expect((await summary()).budgets[0]).toMatchObject({ spending: 80, ownSpent: 30 });
  });

  it('installments are rows of their own: only the row that has the share is reduced', async () => {
    budget();
    const first = tx({ amount: -100, installmentId: 'inst-1', installmentNumber: 1, totalInstallments: 3 });
    tx({ amount: -100, date: '2026-10-20', installmentId: 'inst-1', installmentNumber: 2, totalInstallments: 3 });
    share(first, 40);
    expect((await summary()).budgets[0]).toMatchObject({ spending: 200, ownSpent: 160 });
  });

  it('the share of the other direction (I owe them) and shares of other categories do not change it', async () => {
    budget();
    const mine = tx({ amount: -100 });
    share(mine, 60, { direction: 'I_OWE_THEM' });
    share(tx({ amount: -100, categoryName: 'LEISURE' }), 50);
    const r = await summary();
    expect(r.budgets[0]).toMatchObject({ spending: 100, ownSpent: 100 });
  });

  it('the General expense budget takes every category; an income budget never gets a deduction', async () => {
    budget({ categoryName: 'GENERAL' });
    budget({ categoryName: 'GENERAL', type: 'INCOME' });
    budget({ categoryName: 'SALARY', type: 'INCOME' });
    share(tx({ amount: -100 }), 25);
    share(tx({ amount: -100, categoryName: 'LEISURE' }), 25);
    share(tx({ type: 'INCOME', categoryName: 'SALARY', amount: 1000 }), 400); // a share on an income is not an expense share
    const r = await summary();
    expect(r.budgets.map((b) => [b.spending, b.ownSpent])).toEqual([[200, 150], [1000, 1000], [1000, 1000]]);
    expect(r.totalOwnSpending).toBe(1000 + 1000 + 150);
  });

  it('only the period counts, by the reference month', async () => {
    budget();
    share(tx({ amount: -100, date: '2026-09-29', competenceMonth: '2026-10' }), 40);
    share(tx({ amount: -100, date: '2026-11-02' }), 40);
    expect((await summary()).budgets[0]).toMatchObject({ spending: 100, ownSpent: 60 });
  });

  it('a share row of another household is ignored, also one pointing at a transaction of another household', async () => {
    budget();
    const id = tx({ amount: -100 });
    share(id, 40, { householdId: OTHER_HH });
    const foreign = tx({ amount: -100, householdId: OTHER_HH });
    share(foreign, 40);
    expect((await summary()).budgets[0]).toMatchObject({ spending: 100, ownSpent: 100 });
  });

  it('one query for the shares however many budgets and expenses there are', async () => {
    for (const c of ['GROCERIES', 'LEISURE', 'TRANSPORT', 'GENERAL']) budget({ categoryName: c });
    for (let i = 0; i < 6; i += 1) share(tx({ categoryName: i % 2 ? 'LEISURE' : 'GROCERIES' }), 10);
    await summary();
    expect(store.shareQueries).toBe(1);
  });

  it('only income budgets: no share query at all', async () => {
    budget({ categoryName: 'SALARY', type: 'INCOME' });
    await summary();
    expect(store.shareQueries).toBe(0);
  });
});

describe('dashboard overview: ownExpense and ownSpent', () => {
  it('without shares the new fields equal the old ones', async () => {
    budget();
    budget({ categoryName: 'GENERAL' });
    tx();
    tx({ type: 'INCOME', categoryName: 'SALARY', amount: 1000 });
    const o = await overview();
    expect(o.categoryBreakdown.map((c) => [c.name, c.expense, c.ownExpense])).toEqual([['GROCERIES', 100, 100], ['SALARY', 0, 0]]);
    expect(o.budgetVsRealized.map((b) => [b.spent, b.ownSpent])).toEqual([[100, 100], [100, 100]]);
  });

  it('partial, total, several people and oversized shares; the old fields do not move', async () => {
    budget();
    budget({ categoryName: 'GENERAL' });
    const a = tx({ amount: -100 });
    share(a, 30);
    share(a, 20);
    share(tx({ amount: -50 }), 50);
    share(tx({ amount: -40, categoryName: 'LEISURE' }), 90);
    tx({ amount: -10 });
    const o = await overview();
    expect(o.summary.totalExpense).toBe(200);
    expect(o.categoryBreakdown.find((c) => c.name === 'GROCERIES')).toMatchObject({ expense: 160, ownExpense: 60, total: -160 });
    expect(o.categoryBreakdown.find((c) => c.name === 'LEISURE')).toMatchObject({ expense: 40, ownExpense: 0 });
    const groceries = o.budgetVsRealized.find((b) => b.category === 'GROCERIES')!;
    expect(groceries).toMatchObject({ spent: 160, ownSpent: 60, remaining: 340 });
    expect(o.budgetVsRealized.find((b) => b.category === 'GENERAL')).toMatchObject({ spent: 200, ownSpent: 60 });
  });

  it('card transactions stay out, as in the rest of the overview, and so do their shares', async () => {
    budget();
    share(tx({ amount: -100, accountType: 'CREDIT', accountId: 'card' }), 40);
    tx({ amount: -20 });
    const o = await overview();
    expect(o.categoryBreakdown[0]).toMatchObject({ expense: 20, ownExpense: 20 });
  });

  it('installments, the other direction and another household', async () => {
    budget();
    share(tx({ amount: -100, installmentId: 'i', installmentNumber: 1 }), 25);
    tx({ amount: -100, installmentId: 'i', installmentNumber: 2, date: '2026-10-25' });
    share(tx({ amount: -100 }), 90, { direction: 'I_OWE_THEM' });
    share(tx({ amount: -100, householdId: OTHER_HH }), 90);
    const o = await overview();
    expect(o.categoryBreakdown[0]).toMatchObject({ expense: 300, ownExpense: 275 });
    expect(store.shareQueries).toBe(1);
  });
});

describe('routes', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(budgetRoutes, { prefix: '/budgets' });
    await app.register(dashboardRoutes, { prefix: '/dashboard' });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('GET /budgets/summary carries ownSpent and totalOwnSpending beside the old fields', async () => {
    budget();
    share(tx({ amount: -100 }), 30);
    const res = await app.inject({ method: 'GET', url: `/budgets/summary?householdId=${HH}&month=2026-10` });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.budgets[0]).toMatchObject({ categoryName: 'GROCERIES', monthlyLimit: 500, spending: 100, ownSpent: 70, remaining: 400, percentage: 20, isOverBudget: false });
    expect(data).toMatchObject({ totalLimit: 500, totalSpending: 100, totalOwnSpending: 70 });
  });

  it('GET /dashboard/overview serializes ownExpense and ownSpent (the response schema must not strip them)', async () => {
    budget();
    share(tx({ amount: -100 }), 30);
    const res = await app.inject({ method: 'GET', url: `/dashboard/overview?householdId=${HH}&month=2026-10` });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.categoryBreakdown[0]).toEqual({ name: 'GROCERIES', income: 0, expense: 100, ownExpense: 70, total: -100 });
    expect(data.budgetVsRealized[0]).toMatchObject({ category: 'GROCERIES', spent: 100, ownSpent: 70, remaining: 400 });
    expect(data.summary.totalExpense).toBe(100);
  });
});

// The summary is the one place where the realized amount of a budget is computed (the screens only show it).
describe('budget summary: only rows of the budget type count', () => {
  it('an income row filed under an expense category (a refund) does not add to the spending of the expense budget', async () => {
    budget();
    tx({ amount: -100 });
    tx({ type: 'INCOME', amount: 40 });
    const [b] = (await summary()).budgets;
    expect(b).toMatchObject({ spending: 100, ownSpent: 100 });
  });

  it('a transfer filed under the category does not count either; an income budget only sums income', async () => {
    budget();
    budget({ categoryName: 'SALARY', type: 'INCOME' });
    tx({ amount: -100 });
    tx({ type: 'TRANSFER', amount: -70 });
    tx({ type: 'INCOME', categoryName: 'SALARY', amount: 900 });
    tx({ type: 'EXPENSE', categoryName: 'SALARY', amount: -15 });
    const r = await summary();
    expect(r.budgets.map((b) => [b.categoryName, b.spending])).toEqual([['GROCERIES', 100], ['SALARY', 900]]);
  });

  it('own share never exceeds the spending, whatever the shares are', async () => {
    budget();
    budget({ categoryName: 'GENERAL' });
    const a = tx({ amount: -100 });
    const b = tx({ amount: -20.1 });
    tx({ type: 'INCOME', amount: 55 });
    share(a, 30);
    share(a, 25.55);
    share(b, 500);
    const r = await summary();
    for (const line of r.budgets) {
      expect(line.ownSpent).toBeLessThanOrEqual(line.spending);
      expect(line.ownSpent).toBeGreaterThanOrEqual(0);
    }
    expect(r.budgets.map((l) => [l.spending, l.ownSpent])).toEqual([[120.1, 44.45], [120.1, 44.45]]);
  });
});
