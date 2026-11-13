import { beforeEach, describe, expect, it, vi } from 'vitest';
import { matchesWhere, type Row } from '../../shared/__fixtures__/where-eval.js';

// Month close: what stops a month from being "conferred". Invented data only. The fake database runs the real `where`
// of each query; the invoice and the review queue are the existing functions (tested on their own), here stubbed.
const HH = '11111111-1111-4111-8111-111111111111';
const OTHER_HH = '99999999-9999-4999-8999-999999999999';
const CHECKING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SAVINGS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CARD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const store = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
  transactions: [] as Array<Record<string, unknown>>,
  captures: [] as Array<Record<string, unknown>>,
  invoices: {} as Record<string, { state: 'open' | 'closed' | 'paid'; statementTotal: number }>,
  queue: {} as Record<string, number>,
  closings: [] as Array<Record<string, unknown>>,
  upserts: [] as Array<Record<string, unknown>>,
}));
const dec = (n: number) => ({ toNumber: () => n, valueOf: () => n });

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    account: { findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => store.accounts.filter((a) => matchesWhere(a as Row, args.where)).map((a) => ({ ...a, availableBalance: dec(a.availableBalance as number), allocatedBalance: dec(a.allocatedBalance as number) }))) },
    transaction: {
      findMany: vi.fn(async (args: { where?: Record<string, unknown> }) =>
        store.transactions.filter((r) => matchesWhere(r as Row, args.where)).map((r) => ({ ...r, amount: dec(r.amount as number), date: new Date(`${r.date}T00:00:00.000Z`), updatedAt: new Date((r.updatedAt as string | undefined) ?? '2026-01-01T00:00:00.000Z') }))),
    },
    monthClosing: {
      findMany: vi.fn(async (args: { where?: Record<string, unknown> }) =>
        store.closings.filter((c) => matchesWhere(c as Row, args.where)).map((c) => ({ ...c, informedBalance: dec(c.informedBalance as number), systemBalance: dec(c.systemBalance as number), difference: dec(c.difference as number), closedAt: new Date(c.closedAt as string) }))),
      upsert: vi.fn(async (args: Record<string, unknown>) => {
        store.upserts.push(args);
        return {};
      }),
    },
    capturedNotification: { count: vi.fn(async (args: { where?: Record<string, unknown> }) => store.captures.filter((c) => matchesWhere(c as Row, args.where)).length) },
  },
}));
vi.mock('../transactions/transactions.service.js', () => ({
  utcToday: () => new Date(Date.UTC(2026, 10, 12)),
  calculateCreditCardInvoice: vi.fn(async (accountId: string) => ({ data: { ...store.invoices[accountId] } })),
}));
vi.mock('../transactions/card-ofx-review.service.js', () => ({
  listReviewQueue: vi.fn(async (p: { account: { id: string } }) => ({ totals: { count: store.queue[p.account.id] ?? 0, net: 0 } })),
}));

const { loadMonthClose, saveMonthClosing } = await import('./month-close.js');
const { prisma } = await import('../../shared/db/prisma.js');
const { calculateCreditCardInvoice } = await import('../transactions/transactions.service.js');
const { listReviewQueue } = await import('../transactions/card-ofx-review.service.js');

let seq = 0;
function tx(over: Record<string, unknown> = {}) {
  seq += 1;
  store.transactions.push({ id: `t-${seq}`, householdId: HH, type: 'EXPENSE', accountId: CHECKING, categoryName: 'GROCERIES', amount: 100, date: '2026-10-05', paid: true, competenceMonth: null, updatedAt: '2026-01-01T00:00:00.000Z', ...over });
}
const account = (over: Record<string, unknown> = {}) =>
  store.accounts.push({ id: CHECKING, householdId: HH, name: 'Conta', type: 'CHECKING', isActive: true, availableBalance: 1000, allocatedBalance: 0, dueDay: null, closingDay: null, ...over });
const capture = (over: Record<string, unknown> = {}) =>
  store.captures.push({ householdId: HH, status: 'PENDING', postedAt: '2026-10-20', ...over });

const load = (month = '2026-10') => loadMonthClose({ householdId: HH, month });
const codes = (blockers: Array<{ code: string }>) => blockers.map((b) => b.code);

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  store.accounts.length = 0;
  store.transactions.length = 0;
  store.captures.length = 0;
  store.invoices = {};
  store.queue = {};
  store.closings.length = 0;
  store.upserts.length = 0;
});

