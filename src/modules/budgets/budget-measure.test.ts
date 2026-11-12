import { beforeEach, describe, expect, it, vi } from 'vitest';
import { matchesWhere, type Row } from '../../shared/__fixtures__/where-eval.js';

// How a budget is measured (WHOLE: the full spending, "together"; OWN_SHARE: the spending minus what other people owe,
// "separate") in the summary and in the alerts, and the alert of the General budget. Invented data only; the fake
// database runs the real `where` of each query.
const HH = '11111111-1111-4111-8111-111111111111';
const store = vi.hoisted(() => ({
  transactions: [] as Array<Record<string, unknown>>,
  shares: [] as Array<Record<string, unknown>>,
  budgets: [] as Array<Record<string, unknown>>,
  created: [] as Array<{ metadata: Record<string, unknown>; title: string; message: string }>,
  existing: [] as Array<{ metadata: Record<string, unknown> }>,
}));
const dec = (n: number) => ({ toNumber: () => n, valueOf: () => n });

vi.mock('../notifications/notifications.service.js', () => ({
  createNotification: vi.fn(async (input: { metadata: Record<string, unknown>; title: string; message: string }) => {
    store.created.push(input);
    return input;
  }),
}));
vi.mock('../../shared/db/prisma.js', () => {
  const txRow = (r: Record<string, unknown>) => ({ ...r, amount: dec(r.amount as number), date: new Date(`${r.date}T00:00:00.000Z`) });
  const budgetRow = (b: Record<string, unknown>) => ({ ...b, monthlyLimit: dec(b.monthlyLimit as number) });
  return {
    prisma: {
      transaction: { findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => store.transactions.filter((r) => matchesWhere(r as Row, args.where)).map(txRow)) },
      transactionShare: {
        findMany: vi.fn(async (args: { where: Record<string, unknown> & { transaction: Record<string, unknown> } }) => {
          const { transaction, ...own } = args.where;
          return store.shares
            .filter((s) => matchesWhere(s as Row, own))
            .map((s) => ({ s, tx: store.transactions.find((t) => t.id === s.transactionId) }))
            .filter(({ tx }) => tx && matchesWhere(tx as Row, transaction))
            .map(({ s, tx }) => ({ transactionId: s.transactionId, amount: dec(s.amount as number), transaction: { amount: dec(tx!.amount as number), categoryName: tx!.categoryName } }));
        }),
      },
      budget: {
        findMany: vi.fn(async () => store.budgets.map(budgetRow)),
        findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
          const { month, ...rest } = args.where as { month: Date } & Record<string, unknown>;
          const found = store.budgets.find((b) => (b.month as Date).getTime() === month.getTime() && matchesWhere(b as Row, rest));
          return found ? budgetRow(found) : null;
        }),
      },
      householdMember: { findMany: vi.fn(async () => [{ userId: 'u1', user: { id: 'u1' } }]) },
      notification: { findMany: vi.fn(async () => store.existing) },
      category: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
    },
  };
});

const { getBudgetSummary } = await import('./budgets.service.js');
const { checkBudgetThresholds } = await import('../notifications/budget-notifications.service.js');
const { measuredAmount } = await import('./budget-spending.js');
const { createBudgetSchema, updateBudgetSchema } = await import('./budgets.schema.js');

const MONTH = new Date(Date.UTC(2026, 9, 1));
let seq = 0;
function tx(over: Record<string, unknown> = {}): string {
  seq += 1;
  const row = { id: `t-${seq}`, householdId: HH, type: 'EXPENSE', categoryName: 'GROCERIES', amount: -100, date: '2026-10-05', competenceMonth: null, ...over };
  store.transactions.push(row);
  return row.id;
}
function share(transactionId: string, amount: number) {
  seq += 1;
  store.shares.push({ id: `s-${seq}`, householdId: HH, transactionId, personId: `p-${seq}`, direction: 'THEY_OWE_ME', amount });
}
const budget = (over: Record<string, unknown> = {}) =>
  store.budgets.push({ id: `b-${store.budgets.length}`, householdId: HH, categoryName: 'GROCERIES', monthlyLimit: 100, month: MONTH, type: 'EXPENSE', measure: 'WHOLE', ...over });

