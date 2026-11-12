import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { matchesWhere, type Row } from '../../shared/__fixtures__/where-eval.js';

// The budget summary (what the screens show) and the budget alerts (the notifications) must give the same realized
// amount for the same data. Invented data only; the fake database runs the real `where` of each query.
const HH = '11111111-1111-4111-8111-111111111111';
const OTHER_HH = '99999999-9999-4999-8999-999999999999';
const store = vi.hoisted(() => ({
  transactions: [] as Array<Record<string, unknown>>,
  budgets: [] as Array<Record<string, unknown>>,
  created: [] as Array<{ metadata: Record<string, unknown>; title: string }>,
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
  return {
    prisma: {
      transaction: { findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => store.transactions.filter((r) => matchesWhere(r as Row, args.where)).map(txRow)) },
      transactionShare: { findMany: vi.fn(async () => []) },
      budget: {
        findMany: vi.fn(async () => store.budgets.map(budgetRow)),
        findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
          // The month is a Date: compared by instant, the other fields by the real `where`
          const { month, ...rest } = args.where as { month: Date } & Record<string, unknown>;
          const found = store.budgets.find((b) => (b.month as Date).getTime() === month.getTime() && matchesWhere(b as Row, rest));
          return found ? budgetRow(found) : null;
        }),
      },
      householdMember: { findMany: vi.fn(async () => [{ userId: 'u1', user: { id: 'u1' } }]) },
      notification: { findMany: vi.fn(async () => []) },
      category: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
    },
  };
});

const { getBudgetSummary } = await import('./budgets.service.js');
const { checkBudgetThresholds } = await import('../notifications/budget-notifications.service.js');
const { budgetSpendingWhere, sumSpending } = await import('./budget-spending.js');

const MONTH = new Date(Date.UTC(2026, 9, 1));
let seq = 0;
function tx(over: Record<string, unknown> = {}) {
  seq += 1;
  store.transactions.push({ id: `t-${seq}`, householdId: HH, type: 'EXPENSE', categoryName: 'GROCERIES', amount: -100, date: '2026-10-05', competenceMonth: null, ...over });
}
const budget = (over: Record<string, unknown> = {}) =>
  store.budgets.push({ id: `b-${store.budgets.length}`, householdId: HH, categoryName: 'GROCERIES', monthlyLimit: 100, month: MONTH, type: 'EXPENSE', ...over });

beforeEach(() => {
  store.transactions.length = 0;
  store.budgets.length = 0;
  store.created.length = 0;
  seq = 0;
});

async function both(): Promise<{ screen: number; alert: number | undefined }> {
  const summary = (await getBudgetSummary({ householdId: HH, month: '2026-10' } as never)) as { budgets: Array<{ categoryName: string; spending: number }> };
  await checkBudgetThresholds(HH, 'GROCERIES', new Date('2026-10-05T00:00:00.000Z'), 100, 'EXPENSE', null);
  return { screen: summary.budgets.find((b) => b.categoryName === 'GROCERIES')!.spending, alert: store.created[0]?.metadata.spending as number | undefined };
}