describe('system balance on the last day of the month', () => {
  it('walks the current balance back over the paid income and expenses dated after the month', async () => {
    account({ availableBalance: 1000 });
    tx({ type: 'INCOME', amount: 300, date: '2026-11-02' }); // after: undone
    tx({ type: 'EXPENSE', amount: 100, date: '2026-11-05' }); // after: undone
    tx({ type: 'EXPENSE', amount: 50, date: '2026-11-03', paid: false }); // never moved the balance
    tx({ type: 'EXPENSE', amount: 70, date: '2026-10-31' }); // inside the month: stays
    tx({ type: 'EXPENSE', amount: 10, date: '2026-11-04', accountId: SAVINGS }); // another account
    const data = await load();
    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0]).toMatchObject({ accountId: CHECKING, name: 'Conta', systemBalance: 800 });
  });

  it('counts the allocated part and undoes transfers made after the month, in and out', async () => {
    account({ availableBalance: 700, allocatedBalance: 300 }); // cash today: 1000
    account({ id: SAVINGS, type: 'SAVINGS', name: 'Reserva', availableBalance: 500 });
    tx({ type: 'TRANSFER', accountId: null, fromAccountId: CHECKING, toAccountId: SAVINGS, amount: 200, categoryName: 'TRANSFER', date: '2026-11-05' }); // checking lost 200 after
    tx({ type: 'TRANSFER', accountId: null, fromAccountId: SAVINGS, toAccountId: CHECKING, amount: 50, categoryName: 'TRANSFER', date: '2026-11-06' }); // and got 50 back
    tx({ type: 'TRANSFER', accountId: null, fromAccountId: CHECKING, toAccountId: SAVINGS, amount: 999, categoryName: 'TRANSFER', date: '2026-10-30' }); // inside the month
    tx({ type: 'TRANSFER', accountId: null, fromAccountId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', toAccountId: 'ffffffff-ffff-4fff-8fff-fffffffffff0', amount: 5, categoryName: 'TRANSFER', date: '2026-11-07', householdId: OTHER_HH });
    const data = await load();
    const by = (id: string) => data.accounts.find((a) => a.accountId === id)!.systemBalance;
    expect(by(CHECKING)).toBe(1150); // 1000 + 200 - 50
    expect(by(SAVINGS)).toBe(350); // 500 - 200 + 50
  });

  it('is the current balance when nothing moved after the month', async () => {
    account({ availableBalance: 1234.56 });
    tx({ amount: 20, date: '2026-10-31' });
    expect((await load()).accounts[0]!.systemBalance).toBe(1234.56);
  });

  it('leaves out cards, other households and inactive accounts, and counts savings and cash accounts', async () => {
    account();
    account({ id: SAVINGS, type: 'SAVINGS', name: 'Reserva', availableBalance: 50 });
    account({ id: CARD, type: 'CREDIT', name: 'Cartao' });
    account({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', householdId: OTHER_HH });
    account({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', isActive: false });
    const data = await load();
    expect(data.accounts.map((a) => a.accountId).sort()).toEqual([CHECKING, SAVINGS].sort());
  });
});

describe('what blocks a cash account', () => {
  it('flags unpaid entries of the month (by the reference month, like the rest of the planning)', async () => {
    account();
    tx({ paid: false, amount: 40, date: '2026-10-10' });
    tx({ paid: false, amount: 60, date: '2026-09-30', competenceMonth: '2026-10' }); // reference month is October
    tx({ paid: false, amount: 999, date: '2026-10-31', competenceMonth: '2026-11' }); // reference month is November
    tx({ paid: false, amount: 5, date: '2026-11-02' });
    tx({ paid: true, amount: 7, date: '2026-10-10' });
    const a = (await load()).accounts[0]!;
    expect(a.ok).toBe(false);
    expect(a.blockers).toEqual([{ code: 'pending_entries', count: 2, amount: 100 }]);
  });

  it('is ok with nothing pending', async () => {
    account();
    tx();
    const a = (await load()).accounts[0]!;
    expect(a).toMatchObject({ ok: true, blockers: [] });
  });
});

describe('what blocks a card', () => {
  const card = () => account({ id: CARD, type: 'CREDIT', name: 'Cartao', dueDay: 9 });

  it('asks the existing invoice and review queue for the month, with the account row', async () => {
    card();
    store.invoices[CARD] = { state: 'closed', statementTotal: 850.4 };
    const data = await load();
    expect(calculateCreditCardInvoice).toHaveBeenCalledWith(CARD, '2026-10', HH, { limit: 1 }, { today: new Date(Date.UTC(2026, 10, 12)) });
    expect(listReviewQueue).toHaveBeenCalledWith(expect.objectContaining({ monthKey: '2026-10', limit: 1, account: expect.objectContaining({ id: CARD, householdId: HH, dueDay: 9 }) }));
    expect(data.cards[0]).toMatchObject({ accountId: CARD, name: 'Cartao', invoiceTotal: 850.4, state: 'closed', reviewQueueCount: 0, ok: true, blockers: [] });
  });

  it('flags an invoice that has not closed yet', async () => {
    card();
    store.invoices[CARD] = { state: 'open', statementTotal: 10 };
    const c = (await load('2026-11')).cards[0]!;
    expect(c.ok).toBe(false);
    expect(codes(c.blockers)).toEqual(['invoice_open']);
  });

  it('flags the rows still without a bank line', async () => {
    card();
    store.invoices[CARD] = { state: 'paid', statementTotal: 10 };
    store.queue[CARD] = 3;
    const c = (await load()).cards[0]!;
    expect(c.blockers).toEqual([{ code: 'review_queue', count: 3 }]);
    expect(c.reviewQueueCount).toBe(3);
  });

  it('does not count the unpaid purchases of a card as pending entries (they are paid with the invoice)', async () => {
    card();
    store.invoices[CARD] = { state: 'closed', statementTotal: 10 };
    tx({ accountId: CARD, paid: false, amount: 10 });
    const data = await load();
    expect(data.cards[0]!.ok).toBe(true);
    expect(data.general.blockers).toEqual([]);
  });
});

describe('what blocks the household as a whole', () => {
  it('flags rows without a category and captures waiting for a decision', async () => {
    account();
    tx({ categoryName: null }); // EXPENSE with no category
    tx({ categoryName: null, type: 'TRANSFER', accountId: null, fromAccountId: CHECKING }); // transfers have none by design
    tx({ categoryName: null, date: '2026-11-03' }); // another month
    tx({ categoryName: null, householdId: OTHER_HH });
    capture();
    capture({ postedAt: '2026-09-02' }); // still waiting from before the month: counts
    capture({ postedAt: '2026-11-02' }); // after the month: not yet this month's
    capture({ status: 'CONFIRMED' });
    capture({ householdId: OTHER_HH });
    const g = (await load()).general;
    expect(g.ok).toBe(false);
    expect(g.blockers).toEqual([
      { code: 'uncategorized', count: 1 },
      { code: 'pending_captures', count: 2 },
    ]);
  });

  it('puts unpaid entries of no cash account (savings aside, investments, no account) in the general block', async () => {
    account();
    account({ id: SAVINGS, type: 'INVESTMENT', name: 'Corretora' });
    tx({ accountId: SAVINGS, paid: false, amount: 30 });
    tx({ accountId: null, paid: false, amount: 12 });
    const data = await load();
    // INVESTMENT is not a cash account here, so its pending row goes to the general block with the account-less one
    expect(data.general.blockers).toEqual([{ code: 'pending_entries', count: 2, amount: 42 }]);
  });

  it('is ok overall only when every block is', async () => {
    account();
    tx();
    expect((await load()).ok).toBe(true);
    tx({ paid: false });
    expect((await load()).ok).toBe(false);
  });
});

describe('the month', () => {
  it('is taken as it comes and echoed back', async () => {
    account();
    expect((await load('2026-02')).month).toBe('2026-02');
  });
});

const USER = 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu';
const closing = (over: Record<string, unknown> = {}) =>
  store.closings.push({ householdId: HH, month: '2026-10', accountId: CHECKING, informedBalance: 1000, systemBalance: 1000, difference: 0, closedByUserId: USER, closedAt: '2026-11-10T12:00:00.000Z', ...over });
const save = (over: Record<string, unknown> = {}) => saveMonthClosing({ householdId: HH, month: '2026-10', accountId: CHECKING, informedBalance: 1000, userId: USER, ...over });

describe('saving a conference', () => {
  it('records the informed balance, what the system had and the difference, keyed by household, month and account', async () => {
    account({ availableBalance: 800 });
    await save({ informedBalance: 800.1 });
    expect(store.upserts).toHaveLength(1);
    const args = store.upserts[0] as { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> };
    expect(args.where).toEqual({ householdId_month_accountId: { householdId: HH, month: '2026-10', accountId: CHECKING } });
    for (const part of [args.create, args.update]) {
      expect(part).toMatchObject({ informedBalance: 800.1, systemBalance: 800, difference: 0.1, closedByUserId: USER });
      expect(part.closedAt).toBeInstanceOf(Date);
    }
    expect(args.create).toMatchObject({ householdId: HH, month: '2026-10', accountId: CHECKING });
  });

  it('computes the system side on the server (a card compares with its invoice total)', async () => {
    account({ id: CARD, type: 'CREDIT', name: 'Cartao' });
    store.invoices[CARD] = { state: 'closed', statementTotal: 850.4 };
    await save({ accountId: CARD, informedBalance: 850 });
    expect(store.upserts[0]).toMatchObject({ create: { systemBalance: 850.4, difference: -0.4 } });
  });

  it('refuses an account that is not part of the household close, writing nothing', async () => {
    account();
    account({ id: SAVINGS, householdId: OTHER_HH, type: 'SAVINGS' });
    await expect(save({ accountId: SAVINGS })).rejects.toThrow(/not found/i);
    await expect(save({ accountId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' })).rejects.toThrow(/not found/i);
    expect(store.upserts).toHaveLength(0);
  });

  it('records a conference even while something still blocks the month (it is a record, not a lock)', async () => {
    account();
    tx({ paid: false });
    await save();
    expect(store.upserts).toHaveLength(1);
    expect(prisma.transaction.findMany).toHaveBeenCalled();
  });
});

describe('the conference read back', () => {
  it('comes with each account and card, and is null where nothing was conferred', async () => {
    account();
    account({ id: SAVINGS, type: 'SAVINGS', name: 'Reserva' });
    account({ id: CARD, type: 'CREDIT', name: 'Cartao' });
    store.invoices[CARD] = { state: 'closed', statementTotal: 50 };
    closing({ informedBalance: 1010, difference: 10 });
    closing({ accountId: CARD, informedBalance: 50, systemBalance: 50 });
    closing({ month: '2026-09', accountId: SAVINGS }); // another month
    closing({ householdId: OTHER_HH, accountId: SAVINGS }); // another household
    const data = await load();
    expect(data.accounts.find((a) => a.accountId === CHECKING)!.closing).toEqual({ informedBalance: 1010, systemBalance: 1000, difference: 10, closedAt: '2026-11-10T12:00:00.000Z', closedByUserId: USER, changedSince: false });
    expect(data.accounts.find((a) => a.accountId === SAVINGS)!.closing).toBeNull();
    expect(data.cards[0]!.closing).toMatchObject({ informedBalance: 50, changedSince: false });
  });

  it('warns when the balance is no longer what it was at the conference', async () => {
    account({ availableBalance: 1000 });
    closing({ systemBalance: 1100 });
    expect((await load()).accounts[0]!.closing!.changedSince).toBe(true);
  });

  it('warns when an entry of the month was touched after the conference, and only then', async () => {
    account();
    closing();
    tx({ date: '2026-10-05', updatedAt: '2026-11-09T10:00:00.000Z' }); // before the conference
    expect((await load()).accounts[0]!.closing!.changedSince).toBe(false);
    tx({ date: '2026-10-06', updatedAt: '2026-11-11T10:00:00.000Z' }); // after
    expect((await load()).accounts[0]!.closing!.changedSince).toBe(true);
  });

  it('ignores a later change to another month or another account', async () => {
    account();
    account({ id: SAVINGS, type: 'SAVINGS', name: 'Reserva' });
    closing();
    tx({ date: '2026-09-06', updatedAt: '2026-11-11T10:00:00.000Z' });
    tx({ date: '2026-10-06', updatedAt: '2026-11-11T10:00:00.000Z', accountId: SAVINGS });
    expect((await load()).accounts.find((a) => a.accountId === CHECKING)!.closing!.changedSince).toBe(false);
  });

  it('warns when the invoice total changed after a card was conferred', async () => {
    account({ id: CARD, type: 'CREDIT', name: 'Cartao' });
    store.invoices[CARD] = { state: 'closed', statementTotal: 60 };
    closing({ accountId: CARD, informedBalance: 50, systemBalance: 50 });
    expect((await load()).cards[0]!.closing!.changedSince).toBe(true);
  });
});
