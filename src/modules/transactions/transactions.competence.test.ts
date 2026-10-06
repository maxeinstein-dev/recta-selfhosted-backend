import { beforeEach, describe, expect, it, vi } from 'vitest';
import { matchesWhere, type Row } from '../../shared/__fixtures__/where-eval.js';

// Reference month (competencia) in the month views: every place that groups or filters "by month" counts a row in
// COALESCE(competence_month, month of date). The fake keeps rows in memory and evaluates the `where` the services build,
// so a service that kept filtering on `date` alone would fail here. Invented data only.
const HH = 'hh-1';
const store = vi.hoisted(() => ({ transactions: [] as Array<Record<string, unknown>> }));

const decimal = (n: number) => ({ toNumber: () => n });
const asRow = (r: Record<string, unknown>) => ({ ...r, amount: decimal(r.amount as number), date: new Date(`${r.date}T00:00:00.000Z`) });
const stored = () => store.transactions.map((t) => ({ ...t })) as Row[];

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    transaction: {
      findMany: vi.fn(async (args: { where?: Record<string, unknown>; take?: number; include?: { account?: unknown } }) => {
        let list = stored().filter((r) => matchesWhere(r, args.where));
        list = list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
        if (args.take) list = list.slice(0, args.take);
        return list.map((r) => ({ ...asRow(r), account: r.accountType ? { type: r.accountType } : null }));
      }),
      count: vi.fn(async (args: { where?: Record<string, unknown> }) => stored().filter((r) => matchesWhere(r, args.where)).length),
      groupBy: vi.fn(async (args: { where?: Record<string, unknown> }) => {
        const groups = new Map<string, { sum: number; n: number }>();
        for (const r of stored().filter((row) => matchesWhere(row, args.where))) {
          const g = groups.get(r.categoryName as string) ?? { sum: 0, n: 0 };
          g.sum += r.amount as number;
          g.n += 1;
          groups.set(r.categoryName as string, g);
        }
        return [...groups.entries()].map(([categoryName, g]) => ({ categoryName, _sum: { amount: decimal(g.sum) }, _count: g.n }));
      }),
    },
    category: { findMany: vi.fn(async () => []) },
  },
}));

const { listTransactions, getTransactionSummary, getSpendingByCategory, getMonthlyRecap } = await import('./transactions.service.js');

let seq = 0;
function tx(over: Partial<{ date: string; competenceMonth: string | null; amount: number; type: 'INCOME' | 'EXPENSE' | 'TRANSFER'; categoryName: string; description: string; accountType: string; paid: boolean }>) {
  seq += 1;
  const row = {
    id: `t-${seq}`,
    householdId: HH,
    type: 'EXPENSE',
    categoryName: 'GROCERIES',
    amount: -10,
    description: `Linha ${seq}`,
    notes: null,
    competenceMonth: null,
    paid: true,
    accountId: 'acc',
    accountType: 'CHECKING',
    createdAt: seq,
    ...over,
  };
  store.transactions.push(row);
  return row;
}

beforeEach(() => {
  store.transactions.length = 0;
  seq = 0;
});

const base = { householdId: HH, limit: 50 } as const;
const idsOf = async (query: Record<string, unknown>) => (await listTransactions({ ...base, ...query } as never)).data.map((t) => (t as { description: string }).description);

describe('listTransactions month filter', () => {
  it('without any reference month the month filter selects exactly what the date range selected (regression)', async () => {
    tx({ date: '2026-09-30', description: 'sep-last' });
    tx({ date: '2026-10-01', description: 'oct-first' });
    tx({ date: '2026-10-15', description: 'oct-mid' });
    tx({ date: '2026-10-31', description: 'oct-last' });
    tx({ date: '2026-11-01', description: 'nov-first' });
    expect((await idsOf({ month: '2026-10' })).sort()).toEqual(['oct-first', 'oct-last', 'oct-mid']);
    expect((await idsOf({ month: '2026-09' })).sort()).toEqual(['sep-last']);
    expect((await listTransactions({ ...base, month: '2026-10' } as never)).pagination.total).toBe(3);
  });

  it('an income dated 25 Sep that refers to October shows in October and not in September', async () => {
    tx({ date: '2026-09-25', competenceMonth: '2026-10', type: 'INCOME', amount: 500, description: 'vale' });
    tx({ date: '2026-09-10', description: 'sep-plain' });
    expect(await idsOf({ month: '2026-10' })).toEqual(['vale']);
    expect(await idsOf({ month: '2026-09' })).toEqual(['sep-plain']);
  });

  it('a reference month equal to the month of the date changes nothing, and one in another month moves the row', async () => {
    tx({ date: '2026-10-05', competenceMonth: '2026-10', description: 'same' });
    tx({ date: '2026-10-25', competenceMonth: '2026-11', description: 'moved' });
    expect(await idsOf({ month: '2026-10' })).toEqual(['same']);
    expect(await idsOf({ month: '2026-11' })).toEqual(['moved']);
  });

  it('keeps the month filter when a text search is also given (search is an OR; the month must not be dropped)', async () => {
    tx({ date: '2026-09-25', competenceMonth: '2026-10', description: 'vale mercado' });
    tx({ date: '2026-09-26', description: 'vale outro mes' });
    tx({ date: '2026-10-03', description: 'vale outubro' });
    expect((await idsOf({ month: '2026-10', search: 'vale' })).sort()).toEqual(['vale mercado', 'vale outubro']);
  });

  it('an explicit startDate/endDate range stays by date (cash view), reference month ignored', async () => {
    tx({ date: '2026-09-25', competenceMonth: '2026-10', description: 'vale' });
    tx({ date: '2026-10-02', description: 'oct' });
    expect(await idsOf({ startDate: new Date(2026, 8, 20), endDate: new Date(2026, 8, 30) })).toEqual(['vale']);
  });

  it('the paid filter lists the pending ones', async () => {
    tx({ date: '2026-10-02', description: 'settled' });
    tx({ date: '2026-10-25', description: 'forecast', paid: false });
    expect(await idsOf({ paid: false })).toEqual(['forecast']);
    expect(await idsOf({ paid: true })).toEqual(['settled']);
    expect((await idsOf({})).sort()).toEqual(['forecast', 'settled']);
  });
});

