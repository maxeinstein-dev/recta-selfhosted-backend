import { beforeEach, describe, expect, it, vi } from 'vitest';
import { matchesWhere, type Row } from '../../shared/__fixtures__/where-eval.js';

// Invented data only. The fake database runs the real `where` of each query over in-memory rows; the group map, the
// expected income and the recurrence walk of the cash flow are stubbed (they have their own tests).
const HH = '11111111-1111-4111-8111-111111111111';
const OTHER_HH = '99999999-9999-4999-8999-999999999999';
const CASA = 'g-casa';
const DIA = 'g-dia';
const store = vi.hoisted(() => ({
  transactions: [] as Array<Record<string, unknown>>,
  shares: [] as Array<Record<string, unknown>>,
  accounts: [] as Array<Record<string, unknown>>,
  recurrences: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  income: 0,
}));
const dec = (n: number) => ({ toNumber: () => n, valueOf: () => n });

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    transaction: {
      findMany: vi.fn(async (args: { where?: Record<string, unknown> }) =>
        store.transactions.filter((r) => matchesWhere(r as Row, args.where)).map((r) => ({ ...r, amount: dec(r.amount as number) })),
      ),
    },
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
    account: { findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => store.accounts.filter((a) => matchesWhere(a as Row, args.where))) },
    recurringTransaction: { findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => store.recurrences.filter((r) => matchesWhere(r as Row, args.where))) },
  },
}));
vi.mock('../category-groups/category-groups.service.js', () => ({
  loadGroupMap: vi.fn(async () => ({
    groups: [
      { id: CASA, name: 'Casa', sortOrder: 0, color: null, isHousing: true },
      { id: DIA, name: 'Dia a dia', sortOrder: 1, color: null, isHousing: false },
    ],
    groupOf: new Map([
      ['HOUSING', CASA],
      ['UTILITIES', CASA],
      ['FOOD', DIA],
    ]),
  })),
}));
vi.mock('../transactions/credit-card-commitment.js', async (orig) => ({
  ...(await orig<object>()),
  expectedIncomeByMonth: vi.fn(async (_hh: string, months: string[]) => new Map(months.map((m) => [m, store.income]))),
}));
vi.mock('./cash-flow.loader.js', () => ({ recurrenceEvents: vi.fn(async () => store.events) }));

const { loadIncomeSplit } = await import('./income-split.loader.js');
const { loadGroupMap } = await import('../category-groups/category-groups.service.js');
const { expectedIncomeByMonth } = await import('../transactions/credit-card-commitment.js');
const { recurrenceEvents } = await import('./cash-flow.loader.js');

let seq = 0;
function tx(over: Record<string, unknown> = {}) {
  seq += 1;
  const row = { id: `t-${seq}`, householdId: HH, type: 'EXPENSE', categoryName: 'FOOD', amount: -100, date: '2026-11-05', competenceMonth: null, accountId: 'acc', attachmentUrl: null, ...over };
  store.transactions.push(row);
  return row.id as string;
}
const today = new Date(Date.UTC(2026, 10, 13));
const load = () => loadIncomeSplit({ householdId: HH, month: '2026-11', today });
const group = (split: Awaited<ReturnType<typeof load>>, key: string) => split.groups.find((g) => g.key === key)!;

beforeEach(() => {
  vi.clearAllMocks();
  store.transactions = [];
  store.shares = [];
  store.events = [];
  store.recurrences = [];
  store.income = 1_000_000;
  store.accounts = [
    { id: 'acc', householdId: HH, isActive: true, type: 'CHECKING' },
    { id: 'card', householdId: HH, isActive: true, type: 'CREDIT' },
    { id: 'old', householdId: HH, isActive: false, type: 'CHECKING' },
    { id: 'alien', householdId: OTHER_HH, isActive: true, type: 'CHECKING' },
  ];
});

