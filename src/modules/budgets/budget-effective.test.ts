import { beforeEach, describe, expect, it, vi } from 'vitest';
import { matchesWhere, type Row } from '../../shared/__fixtures__/where-eval.js';

// A budget repeats: it is in force from its month on, until a later budget of the same category and type replaces it
// or until its end month. The summary (the screens) and the alerts find the budget in force through one function.
// Invented data only; the fake database runs the real `where` and `orderBy` of each query.
const HH = '11111111-1111-4111-8111-111111111111';
const OTHER_HH = '99999999-9999-4999-8999-999999999999';
const store = vi.hoisted(() => ({
  transactions: [] as Array<Record<string, unknown>>,
  budgets: [] as Array<Record<string, unknown>>,
  created: [] as Array<{ metadata: Record<string, unknown>; title: string }>,
  existing: [] as Array<{ metadata: Record<string, unknown> }>,
}));
const dec = (n: number) => ({ toNumber: () => n, valueOf: () => n });

vi.mock('../notifications/notifications.service.js', () => ({
  createNotification: vi.fn(async (input: { metadata: Record<string, unknown>; title: string }) => {
    store.created.push(input);
    return input;
  }),
}));
vi.mock('../../shared/db/prisma.js', () => {
  const txRow = (r: Record<string, unknown>) => ({ ...r, amount: dec(r.amount as number), date: new Date(`${r.date}T00:00:00.000Z`) });
  const budgetRow = (b: Record<string, unknown>) => ({ ...b, monthlyLimit: dec(b.monthlyLimit as number) });
  const findBudgets = (args: { where?: Record<string, unknown>; orderBy?: unknown } = {}) => {
    const rows = store.budgets.filter((b) => matchesWhere(b as Row, args.where));
    // every budget query that orders does it by month, newest first
    if (args.orderBy) rows.sort((a, b) => (b.month as Date).getTime() - (a.month as Date).getTime());
    return rows.map(budgetRow);
  };
  return {
    prisma: {
      transaction: { findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => store.transactions.filter((r) => matchesWhere(r as Row, args.where)).map(txRow)) },
      transactionShare: { findMany: vi.fn(async () => []) },
      budget: {
        findMany: vi.fn(async (args) => findBudgets(args)),
        findFirst: vi.fn(async (args) => findBudgets(args)[0] ?? null),
      },
      householdMember: { findMany: vi.fn(async () => [{ userId: 'u1', user: { id: 'u1' } }]) },
      notification: { findMany: vi.fn(async () => store.existing) },
      category: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
    },
  };
});

const { getBudgetSummary } = await import('./budgets.service.js');
const { checkBudgetThresholds } = await import('../notifications/budget-notifications.service.js');
const { pickEffectiveBudgets, monthStartOf } = await import('./budget-effective.js');
const { updateBudgetSchema } = await import('./budgets.schema.js');

const month = (key: string) => new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1));
let seq = 0;
function tx(over: Record<string, unknown> = {}) {
  seq += 1;
  store.transactions.push({ id: `t-${seq}`, householdId: HH, type: 'EXPENSE', categoryName: 'GROCERIES', amount: -100, date: '2026-12-05', competenceMonth: null, attachmentUrl: null, ...over });
}
const budget = (over: Record<string, unknown> = {}) => {
  const row = { id: `b-${store.budgets.length}`, householdId: HH, categoryName: 'GROCERIES', monthlyLimit: 100, month: month('2026-11'), endMonth: null, type: 'EXPENSE', measure: 'WHOLE', ...over };
  store.budgets.push(row);
  return row.id as string;
};

beforeEach(() => {
  store.transactions.length = 0;
  store.budgets.length = 0;
  store.created.length = 0;
  store.existing.length = 0;
  seq = 0;
});

type Line = { budgetId: string; categoryName: string; monthlyLimit: number; spending: number; month: string; endMonth: string | null; type: string };
const summary = async (key: string) => (await getBudgetSummary({ householdId: HH, month: key } as never)) as unknown as { budgets: Line[]; totalLimit: number };
const alert = (day: string, category = 'GROCERIES') => checkBudgetThresholds(HH, category, new Date(`${day}T00:00:00.000Z`), 100, 'EXPENSE', null);