describe('getTransactionSummary (month)', () => {
  it('counts a reference-month income in its month only and keeps the old numbers when nothing is referenced', async () => {
    tx({ date: '2026-10-05', type: 'INCOME', amount: 1000, categoryName: 'SALARY' });
    tx({ date: '2026-10-06', type: 'EXPENSE', amount: -200 });
    const before = await getTransactionSummary({ householdId: HH, month: '2026-10' });
    expect(before).toMatchObject({ income: 1000, expenses: 200, balance: 800, transactionCount: 2 });

    tx({ date: '2026-09-25', competenceMonth: '2026-10', type: 'INCOME', amount: 600, categoryName: 'OTHER_INCOME' });
    expect(await getTransactionSummary({ householdId: HH, month: '2026-10' })).toMatchObject({ income: 1600, expenses: 200, balance: 1400 });
    expect(await getTransactionSummary({ householdId: HH, month: '2026-09' })).toMatchObject({ income: 0, expenses: 0 });
  });

  it('does not touch transfers: a transfer counts nowhere in the totals, referenced or not', async () => {
    tx({ date: '2026-10-05', type: 'TRANSFER', amount: 300 });
    expect(await getTransactionSummary({ householdId: HH, month: '2026-10' })).toMatchObject({ income: 0, expenses: 0 });
  });

  it('a custom range is by date', async () => {
    tx({ date: '2026-09-25', competenceMonth: '2026-10', type: 'INCOME', amount: 600, categoryName: 'OTHER_INCOME' });
    const r = await getTransactionSummary({ householdId: HH, startDate: new Date(2026, 8, 1), endDate: new Date(2026, 8, 30) });
    expect(r.income).toBe(600);
  });
});

describe('getSpendingByCategory (month)', () => {
  it('groups an expense by its reference month', async () => {
    tx({ date: '2026-10-05', categoryName: 'GROCERIES', amount: -100 });
    tx({ date: '2026-09-28', competenceMonth: '2026-10', categoryName: 'GROCERIES', amount: -50 });
    tx({ date: '2026-10-29', competenceMonth: '2026-11', categoryName: 'GROCERIES', amount: -70 });
    const oct = await getSpendingByCategory({ householdId: HH, month: '2026-10' });
    expect(oct).toHaveLength(1);
    expect(oct[0]).toMatchObject({ categoryName: 'GROCERIES', total: 150, count: 2 });
    const nov = await getSpendingByCategory({ householdId: HH, month: '2026-11' });
    expect(nov[0]).toMatchObject({ total: 70, count: 1 });
  });
});

describe('getMonthlyRecap', () => {
  it('uses the reference month for the month and for the previous month comparison', async () => {
    tx({ date: '2026-10-05', type: 'INCOME', amount: 1000, categoryName: 'SALARY' });
    tx({ date: '2026-09-25', competenceMonth: '2026-10', type: 'INCOME', amount: 500, categoryName: 'OTHER_INCOME' });
    tx({ date: '2026-09-10', type: 'INCOME', amount: 900, categoryName: 'SALARY' });
    tx({ date: '2026-08-26', competenceMonth: '2026-09', type: 'INCOME', amount: 100, categoryName: 'OTHER_INCOME' });
    const recap = await getMonthlyRecap({ householdId: HH, month: '2026-10' });
    expect(recap.summary.income).toBe(1500);
    expect(recap.comparison.prevIncome).toBe(1000);
  });

  it('without reference months the recap is what it was', async () => {
    tx({ date: '2026-10-05', type: 'INCOME', amount: 1000, categoryName: 'SALARY' });
    tx({ date: '2026-10-31', type: 'EXPENSE', amount: -300 });
    tx({ date: '2026-09-30', type: 'EXPENSE', amount: -100 });
    tx({ date: '2026-11-01', type: 'EXPENSE', amount: -900 });
    const recap = await getMonthlyRecap({ householdId: HH, month: '2026-10' });
    expect(recap.summary).toMatchObject({ income: 1000, expenses: 300, balance: 700, transactionCount: 2 });
    expect(recap.comparison).toMatchObject({ prevIncome: 0, prevExpenses: 100 });
  });
});