beforeEach(() => {
  store.transactions.length = 0;
  store.shares.length = 0;
  store.budgets.length = 0;
  store.created.length = 0;
  store.existing.length = 0;
  seq = 0;
});

type Line = { categoryName: string; measure: string; spending: number; ownSpent: number; measured: number; remaining: number; percentage: number; isOverBudget: boolean };
const summary = async () => (await getBudgetSummary({ householdId: HH, month: '2026-10' } as never)) as { budgets: Line[] };
const alert = (category = 'GROCERIES') => checkBudgetThresholds(HH, category, new Date('2026-10-05T00:00:00.000Z'), 100, 'EXPENSE', null);

describe('measured amount', () => {
  it('WHOLE is the spending; OWN_SHARE is the own share, for an expense budget only', () => {
    expect(measuredAmount({ type: 'EXPENSE', measure: 'WHOLE' }, 100, 70)).toBe(100);
    expect(measuredAmount({ type: 'EXPENSE', measure: 'OWN_SHARE' }, 100, 70)).toBe(70);
    expect(measuredAmount({ type: 'INCOME', measure: 'OWN_SHARE' }, 100, 70)).toBe(100);
    expect(measuredAmount({ type: 'EXPENSE', measure: undefined }, 100, 70)).toBe(100);
  });
});

describe('budget summary: the mode decides what the percentage, the remaining and the over-budget flag follow', () => {
  it('together (WHOLE): the full spending, as before; own share stays informative', async () => {
    budget({ monthlyLimit: 100 });
    share(tx({ amount: -120 }), 50);
    const [b] = (await summary()).budgets;
    expect(b).toMatchObject({ measure: 'WHOLE', spending: 120, ownSpent: 70, measured: 120, remaining: -20, percentage: 120, isOverBudget: true });
  });

  it('separate (OWN_SHARE): the own share; the same data is not over the budget', async () => {
    budget({ monthlyLimit: 100, measure: 'OWN_SHARE' });
    share(tx({ amount: -120 }), 50);
    const [b] = (await summary()).budgets;
    expect(b).toMatchObject({ measure: 'OWN_SHARE', spending: 120, ownSpent: 70, measured: 70, remaining: 30, percentage: 70, isOverBudget: false });
  });

  it('two budgets of one month, one of each mode, over the same expenses', async () => {
    budget({ monthlyLimit: 200 });
    budget({ categoryName: 'GENERAL', monthlyLimit: 200, measure: 'OWN_SHARE' });
    share(tx({ amount: -150 }), 60);
    tx({ amount: -30, categoryName: 'TRANSPORTATION' });
    const r = (await summary()).budgets;
    expect(r.map((b) => [b.categoryName, b.measured, b.percentage])).toEqual([['GROCERIES', 150, 75], ['GENERAL', 120, 60]]);
  });

  it('a budget row without the column (older data) is measured as WHOLE', async () => {
    budget({ measure: undefined });
    share(tx({ amount: -80 }), 30);
    expect((await summary()).budgets[0]).toMatchObject({ measure: 'WHOLE', measured: 80 });
  });
});

describe('budget alerts follow the mode of the budget', () => {
  it('together: 120 of 100 is exceeded even though part is owed back', async () => {
    budget();
    share(tx({ amount: -120 }), 50);
    await alert();
    expect(store.created).toHaveLength(1);
    expect(store.created[0]!.title).toContain('excedido');
    expect(store.created[0]!.metadata).toMatchObject({ spending: 120, measure: 'WHOLE', percentage: 120 });
  });

  it('separate: the same data is at 70%, no alert; with a smaller share it reaches 75% and warns on the own share', async () => {
    budget({ measure: 'OWN_SHARE' });
    const id = tx({ amount: -120 });
    share(id, 50);
    await alert();
    expect(store.created).toHaveLength(0);
    store.shares[0]!.amount = 40;
    await alert();
    expect(store.created).toHaveLength(1);
    expect(store.created[0]!.title).toContain('75%');
    expect(store.created[0]!.metadata).toMatchObject({ spending: 80, fullSpending: 120, measure: 'OWN_SHARE', percentage: 80 });
  });

  it('the alert and the summary give the same measured amount in both modes', async () => {
    budget({ measure: 'OWN_SHARE', monthlyLimit: 50 });
    share(tx({ amount: -90.1 }), 20.05);
    tx({ amount: -10 });
    await alert();
    const [b] = (await summary()).budgets;
    expect(store.created[0]!.metadata.spending).toBe(b!.measured);
    expect(b!.measured).toBe(80.05);
  });
});

