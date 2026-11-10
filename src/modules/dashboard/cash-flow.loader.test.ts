import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  account: { findMany: vi.fn() },
  transaction: { findMany: vi.fn() },
  recurringTransaction: { findMany: vi.fn() },
  category: { findMany: vi.fn() },
}));
const invoice = vi.hoisted(() => ({ calculate: vi.fn() }));

vi.mock('../../shared/db/prisma.js', () => ({ prisma: db }));
vi.mock('../transactions/transactions.service.js', () => ({
  calculateCreditCardInvoice: invoice.calculate,
  utcToday: () => new Date(Date.UTC(2026, 10, 10)),
}));

import { loadCashFlow, invoiceEventOf, type InvoiceSnapshot } from './cash-flow.loader.js';

// Invented data only. Today is 2026-11-10.
const TODAY = new Date(Date.UTC(2026, 10, 10));
const utc = (day: string) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))));
const dec = (n: number) => ({ toNumber: () => n });

const CHK = '00000000-0000-4000-8000-000000000001';
const SAV = '00000000-0000-4000-8000-000000000002';
const CARD_A = '00000000-0000-4000-8000-0000000000a1';
const CARD_B = '00000000-0000-4000-8000-0000000000b1';
const HH = '00000000-0000-4000-8000-0000000000f0';

const account = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  householdId: HH,
  name: id === CHK ? 'Checking' : id === SAV ? 'Savings' : `Card ${id.slice(-2)}`,
  type: 'CHECKING',
  balance: dec(1000),
  currency: 'BRL',
  isActive: true,
  linkedAccountId: null,
  ...over,
});

const recurrence = (over: Record<string, unknown> = {}) => ({
  id: 'rec-1',
  householdId: HH,
  accountId: CHK,
  categoryName: 'SALARY',
  amount: dec(3000),
  description: 'Salary',
  frequency: 'MONTHLY',
  startDate: utc('2026-01-05'),
  endDate: null,
  nextRunAt: utc('2026-11-20'),
  isActive: true,
  followLastAmount: false,
  competenceOffsetMonths: null,
  forecastStrategy: 'LAST',
  forecastWindow: null,
  dailyRate: null,
  safetyBusinessDays: 0,
  nonWorkingDays: [],
  optionalHolidays: [],
  ...over,
});

const pending = (over: Record<string, unknown> = {}) => ({
  id: 'tx-1',
  accountId: CHK,
  type: 'EXPENSE',
  amount: dec(100),
  description: 'Rent',
  categoryName: 'HOUSING',
  date: utc('2026-11-15'),
  attachmentUrl: null,
  ...over,
});

const snap = (over: Partial<InvoiceSnapshot> = {}): InvoiceSnapshot => ({
  statementTotal: 0,
  outstandingFromPrevious: 0,
  currentPayments: 0,
  state: 'closed',
  dueDate: '2026-11-18',
  forecast: { applicable: false, total: 0 },
  ...over,
});

interface Setup {
  accounts?: unknown[];
  pending?: unknown[];
  recurrences?: unknown[];
  existing?: unknown[];
  payments?: unknown[];
  invoices?: Record<string, InvoiceSnapshot>;
}

function setup(s: Setup = {}) {
  db.account.findMany.mockResolvedValue(s.accounts ?? [account(CHK)]);
  db.recurringTransaction.findMany.mockResolvedValue(s.recurrences ?? []);
  db.category.findMany.mockResolvedValue([]);
  db.transaction.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    if (args.where.paid === false) return s.pending ?? [];
    if (args.where.recurringTransactionId) return s.existing ?? [];
    if (args.where.OR) return s.payments ?? [];
    return [];
  });
  invoice.calculate.mockImplementation(async (cardId: string, month: string) => ({
    data: (s.invoices ?? {})[`${cardId}:${month}`] ?? snap({ state: 'paid' }),
  }));
}

