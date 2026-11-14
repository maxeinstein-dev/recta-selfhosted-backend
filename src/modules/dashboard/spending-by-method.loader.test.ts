import { beforeEach, describe, expect, it, vi } from 'vitest';
import { matchesWhere, type Row } from '../../shared/__fixtures__/where-eval.js';

// Invented data only. The fake database runs the real `where` of each query over in-memory rows, so the rows that count
// are exactly the ones the budget summary counts (budgetSpendingWhere of the General expense budget, by planning month).
const HH = '11111111-1111-4111-8111-111111111111';
const OTHER_HH = '99999999-9999-4999-8999-999999999999';
const CARD = 'acc-card';
const OLD_CARD = 'acc-old-card';
const CHECKING = 'acc-checking';
const store = vi.hoisted(() => ({
  transactions: [] as Array<Record<string, unknown>>,
  shares: [] as Array<Record<string, unknown>>,
  accounts: [] as Array<Record<string, unknown>>,
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
  },
}));

const { loadSpendingByMethod } = await import('./spending-by-method.loader.js');

let seq = 0;
function tx(over: Record<string, unknown> = {}) {
  seq += 1;
  const row = { id: `t-${seq}`, householdId: HH, type: 'EXPENSE', categoryName: 'FOOD', amount: -100, date: '2026-11-05', competenceMonth: null, accountId: CHECKING, attachmentUrl: null, ...over };
  store.transactions.push(row);
  return row.id as string;
}
const today = new Date(Date.UTC(2026, 10, 13));
const load = (months = 1, to?: string) => loadSpendingByMethod({ householdId: HH, months, to, today });

beforeEach(() => {
  vi.clearAllMocks();
  store.transactions = [];
  store.shares = [];
  store.accounts = [
    { id: CARD, householdId: HH, type: 'CREDIT', isActive: true },
    { id: OLD_CARD, householdId: HH, type: 'CREDIT', isActive: false },
    { id: CHECKING, householdId: HH, type: 'CHECKING', isActive: true },
    { id: 'acc-foreign', householdId: OTHER_HH, type: 'CHECKING', isActive: true },
  ];
});

describe('loadSpendingByMethod', () => {
  it('splits the month spending between credit cards and the other accounts, with the credit fraction', async () => {
    tx({ accountId: CARD, amount: -300 });
    tx({ accountId: CHECKING, amount: -100 });
    const { months, basis } = await load();
    expect(basis).toBe('own-share');
    expect(months).toEqual([{ month: '2026-11', credit: 300, other: 100, total: 400, creditShare: 0.75 }]);
  });

  it('leaves out the invoice payment, income and transfers: only spending counts, once', async () => {
    tx({ accountId: CARD, amount: -200 });
    tx({ accountId: CHECKING, amount: -200, attachmentUrl: `invoice_pay:${CARD}:2026-11` });
    tx({ accountId: CHECKING, amount: 3000, type: 'INCOME', categoryName: 'SALARY' });
    tx({ accountId: CHECKING, amount: -500, type: 'TRANSFER', categoryName: 'TRANSFER' });
    const [month] = (await load()).months;
    expect(month).toEqual({ month: '2026-11', credit: 200, other: 0, total: 200, creditShare: 1 });
  });

  it('counts the own share: what another person owes on a purchase is not the user habit', async () => {
    const shared = tx({ accountId: CARD, amount: -200 });
    store.shares.push({ householdId: HH, transactionId: shared, direction: 'THEY_OWE_ME', amount: 150 });
    store.shares.push({ householdId: HH, transactionId: shared, direction: 'I_OWE_THEM', amount: 999 });
    tx({ accountId: CHECKING, amount: -50 });
    const [month] = (await load()).months;
    expect(month).toMatchObject({ credit: 50, other: 50, total: 100, creditShare: 0.5 });
  });

  it('follows the planning month of the budget: a purchase filed under November counts in November', async () => {
    tx({ accountId: CARD, amount: -80, date: '2026-10-30', competenceMonth: '2026-11' });
    tx({ accountId: CARD, amount: -999, date: '2026-10-29' });
    const months = (await load(2)).months;
    expect(months.map((m) => [m.month, m.credit])).toEqual([['2026-10', 999], ['2026-11', 80]]);
  });

  it('a closed card is still credit, and an expense with no account is not', async () => {
    tx({ accountId: OLD_CARD, amount: -40 });
    tx({ accountId: null, amount: -60 });
    const [month] = (await load()).months;
    expect(month).toMatchObject({ credit: 40, other: 60 });
  });

  it('a month without spending has a null fraction, never a division by zero', async () => {
    expect((await load()).months).toEqual([{ month: '2026-11', credit: 0, other: 0, total: 0, creditShare: null }]);
  });

  it('never counts another household', async () => {
    tx({ householdId: OTHER_HH, accountId: 'acc-foreign', amount: -700 });
    tx({ householdId: OTHER_HH, accountId: CARD, amount: -700 });
    expect((await load()).months[0]).toMatchObject({ total: 0 });
  });

  it('gives the last N months up to `to` (default: the month of today), oldest first, and the totals of the period', async () => {
    tx({ accountId: CARD, amount: -100, date: '2026-09-10' });
    tx({ accountId: CHECKING, amount: -300, date: '2026-10-10' });
    tx({ accountId: CARD, amount: -100, date: '2026-11-10' });
    const result = await load(3);
    expect(result.months.map((m) => m.month)).toEqual(['2026-09', '2026-10', '2026-11']);
    expect(result.totals).toEqual({ credit: 200, other: 300, total: 500, creditShare: 0.4 });
    expect((await load(2, '2026-10')).months.map((m) => m.month)).toEqual(['2026-09', '2026-10']);
  });

  it('adds in whole cents and rounds the fraction to four decimals', async () => {
    tx({ accountId: CARD, amount: -0.1 });
    tx({ accountId: CARD, amount: -0.2 });
    tx({ accountId: CHECKING, amount: -0.6 });
    const [month] = (await load()).months;
    expect(month).toEqual({ month: '2026-11', credit: 0.3, other: 0.6, total: 0.9, creditShare: 0.3333 });
  });
});