describe('the General budget alerts too', () => {
  it('an expense of any category counts on the General budget of the month and warns it', async () => {
    budget({ categoryName: 'GENERAL', monthlyLimit: 200 });
    tx({ amount: -90 });
    tx({ amount: -70, categoryName: 'TRANSPORTATION' });
    await alert('TRANSPORTATION');
    expect(store.created).toHaveLength(1);
    expect(store.created[0]!.title).toBe('Orçamento Geral atingiu 75%');
    expect(store.created[0]!.metadata).toMatchObject({ categoryName: 'GENERAL', spending: 160, percentage: 80 });
  });

  it('the category budget and the General budget are checked each on its own: one exceeded, the other at 75%', async () => {
    budget({ monthlyLimit: 100 });
    budget({ categoryName: 'GENERAL', monthlyLimit: 200 });
    tx({ amount: -110 });
    tx({ amount: -45, categoryName: 'TRANSPORTATION' });
    await alert();
    expect(store.created.map((n) => [n.metadata.budgetId, n.metadata.percentage])).toEqual([['b-0', 110], ['b-1', 77.5]]);
  });

  it('a threshold already notified for the General budget is not sent again; the category one still is', async () => {
    budget({ monthlyLimit: 100 });
    budget({ categoryName: 'GENERAL', monthlyLimit: 200 });
    tx({ amount: -160 });
    store.existing.push({ metadata: { budgetId: 'b-1', percentage: 80 } });
    await alert();
    expect(store.created.map((n) => n.metadata.budgetId)).toEqual(['b-0']);
  });

  it('a General INCOME budget, a General budget of another month and another household never alert', async () => {
    budget({ categoryName: 'GENERAL', type: 'INCOME', monthlyLimit: 10 });
    budget({ categoryName: 'GENERAL', monthlyLimit: 10, month: new Date(Date.UTC(2026, 10, 1)) });
    budget({ categoryName: 'GENERAL', monthlyLimit: 10, householdId: '99999999-9999-4999-8999-999999999999' });
    tx({ amount: -500 });
    await alert();
    expect(store.created).toHaveLength(0);
  });

  it('the General budget in the separate mode uses the own share of every category', async () => {
    budget({ categoryName: 'GENERAL', monthlyLimit: 100, measure: 'OWN_SHARE' });
    share(tx({ amount: -90 }), 60);
    share(tx({ amount: -60, categoryName: 'TRANSPORTATION' }), 10);
    await alert();
    expect(store.created).toHaveLength(1);
    expect(store.created[0]!.metadata).toMatchObject({ spending: 80, fullSpending: 150, percentage: 80 });
  });
});

describe('request schemas', () => {
  const base = { categoryName: 'GROCERIES', monthlyLimit: 100, month: '2026-10-01', type: 'EXPENSE' };
  it('measure is optional on create (WHOLE by default) and on update; unknown values are refused', () => {
    expect(createBudgetSchema.parse(base).measure).toBe('WHOLE');
    expect(createBudgetSchema.parse({ ...base, measure: 'OWN_SHARE' }).measure).toBe('OWN_SHARE');
    expect(() => createBudgetSchema.parse({ ...base, measure: 'HALF' })).toThrow();
    expect(updateBudgetSchema.parse({ measure: 'OWN_SHARE' }).measure).toBe('OWN_SHARE');
    expect(updateBudgetSchema.parse({}).measure).toBeUndefined();
  });

  it('an income budget cannot be measured by the own share', () => {
    expect(() => createBudgetSchema.parse({ ...base, categoryName: 'SALARY', type: 'INCOME', measure: 'OWN_SHARE' })).toThrow();
    expect(createBudgetSchema.parse({ ...base, categoryName: 'SALARY', type: 'INCOME' }).measure).toBe('WHOLE');
  });
});