const run = (over: { accountId?: string; days?: number } = {}) => loadCashFlow({ householdId: HH, days: over.days ?? 90, today: TODAY, accountId: over.accountId });
const flat = (out: Awaited<ReturnType<typeof run>>) => out.days.flatMap((d) => d.events);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('invoiceEventOf', () => {
  it('a paid invoice generates no event', () => {
    expect(invoiceEventOf(snap({ state: 'paid', statementTotal: 500, currentPayments: 0 }), true)).toBeNull();
  });

  it('an invoice with credit (refunds above purchases) generates nothing', () => {
    expect(invoiceEventOf(snap({ statementTotal: -120.5 }), true)).toBeNull();
    expect(invoiceEventOf(snap({ state: 'open', statementTotal: -20, forecast: { applicable: true, total: 5 } }), false)).toBeNull();
  });

  it('closed: what is still owed, confirmed; partial payments come off', () => {
    expect(invoiceEventOf(snap({ statementTotal: 800, currentPayments: 300 }), false)).toEqual({ amountCents: 50000, certainty: 'confirmed', dueDate: '2026-11-18' });
  });

  it('open: posted plus the forecast, estimated', () => {
    expect(invoiceEventOf(snap({ state: 'open', statementTotal: 400, forecast: { applicable: true, total: 150.1 } }), false)).toEqual({
      amountCents: 55010,
      certainty: 'estimated',
      dueDate: '2026-11-18',
    });
  });

  it('only the first invoice of the walk carries the debt of earlier ones', () => {
    const data = snap({ statementTotal: 800, outstandingFromPrevious: 200 });
    expect(invoiceEventOf(data, true)?.amountCents).toBe(100000);
    expect(invoiceEventOf(data, false)?.amountCents).toBe(80000);
  });

  it('a one-cent residue is not a debt', () => {
    expect(invoiceEventOf(snap({ statementTotal: 0.01 }), true)).toBeNull();
    expect(invoiceEventOf(snap({ statementTotal: 0.02 }), true)?.amountCents).toBe(2);
  });
});

