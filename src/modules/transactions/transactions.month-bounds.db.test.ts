import { execSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * Month filters against a real PostgreSQL. The unit tests prove the bounds; only the database proves what the driver
 * does with them: it sends the UTC date part of a Date, so a local-time end bound (23:59:59.999 of the last day, which
 * is already the first of the next month in UTC) once counted the first day of the following month in every list,
 * total, chart and budget, and added that day to day 1 of the raw-SQL heatmaps.
 *
 * Opt-in: set TEST_DATABASE_ADMIN_URL to a throwaway server (any database of it). The test creates its own scratch
 * database, applies the migrations, runs the scenarios and drops it. Never point it at a server that holds real data.
 *   TZ=America/Sao_Paulo TEST_DATABASE_ADMIN_URL=... npx vitest run src/modules/transactions/transactions.month-bounds.db.test.ts
 *   TZ=UTC               TEST_DATABASE_ADMIN_URL=... npx vitest run src/modules/transactions/transactions.month-bounds.db.test.ts
 */
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;

// Same client as the app, over a pool the test can end, so the scratch database can be dropped quietly.
vi.mock('../../shared/db/prisma.js', async () => {
  const { PrismaClient } = await import('../../generated/prisma/client.js');
  const { PrismaPg } = await import('@prisma/adapter-pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  return { prisma: new PrismaClient({ adapter: new PrismaPg(pool) }), testPool: pool };
});

describe.skipIf(!adminUrl)('month filters on a real database', () => {
  const scratch = `recta_test_monthbounds_${Date.now()}`;
  const admin = new pg.Client({ connectionString: adminUrl });

  let prisma: typeof import('../../shared/db/prisma.js').prisma;
  let pool: pg.Pool;
  let tx: typeof import('./transactions.service.js');
  let dash: typeof import('../dashboard/dashboard.service.js');
  let budgets: typeof import('../budgets/budgets.service.js');
  let householdId: string;
  let bankId: string;

  // What the column holds is a UTC day, so the rows are written as one (not as a local midnight)
  const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
  const ids: Record<string, string> = {};
  const MONTHS = ['2026-09', '2026-10', '2026-11'];
  // [key, day, type, amount]. 30 Sep and 31 Oct are last days, 1 Oct and 1 Nov first days.
  const ROWS: Array<[string, Date, 'EXPENSE' | 'INCOME', number]> = [
    ['sep30', utc(2026, 9, 30), 'EXPENSE', 50],
    ['oct01', utc(2026, 10, 1), 'EXPENSE', 10],
    ['oct15', utc(2026, 10, 15), 'INCOME', 1000],
    ['oct31', utc(2026, 10, 31), 'EXPENSE', 200],
    ['nov01', utc(2026, 11, 1), 'EXPENSE', 70],
  ];
  const EXPECTED: Record<string, string[]> = {
    '2026-09': ['sep30'],
    '2026-10': ['oct01', 'oct15', 'oct31'],
    '2026-11': ['nov01'],
  };
  const keyOf = (id: string) => Object.entries(ids).find(([, v]) => v === id)![0];

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${scratch}"`);
    const scratchUrl = new URL(adminUrl!);
    scratchUrl.pathname = `/${scratch}`;
    execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...process.env, DATABASE_URL: scratchUrl.toString() } });
    process.env.DATABASE_URL = scratchUrl.toString();
    const db = (await import('../../shared/db/prisma.js')) as unknown as { prisma: typeof prisma; testPool: pg.Pool };
    prisma = db.prisma;
    pool = db.testPool;
    tx = await import('./transactions.service.js');
    dash = await import('../dashboard/dashboard.service.js');
    budgets = await import('../budgets/budgets.service.js');

    householdId = (await prisma.household.create({ data: { name: 'Test household' } })).id;
    bankId = (await prisma.account.create({ data: { householdId, name: 'Conta Teste', type: 'CHECKING' } })).id;
    for (const [key, date, type, amount] of ROWS) {
      const row = await prisma.transaction.create({
        data: { householdId, accountId: bankId, type, categoryName: type === 'INCOME' ? 'SALARY' : 'GROCERIES', amount, date, paid: true, description: key },
      });
      ids[key] = row.id;
    }
    // One budget per month, stored the way the service does (first day, UTC midnight), with a limit that names the month
    for (const [i, m] of MONTHS.entries()) {
      await prisma.budget.create({ data: { householdId, categoryName: 'GROCERIES', monthlyLimit: 100 * (i + 1), month: new Date(`${m}-01T00:00:00.000Z`), type: 'EXPENSE' } });
    }
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${scratch}"`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  });

  it('the list of each month has exactly its own rows, and no row is in two months or in none', async () => {
    const seen: string[] = [];
    for (const month of MONTHS) {
      const page = await tx.listTransactions({ householdId, month, limit: 50 });
      const keys = page.data.map((t) => keyOf(t.id)).sort();
      expect(keys, month).toEqual([...EXPECTED[month]!].sort());
      expect(page.pagination.total, month).toBe(EXPECTED[month]!.length);
      seen.push(...keys);
    }
    expect(seen.sort()).toEqual(ROWS.map((r) => r[0]).sort());
  });

  it('the summary of each month counts its own rows only', async () => {
    expect(await tx.getTransactionSummary({ householdId, month: '2026-09' })).toMatchObject({ income: 0, expenses: 50, transactionCount: 1 });
    expect(await tx.getTransactionSummary({ householdId, month: '2026-10' })).toMatchObject({ income: 1000, expenses: 210, transactionCount: 3 });
    expect(await tx.getTransactionSummary({ householdId, month: '2026-11' })).toMatchObject({ income: 0, expenses: 70, transactionCount: 1 });
  });

  it('spending by category follows the same months', async () => {
    const totals = async (month: string) => (await tx.getSpendingByCategory({ householdId, month })).reduce((sum, c) => sum + c.total, 0);
    expect([await totals('2026-09'), await totals('2026-10'), await totals('2026-11')]).toEqual([50, 210, 70]);
  });

  it('the recap of a month and its previous month do not share the boundary days', async () => {
    const october = await tx.getMonthlyRecap({ householdId, month: '2026-10' });
    expect(october.summary).toMatchObject({ income: 1000, expenses: 210 });
    expect(october.comparison.prevExpenses).toBe(50);
    const november = await tx.getMonthlyRecap({ householdId, month: '2026-11' });
    expect(november.summary.expenses).toBe(70);
    expect(november.comparison.prevExpenses).toBe(210);
  });

  it('the dashboard summary, 6-month trend and budget list are each month only', async () => {
    const october = await dash.getDashboardOverview({ householdId, month: '2026-10' });
    expect(october.summary).toMatchObject({ totalIncome: 1000, totalExpense: 210 });
    expect(october.monthlyComparison.slice(3).map((m) => m.expense)).toEqual([0, 50, 210]);
    // one budget, the October one (limit 200): the November one used to leak in through the end bound
    expect(october.budgetVsRealized.map((b) => b.budgeted)).toEqual([200]);
    const september = await dash.getDashboardOverview({ householdId, month: '2026-09' });
    expect(september.summary.totalExpense).toBe(50);
    expect(september.budgetVsRealized.map((b) => b.budgeted)).toEqual([100]);
  });

  it('both heatmaps count day 1 on day 1 and nothing from the next month', async () => {
    const days = (heatmap: { data: Array<{ day: number; amount: number }> }) => heatmap.data.filter((d) => d.amount > 0).map((d) => [d.day, d.amount]);
    const overviewOctober = (await dash.getDashboardOverview({ householdId, month: '2026-10' })).heatmap;
    expect(days(overviewOctober)).toEqual([[1, 10], [31, 200]]);
    expect(days(await tx.getSpendingHeatmap(householdId, '2026-10'))).toEqual([[1, 10], [31, 200]]);
    expect(days(await tx.getSpendingHeatmap(householdId, '2026-09'))).toEqual([[30, 50]]);
    expect(days(await tx.getSpendingHeatmap(householdId, '2026-11'))).toEqual([[1, 70]]);
  });

  it('the budget summary of each month spends only its own rows', async () => {
    const spent = async (month: string) => (await budgets.getBudgetSummary({ householdId, month } as never)).budgets.map((b) => b.spending);
    // the summary lists every budget of the household (three GROCERIES budgets, one per month), all with the month's spending
    expect(await spent('2026-09')).toEqual([50, 50, 50]);
    expect(await spent('2026-10')).toEqual([210, 210, 210]);
    expect(await spent('2026-11')).toEqual([70, 70, 70]);
  });

  it('creating and moving a budget stores the first day of the picked month', async () => {
    const created = await budgets.createBudget({ householdId, categoryName: 'OTHER_EXPENSES', monthlyLimit: 50, month: new Date(2026, 11, 31), type: 'EXPENSE' } as never);
    expect(created.month.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    const { updateBudgetSchema } = await import('../budgets/budgets.schema.js');
    const moved = await budgets.updateBudget(created.id, updateBudgetSchema.parse({ month: '2026-10-01' }));
    expect(moved.month.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});