describe('which budget is in force in a month', () => {
  const row = (id: string, key: string, over: Record<string, unknown> = {}) => ({ id, categoryName: 'GROCERIES', type: 'EXPENSE', month: month(key), endMonth: null, ...over });

  it('the newest budget whose month is not after the month asked, per category and type', () => {
    const rows = [row('nov', '2026-11'), row('jan', '2027-01'), row('mar', '2027-03')];
    const ids = (key: string) => pickEffectiveBudgets(rows, key).map((b) => b.id);
    expect(ids('2026-10')).toEqual([]);
    expect(ids('2026-11')).toEqual(['nov']);
    expect(ids('2026-12')).toEqual(['nov']);
    expect(ids('2027-01')).toEqual(['jan']);
    expect(ids('2027-02')).toEqual(['jan']);
    expect(ids('2028-06')).toEqual(['mar']);
  });

  it('an ended budget is in force up to its end month, included, and nothing takes its place after it', () => {
    const rows = [row('nov', '2026-11', { endMonth: month('2027-01') })];
    const ids = (key: string) => pickEffectiveBudgets(rows, key).map((b) => b.id);
    expect(ids('2027-01')).toEqual(['nov']);
    expect(ids('2027-02')).toEqual([]);
  });

  it('an older budget does not come back when the newer one ended', () => {
    const rows = [row('nov', '2026-11'), row('jan', '2027-01', { endMonth: month('2027-02') })];
    expect(pickEffectiveBudgets(rows, '2027-03').map((b) => b.id)).toEqual([]);
  });

  it('categories and types are apart: the General income budget and the General expense budget both hold', () => {
    const rows = [row('g-exp', '2026-11', { categoryName: 'GENERAL' }), row('g-inc', '2026-11', { categoryName: 'GENERAL', type: 'INCOME' }), row('food', '2026-12')];
    expect(pickEffectiveBudgets(rows, '2026-12').map((b) => b.id).sort()).toEqual(['food', 'g-exp', 'g-inc']);
  });

  it('month start of a key is the UTC first day', () => {
    expect(monthStartOf('2026-12').toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});

describe('budget summary of a month: the budgets in force, with the spending of that month', () => {
  it('a budget created in November shows in December with the spending of December, and in November with that of November', async () => {
    budget();
    tx({ amount: -40, date: '2026-11-10' });
    tx({ amount: -65, date: '2026-12-05' });
    const december = await summary('2026-12');
    expect(december.budgets).toHaveLength(1);
    expect(december.budgets[0]).toMatchObject({ budgetId: 'b-0', spending: 65, month: '2026-11', endMonth: null, monthlyLimit: 100 });
    expect((await summary('2026-11')).budgets[0]).toMatchObject({ spending: 40 });
  });

  it('a new amount from January on does not change what November and December show', async () => {
    budget();
    budget({ monthlyLimit: 250, month: month('2027-01') });
    expect((await summary('2026-12')).budgets.map((b) => [b.budgetId, b.monthlyLimit])).toEqual([['b-0', 100]]);
    expect((await summary('2027-01')).budgets.map((b) => [b.budgetId, b.monthlyLimit])).toEqual([['b-1', 250]]);
    expect((await summary('2027-04')).budgets.map((b) => [b.budgetId, b.monthlyLimit])).toEqual([['b-1', 250]]);
  });

  it('before the first budget there is none; an ended one is gone the month after; totals only count the ones in force', async () => {
    budget({ endMonth: month('2026-12') });
    budget({ categoryName: 'TRANSPORTATION', monthlyLimit: 30, month: month('2026-12') });
    expect((await summary('2026-10')).budgets).toEqual([]);
    expect((await summary('2026-12')).totalLimit).toBe(130);
    const january = await summary('2027-01');
    expect(january.budgets.map((b) => b.categoryName)).toEqual(['TRANSPORTATION']);
    expect(january.totalLimit).toBe(30);
  });

  it('a budget of another household is never in force here', async () => {
    budget({ householdId: OTHER_HH });
    expect((await summary('2026-12')).budgets).toEqual([]);
  });
});

describe('budget alerts use the budget in force', () => {
  it('a November budget alerts on a December expense, with the spending of December only', async () => {
    budget();
    tx({ amount: -90, date: '2026-11-20' });
    tx({ amount: -80, date: '2026-12-05' });
    await alert('2026-12-05');
    expect(store.created).toHaveLength(1);
    expect(store.created[0]!.metadata).toMatchObject({ budgetId: 'b-0', spending: 80, percentage: 80 });
  });

  it('the General budget in force alerts too, and the replaced amount is not used', async () => {
    budget({ categoryName: 'GENERAL', monthlyLimit: 1000 });
    budget({ categoryName: 'GENERAL', monthlyLimit: 100, month: month('2026-12') });
    tx({ amount: -80, date: '2026-12-05', categoryName: 'TRANSPORTATION' });
    await alert('2026-12-05', 'TRANSPORTATION');
    expect(store.created.map((n) => [n.metadata.budgetId, n.metadata.limit])).toEqual([['b-1', 100]]);
  });

  it('an ended budget does not alert after its end month; no budget before its first month', async () => {
    budget({ endMonth: month('2026-11') });
    tx({ amount: -500, date: '2026-12-05' });
    await alert('2026-12-05');
    tx({ amount: -500, date: '2026-10-05' });
    await alert('2026-10-05');
    expect(store.created).toHaveLength(0);
  });

  it('the alert and the summary pick the same budget and the same amount', async () => {
    budget();
    budget({ monthlyLimit: 60, month: month('2026-12') });
    tx({ amount: -50, date: '2026-12-05' });
    await alert('2026-12-05');
    const [line] = (await summary('2026-12')).budgets;
    expect(store.created[0]!.metadata).toMatchObject({ budgetId: line!.budgetId, limit: line!.monthlyLimit, spending: line!.spending });
  });
});

describe('ending a budget', () => {
  it('the update request takes an end month as a local day or null (to reopen it)', () => {
    expect(updateBudgetSchema.parse({ endMonth: '2026-12-01' }).endMonth).toBeInstanceOf(Date);
    expect(updateBudgetSchema.parse({ endMonth: null }).endMonth).toBeNull();
    expect(updateBudgetSchema.parse({}).endMonth).toBeUndefined();
  });
});