describe('loadCashFlow: accounts', () => {
  it('the set sums the balances of the active cash accounts only (cards and investments stay out)', async () => {
    setup({ accounts: [account(CHK), account(SAV, { type: 'SAVINGS', balance: dec(250.5) }), account('inv', { type: 'INVESTMENT', balance: dec(9999) }), account(CARD_A, { type: 'CREDIT', balance: dec(-300) })] });
    const out = await run();
    expect(out.startingBalance).toBe(1250.5);
    expect(out.currency).toBe('BRL');
    expect(db.account.findMany).toHaveBeenCalledWith({ where: { householdId: HH, isActive: true } });
  });

  it('household with no events: only the starting balance and an empty summary', async () => {
    setup();
    const out = await run();
    expect(out.days).toEqual([]);
    expect(out.startingBalance).toBe(1000);
    expect(out.summary).toMatchObject({ eventCount: 0, firstNegativeDate: null, endingBalance: 1000 });
  });

  it('refuses a set with different currencies and asks for one account', async () => {
    setup({ accounts: [account(CHK), account(SAV, { currency: 'USD' })] });
    await expect(run()).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('different currencies') });
    // a single account in the other currency is fine
    const out = await run({ accountId: SAV });
    expect(out.currency).toBe('USD');
  });

  it('an account that is not in the household (or inactive) is 404; a card is 400', async () => {
    setup({ accounts: [account(CHK), account(CARD_A, { type: 'CREDIT' })] });
    await expect(run({ accountId: SAV })).rejects.toMatchObject({ statusCode: 404 });
    await expect(run({ accountId: CARD_A })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('one account: only its balance and its events', async () => {
    setup({
      accounts: [account(CHK), account(SAV, { type: 'SAVINGS', balance: dec(500) })],
      pending: [pending()],
    });
    const out = await run({ accountId: SAV });
    expect(out.startingBalance).toBe(500);
    const where = db.transaction.findMany.mock.calls.find(([a]) => a.where.paid === false)![0].where;
    expect(where.accountId).toEqual({ in: [SAV] });
  });
});

describe('loadCashFlow: pending entries', () => {
  it('income adds and expense subtracts; a pending in the past enters today as overdue', async () => {
    setup({
      pending: [
        pending({ id: 'a', date: utc('2026-11-15'), amount: dec(100) }),
        pending({ id: 'b', date: utc('2026-11-02'), amount: dec(40.5), type: 'INCOME', description: 'Refund' }),
      ],
    });
    const out = await run();
    expect(out.days.map((d) => d.date)).toEqual(['2026-11-10', '2026-11-15']);
    expect(out.days[0]!.events[0]).toMatchObject({ source: 'pending', amount: 40.5, overdue: true, originalDate: '2026-11-02', sourceId: 'b' });
    expect(out.summary.endingBalance).toBe(940.5);
  });

  it('a pending invoice payment dated after today is not counted twice (the invoice event carries it)', async () => {
    setup({
      pending: [pending({ id: 'p', attachmentUrl: `invoice_pay:${CARD_A}:2026-9`, date: utc('2026-11-18'), amount: dec(300) })],
    });
    expect((await run()).days).toEqual([]);
  });
});

describe('loadCashFlow: recurrences', () => {
  it('walks the dates up to the end of the period; income positive, expense negative; end date stops it', async () => {
    setup({
      recurrences: [
        recurrence(),
        recurrence({ id: 'rec-2', categoryName: 'HOUSING', amount: dec(1200), description: 'Rent', nextRunAt: utc('2026-11-05'), startDate: utc('2026-01-05'), endDate: utc('2026-12-31') }),
      ],
    });
    const out = await run({ days: 60 });
    const salaries = flat(out).filter((e) => e.sourceId === 'rec-1');
    expect(salaries.map((e) => [e.date, e.amount])).toEqual([['2026-11-20', 3000], ['2026-12-20', 3000]]);
    const rent = flat(out).filter((e) => e.sourceId === 'rec-2');
    // Nov 5 is stale (counts today, overdue), Dec 5 is future, Jan 5 is past the end date
    expect(rent.map((e) => [e.date, e.amount, e.overdue])).toEqual([['2026-11-10', -1200, true], ['2026-12-05', -1200, false]]);
  });

  it('a month that already has its occurrence (generated or adopted: any transaction linked to the recurrence) does not count again', async () => {
    setup({
      recurrences: [recurrence({ nextRunAt: utc('2026-11-20') })],
      existing: [{ recurringTransactionId: 'rec-1', date: utc('2026-11-18') }], // adopted import, other day of the month
    });
    const out = await run({ days: 60 });
    expect(flat(out).map((e) => e.date)).toEqual(['2026-12-20']);
  });

  it('a recurrence stale for months counts every late occurrence today, flagged, and not spread', async () => {
    setup({ recurrences: [recurrence({ categoryName: 'HOUSING', amount: dec(500), nextRunAt: utc('2026-08-05'), startDate: utc('2026-01-05') })] });
    const out = await run({ days: 30 });
    const events = flat(out);
    expect(events.map((e) => [e.date, e.overdue, e.originalDate])).toEqual([
      ['2026-11-10', true, '2026-08-05'],
      ['2026-11-10', true, '2026-09-05'],
      ['2026-11-10', true, '2026-10-05'],
      ['2026-11-10', true, '2026-11-05'],
      ['2026-12-05', false, null],
    ]);
    expect(out.summary.overdueCount).toBe(4);
  });

  it('stale months the job already generated are not counted again', async () => {
    setup({
      recurrences: [recurrence({ categoryName: 'HOUSING', amount: dec(500), nextRunAt: utc('2026-08-05'), startDate: utc('2026-01-05') })],
      existing: [{ recurringTransactionId: 'rec-1', date: utc('2026-08-05') }, { recurringTransactionId: 'rec-1', date: utc('2026-09-05') }],
    });
    const events = flat(await run({ days: 30 }));
    expect(events.map((e) => e.originalDate ?? e.date)).toEqual(['2026-10-05', '2026-11-05', '2026-12-05']);
  });

  it('income with a shifted reference month enters on the day the money arrives, not on the reference month', async () => {
    setup({
      recurrences: [recurrence({ id: 'voucher', categoryName: 'SALARY', description: 'Voucher', amount: dec(800), startDate: utc('2026-01-25'), nextRunAt: utc('2026-11-25'), competenceOffsetMonths: 1 })],
    });
    const events = flat(await run({ days: 50 }));
    expect(events.map((e) => [e.date, e.amount])).toEqual([['2026-11-25', 800], ['2026-12-25', 800]]);
  });

  it('a short month clamps to its last day and the next one returns to the anchor day', async () => {
    setup({
      recurrences: [recurrence({ categoryName: 'HOUSING', amount: dec(100), startDate: utc('2026-01-31'), nextRunAt: utc('2026-12-31') })],
    });
    const events = flat(await run({ days: 90, }));
    expect(events.map((e) => e.date)).toEqual(['2026-12-31', '2027-01-31']);
    setup({
      recurrences: [recurrence({ categoryName: 'HOUSING', amount: dec(100), startDate: utc('2026-01-31'), nextRunAt: utc('2027-01-31') })],
    });
    expect(flat(await loadCashFlow({ householdId: HH, days: 40, today: utc('2027-01-31') })).map((e) => e.date)).toEqual(['2027-01-31', '2027-02-28']);
  });

  it('certainty: following the last value is estimated; fixed is expected', async () => {
    setup({
      recurrences: [
        recurrence({ id: 'last', categoryName: 'HOUSING', followLastAmount: true, nextRunAt: utc('2026-11-12') }),
        recurrence({ id: 'fixed', categoryName: 'HOUSING', forecastStrategy: 'FIXED', followLastAmount: true, nextRunAt: utc('2026-11-13') }),
        recurrence({ id: 'plain', categoryName: 'HOUSING', nextRunAt: utc('2026-11-14') }),
      ],
    });
    const out = await run({ days: 10 });
    expect(Object.fromEntries(flat(out).map((e) => [e.sourceId, e.certainty]))).toEqual({ last: 'estimated', fixed: 'expected', plain: 'expected' });
    expect(out.summary.estimatedCount).toBe(1);
  });

  it('a weekly recurrence is dated by its own steps', async () => {
    setup({ recurrences: [recurrence({ categoryName: 'HOUSING', frequency: 'WEEKLY', amount: dec(10), startDate: utc('2026-11-12'), nextRunAt: utc('2026-11-12') })] });
    expect(flat(await run({ days: 20 })).map((e) => e.date)).toEqual(['2026-11-12', '2026-11-19', '2026-11-26']);
  });
});

describe('loadCashFlow: invoices', () => {
  const cards = [account(CHK), account(CARD_A, { type: 'CREDIT', linkedAccountId: CHK, name: 'Card A' })];

  it('a closed unpaid invoice leaves the linked account on its due date; an open one is estimated', async () => {
    setup({
      accounts: cards,
      invoices: {
        [`${CARD_A}:2026-11`]: snap({ statementTotal: 1234.56, dueDate: '2026-11-18' }),
        [`${CARD_A}:2026-12`]: snap({ state: 'open', statementTotal: 300, dueDate: '2026-12-18', forecast: { applicable: true, total: 50 } }),
      },
    });
    const out = await run({ days: 60 });
    const events = flat(out);
    expect(events.map((e) => [e.date, e.amount, e.certainty, e.invoiceMonth, e.accountId, e.sourceId])).toEqual([
      ['2026-11-18', -1234.56, 'confirmed', '2026-11', CHK, CARD_A],
      ['2026-12-18', -350, 'estimated', '2026-12', CHK, CARD_A],
    ]);
  });

  it('a paid invoice and an invoice with credit generate no event', async () => {
    setup({
      accounts: cards,
      invoices: { [`${CARD_A}:2026-11`]: snap({ state: 'paid', statementTotal: 500, currentPayments: 500 }), [`${CARD_A}:2026-12`]: snap({ state: 'open', statementTotal: -80 }) },
    });
    expect(flat(await run({ days: 60 }))).toEqual([]);
  });

  it('an invoice due after the period does not enter; one already due enters today as overdue', async () => {
    setup({
      accounts: cards,
      invoices: {
        [`${CARD_A}:2026-10`]: snap({ statementTotal: 200, dueDate: '2026-11-05' }),
        [`${CARD_A}:2026-12`]: snap({ state: 'open', statementTotal: 900, dueDate: '2026-12-18' }),
      },
    });
    const events = flat(await run({ days: 30 }));
    expect(events.map((e) => [e.date, e.amount, e.overdue])).toEqual([['2026-11-10', -200, true]]);
  });

  it('with no linked account the payer is the account of the last invoice payment', async () => {
    setup({
      accounts: [account(CHK), account(SAV, { type: 'SAVINGS' }), account(CARD_A, { type: 'CREDIT' })],
      payments: [{ accountId: SAV, attachmentUrl: `invoice_pay:${CARD_A}:2026-9` }, { accountId: CHK, attachmentUrl: `invoice_pay:${CARD_A}:2026-8` }],
      invoices: { [`${CARD_A}:2026-11`]: snap({ statementTotal: 700 }) },
    });
    const events = flat(await run());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ accountId: SAV, amount: -700 });
  });

  it('a card with neither a linked account nor a payment goes to the list apart and not into the balance', async () => {
    setup({ accounts: [account(CHK), account(CARD_A, { type: 'CREDIT', name: 'Card A' })], invoices: { [`${CARD_A}:2026-11`]: snap({ statementTotal: 700 }) } });
    const out = await run();
    expect(out.days).toEqual([]);
    expect(out.summary.endingBalance).toBe(1000);
    expect(out.unassignedInvoices).toEqual([{ accountId: CARD_A, accountName: 'Card A', month: '2026-11', dueDate: '2026-11-18', amount: 700, reason: 'no_payer_account' }]);
  });

  it('a card without a due day is listed apart (no date to place it on)', async () => {
    setup({ accounts: cards, invoices: { [`${CARD_A}:2026-11`]: snap({ statementTotal: 700, dueDate: null }) } });
    const out = await run();
    expect(out.days).toEqual([]);
    expect(out.unassignedInvoices[0]).toMatchObject({ reason: 'no_due_date', amount: 700 });
  });

  it('two cards paid by the same account: two events, even on the same day', async () => {
    setup({
      accounts: [account(CHK), account(CARD_A, { type: 'CREDIT', linkedAccountId: CHK }), account(CARD_B, { type: 'CREDIT', linkedAccountId: CHK })],
      invoices: { [`${CARD_A}:2026-11`]: snap({ statementTotal: 300 }), [`${CARD_B}:2026-11`]: snap({ statementTotal: 450 }) },
    });
    const out = await run({ days: 30 });
    expect(out.days).toHaveLength(1);
    expect(out.days[0]!.events.map((e) => e.sourceId).sort()).toEqual([CARD_A, CARD_B].sort());
    expect(out.days[0]!.outflow).toBe(750);
  });

  it('in the set, an invoice paid by an account outside the projection is skipped without calculating it', async () => {
    setup({
      accounts: [account(CHK), account(SAV, { type: 'SAVINGS' }), account(CARD_A, { type: 'CREDIT', linkedAccountId: SAV })],
      invoices: { [`${CARD_A}:2026-11`]: snap({ statementTotal: 300 }) },
    });
    const out = await run({ accountId: CHK });
    expect(out.days).toEqual([]);
    expect(out.unassignedInvoices).toEqual([]);
    expect(invoice.calculate).not.toHaveBeenCalled();
  });

  it('calls the invoice calculation once per card and month of the period, never per day', async () => {
    setup({ accounts: cards });
    await run({ days: 180 });
    // 2026-10 .. 2027-05 = 8 months
    expect(invoice.calculate).toHaveBeenCalledTimes(8);
    expect(invoice.calculate.mock.calls[0]).toEqual([CARD_A, '2026-10', HH, { limit: 1 }, { today: TODAY }]);
  });

  it('an inactive linked account falls back to the last payment', async () => {
    setup({
      accounts: [account(CHK), account(CARD_A, { type: 'CREDIT', linkedAccountId: SAV })], // SAV is not in the active list
      payments: [{ accountId: CHK, attachmentUrl: `invoice_pay:${CARD_A}:2026-9` }],
      invoices: { [`${CARD_A}:2026-11`]: snap({ statementTotal: 120 }) },
    });
    expect(flat(await run())[0]).toMatchObject({ accountId: CHK, amount: -120 });
  });
});