describe('loadIncomeSplit', () => {
  it('uses the household expected income, and says so', async () => {
    const split = await load();
    expect(vi.mocked(expectedIncomeByMonth)).toHaveBeenCalledWith(HH, ['2026-11']);
    expect(vi.mocked(loadGroupMap)).toHaveBeenCalledWith(HH);
    expect(split.income).toEqual({ amount: 10000, basis: 'expected' });
    expect(split.month).toBe('2026-11');
  });

  it('counts the month expenses by group, by planning month, and leaves income and other months out', async () => {
    tx({ categoryName: 'HOUSING', amount: -1500 });
    tx({ categoryName: 'FOOD', amount: -80.5, card: true, accountId: 'card' });
    tx({ categoryName: 'FOOD', amount: -10, date: '2026-10-28', competenceMonth: '2026-11' }); // belongs to November
    tx({ categoryName: 'FOOD', amount: -999, date: '2026-11-02', competenceMonth: '2026-10' }); // belongs to October
    tx({ categoryName: 'FOOD', amount: -777, date: '2026-12-01' });
    tx({ type: 'INCOME', categoryName: 'SALARY', amount: 5000 });
    const split = await load();
    expect(group(split, CASA).realized).toBe(1500);
    expect(group(split, DIA).realized).toBe(90.5);
  });

  it('leaves the payment of a card invoice out (the purchases already count)', async () => {
    tx({ categoryName: 'FOOD', amount: -200, accountId: 'card' });
    tx({ categoryName: 'FOOD', amount: -200, attachmentUrl: 'invoice_pay:card:2026-11' });
    tx({ categoryName: null, amount: -200, attachmentUrl: 'invoice_pay:card:2026-10' });
    const split = await load();
    expect(group(split, DIA).realized).toBe(200);
    expect(group(split, 'OTHER').realized).toBe(0);
  });

  it('counts a split purchase by the own share', async () => {
    const id = tx({ categoryName: 'FOOD', amount: -300, isSplit: true });
    store.shares.push({ householdId: HH, transactionId: id, direction: 'THEY_OWE_ME', amount: 100 });
    store.shares.push({ householdId: HH, transactionId: id, direction: 'THEY_OWE_ME', amount: 50.25 });
    store.shares.push({ householdId: HH, transactionId: id, direction: 'I_OWE_THEM', amount: 40 }); // does not reduce it
    const split = await load();
    expect(group(split, DIA).realized).toBe(149.75);
  });

  it('puts an uncategorized or ungrouped expense in Outros', async () => {
    tx({ categoryName: null, amount: -12 });
    tx({ categoryName: 'HEALTHCARE', amount: -30 });
    tx({ categoryName: 'CUSTOM:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', amount: -8 });
    const split = await load();
    expect(group(split, 'OTHER').realized).toBe(50);
  });

  it('ignores the transactions and shares of another household', async () => {
    tx({ householdId: OTHER_HH, categoryName: 'HOUSING', amount: -4000 });
    const mine = tx({ categoryName: 'FOOD', amount: -100 });
    store.shares.push({ householdId: OTHER_HH, transactionId: mine, direction: 'THEY_OWE_ME', amount: 100 });
    const split = await load();
    expect(group(split, CASA).realized).toBe(0);
    expect(group(split, DIA).realized).toBe(100);
  });

  it('adds what is still committed in the month: expense occurrences not generated yet, on cash accounts and cards', async () => {
    store.recurrences = [
      { id: 'r-luz', householdId: HH, categoryName: 'UTILITIES' },
      { id: 'r-streaming', householdId: HH, categoryName: 'SUBSCRIPTIONS' },
      { id: 'r-salario', householdId: HH, categoryName: 'SALARY' },
      { id: 'r-alheia', householdId: OTHER_HH, categoryName: 'HOUSING' },
    ];
    store.events = [
      { date: '2026-11-20', amountCents: -18_990, sourceId: 'r-luz', source: 'recurrence' },
      { date: '2026-11-03', amountCents: -1_000, sourceId: 'r-luz', source: 'recurrence', overdue: true }, // stale, still owed
      { date: '2026-11-25', amountCents: -5_590, sourceId: 'r-streaming', source: 'recurrence' },
      { date: '2026-11-30', amountCents: 500_000, sourceId: 'r-salario', source: 'recurrence' }, // income: not spending
      { date: '2026-12-20', amountCents: -18_990, sourceId: 'r-luz', source: 'recurrence' }, // next month
      { date: '2026-11-21', amountCents: -70_000, sourceId: 'r-alheia', source: 'recurrence' }, // unknown here
    ];
    tx({ categoryName: 'UTILITIES', amount: -100 });
    const split = await load();
    const [householdArg, accountIds, todayArg, endArg] = vi.mocked(recurrenceEvents).mock.calls[0]!;
    expect(householdArg).toBe(HH);
    expect([...(accountIds as string[])].sort()).toEqual(['acc', 'card']);
    expect(todayArg).toBe('2026-11-13');
    expect(endArg).toBe('2026-11-30');
    expect(group(split, CASA)).toMatchObject({ realized: 100, committed: 199.9, amount: 299.9 });
    expect(group(split, 'OTHER').committed).toBe(55.9);
  });

  it('keeps groups plus leftover equal to the income, to the cent', async () => {
    store.income = 333_337;
    tx({ categoryName: 'HOUSING', amount: -1234.56 });
    tx({ categoryName: 'FOOD', amount: -0.07 });
    tx({ categoryName: null, amount: -99.99 });
    const split = await load();
    const total = split.groups.reduce((s, g) => s + Math.round(g.amount * 100), 0) + Math.round(split.leftover.amount * 100);
    expect(total).toBe(333_337);
  });

  it('answers null shares with no expected income', async () => {
    store.income = 0;
    tx({ categoryName: 'HOUSING', amount: -100 });
    const split = await load();
    expect(split.leftover).toEqual({ amount: -100, percentOfIncome: null });
    expect(split.housing.percentOfIncome).toBeNull();
  });
});