describe('budget spending: the alert and the screen use one definition', () => {
  it('plain expenses: same amount on both sides', async () => {
    budget();
    tx({ amount: -60.1 });
    tx({ amount: -30.2 });
    expect(await both()).toEqual({ screen: 90.3, alert: 90.3 });
  });

  it('a refund (income) and a transfer filed under the category count on neither side', async () => {
    budget();
    tx({ amount: -80 });
    tx({ type: 'INCOME', amount: 500 });
    tx({ type: 'TRANSFER', amount: -700 });
    expect(await both()).toEqual({ screen: 80, alert: 80 });
  });

  it('the planning month: a row of another date that refers to the month counts, one that refers to another month does not, on both sides', async () => {
    budget();
    tx({ amount: -40 });
    tx({ amount: -45, date: '2026-09-28', competenceMonth: '2026-10' });
    tx({ amount: -900, date: '2026-10-20', competenceMonth: '2026-11' });
    tx({ amount: -900, date: '2026-11-02' });
    expect(await both()).toEqual({ screen: 85, alert: 85 });
  });

  it('another household and another category count on neither side', async () => {
    budget();
    tx({ amount: -76 });
    tx({ amount: -900, householdId: OTHER_HH });
    tx({ amount: -900, categoryName: 'TRANSPORTATION' });
    expect(await both()).toEqual({ screen: 76, alert: 76 });
  });

  it('the payment of a card invoice is not spending: its purchases already count, on neither side and not on the General budget', async () => {
    budget({ monthlyLimit: 200 });
    budget({ categoryName: 'GENERAL', monthlyLimit: 1000 });
    tx({ amount: -90 });
    tx({ amount: -70, attachmentUrl: null });
    tx({ amount: -60, attachmentUrl: 'https://example.test/recibo.pdf' });
    tx({ amount: -5000, attachmentUrl: 'invoice_pay:card-1:2026-9' });
    tx({ amount: -4000, categoryName: 'OTHER_EXPENSES', attachmentUrl: 'invoice_pay:card-1:2026-9' });
    tx({ amount: -30, categoryName: 'OTHER_EXPENSES' });
    const r = await both();
    expect(r).toEqual({ screen: 220, alert: 220 });
    const summary = (await getBudgetSummary({ householdId: HH, month: '2026-10' } as never)) as { budgets: Array<{ categoryName: string; spending: number }> };
    expect(summary.budgets.find((b) => b.categoryName === 'GENERAL')!.spending).toBe(250);
  });

  it('cents add up without float noise', async () => {
    budget({ monthlyLimit: 0.4 });
    tx({ amount: -0.1 });
    tx({ amount: -0.2 });
    expect(await both()).toEqual({ screen: 0.3, alert: 0.3 });
  });

  it('the General budget takes every category of its type; a category budget only its own', () => {
    const period = { AND: [] };
    const notPayment = { OR: [{ attachmentUrl: null }, { NOT: { attachmentUrl: { startsWith: 'invoice_pay:' } } }] };
    expect(budgetSpendingWhere({ householdId: HH, categoryName: 'GENERAL', type: 'EXPENSE' }, period)).toEqual({ householdId: HH, type: 'EXPENSE', AND: [notPayment] });
    expect(budgetSpendingWhere({ householdId: HH, categoryName: 'GROCERIES', type: 'INCOME' }, period)).toEqual({ householdId: HH, categoryName: 'GROCERIES', type: 'INCOME', AND: [notPayment] });
    // the period filter is kept: its conditions and the exclusion are both under AND
    const month = { AND: [{ OR: [{ competenceMonth: '2026-10' }] }] };
    expect(budgetSpendingWhere({ householdId: HH, categoryName: 'GENERAL', type: 'EXPENSE' }, month).AND).toEqual([{ OR: [{ competenceMonth: '2026-10' }] }, notPayment]);
    const range = { date: { gte: new Date('2026-10-01'), lte: new Date('2026-10-31') } };
    expect(budgetSpendingWhere({ householdId: HH, categoryName: 'GENERAL', type: 'EXPENSE' }, range)).toMatchObject({ date: range.date, AND: [notPayment] });
    expect(sumSpending([{ amount: dec(-0.1) }, { amount: dec(0.2) }])).toBe(0.3);
  });

  it('guard: neither side builds its own filter or sum, both go through budget-spending', () => {
    for (const file of ['./budgets.service.ts', '../notifications/budget-notifications.service.ts']) {
      const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(src, file).toContain('budgetSpendingWhere(');
      expect(src, file).toContain('sumSpending(');
      expect(src, `${file} sums amounts by itself`).not.toMatch(/Math\.abs\(t\.amount\.toNumber\(\)\)/);
    }
  });
});
