import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountType, CategoryName, TransactionType } from '../../shared/enums/index.js';

// Forecast of a card statement at closing: recurrences of THAT card that will still land in the window.
type Row = Record<string, any>;
const store = vi.hoisted(() => ({ tx: [] as Row[], rec: [] as Row[], cats: [] as Row[] }));

const inDate = (d: Date, c: any) =>
  !(c.gte && d.getTime() < c.gte.getTime()) && !(c.gt && d.getTime() <= c.gt.getTime()) &&
  !(c.lte && d.getTime() > c.lte.getTime()) && !(c.lt && d.getTime() >= c.lt.getTime());

function matches(row: Row, where: Record<string, any>): boolean {
  if (where.OR) return (where.OR as Row[]).some((w) => matches(row, w));
  for (const [key, cond] of Object.entries(where)) {
    const value = row[key];
    if (key === 'date') {
      if (!inDate(row.date, cond)) return false;
    } else if (cond !== null && typeof cond === 'object') {
      if ('in' in cond && !cond.in.includes(value)) return false;
      if ('equals' in cond && value !== cond.equals) return false;
      if ('startsWith' in cond && !(typeof value === 'string' && value.startsWith(cond.startsWith))) return false;
    } else if (value !== cond) return false;
  }
  return true;
}

const accounts = vi.hoisted(() => ({ byId: {} as Record<string, unknown> }));
const calls = vi.hoisted(() => ({ recFind: [] as unknown[] }));

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    account: { findFirst: async (a: { where: { id: string } }) => accounts.byId[a.where.id] ?? null },
    transaction: {
      findMany: async (a: { where: Row; take?: number }) => {
        const found = store.tx.filter((r) => matches(r, a.where));
        return a.take ? found.slice(0, a.take) : found;
      },
      count: async (a: { where: Row }) => store.tx.filter((r) => matches(r, a.where)).length,
    },
    recurringTransaction: {
      findMany: async (a: { where: Row }) => {
        calls.recFind.push(a);
        return store.rec.filter((r) => matches(r, a.where));
      },
    },
    category: { findMany: async (a: { where: Row }) => store.cats.filter((c) => a.where.id.in.includes(c.id)) },
  },
}));
vi.mock('../../shared/services/balance.service.js', () => ({
  recalculateCreditCardLimit: vi.fn(),
  applyTransfer: vi.fn(),
  applyAllocation: vi.fn(),
  applyDeallocation: vi.fn(),
  updateBalanceForNormalTransaction: vi.fn(),
}));

const { calculateCreditCardInvoice, creditCardInvoiceWindow } = await import('./transactions.service.js');
const { invoiceDates, invoiceState, projectRecurrence, buildForecast } = await import('./credit-card-invoice-forecast.js');

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const decimal = (value: number) => ({ toNumber: () => value });
const CARD = { id: 'card-1', householdId: 'house-1', type: AccountType.CREDIT, isActive: true, closingDay: 2, dueDay: 9, balance: decimal(0) };
const TODAY = day('2026-10-06');
let seq = 0;

const purchase = (date: string, amount: number, extra: Row = {}): Row => ({
  id: `p${++seq}`, accountId: CARD.id, householdId: CARD.householdId, date: day(date), amount: decimal(amount),
  categoryName: CategoryName.OTHER_EXPENSES, type: TransactionType.EXPENSE, attachmentUrl: null, recurringTransactionId: null, ...extra,
});
const recurrence = (id: string, over: Row = {}): Row => ({
  id, householdId: CARD.householdId, accountId: CARD.id, categoryName: CategoryName.OTHER_EXPENSES, amount: decimal(10),
  description: `rec ${id}`, frequency: 'MONTHLY', startDate: day('2026-01-08'), endDate: null, nextRunAt: day('2026-10-08'),
  isActive: true, followLastAmount: false, ...over,
});
const invoice = async (month: string, today: Date = TODAY) =>
  (await calculateCreditCardInvoice(CARD.id, month, CARD.householdId, { limit: 5 }, { today })).data as any;

beforeEach(() => {
  seq = 0;
  store.tx = [];
  store.rec = [];
  store.cats = [];
  calls.recFind = [];
  accounts.byId = { [CARD.id]: CARD };
});

describe('invoiceDates', () => {
  const dates = (m: number, closing: number | null, due: number | null) => invoiceDates(creditCardInvoiceWindow(2026, m, closing), due);

  it('November of a card closing on 2 and due on 9: window Oct 2..Nov 1, closes Nov 2, due Nov 9', () => {
    expect(dates(11, 2, 9)).toEqual({ windowStart: '2026-10-02', windowEnd: '2026-11-01', closingDate: '2026-11-02', dueDate: '2026-11-09' });
  });

  it('October: closes Oct 2 and is due Oct 9', () => {
    expect(dates(10, 2, 9)).toMatchObject({ closingDate: '2026-10-02', dueDate: '2026-10-09' });
  });

  it('a due day before the closing day falls in the next month (closing 26, due 3)', () => {
    expect(dates(11, 26, 3)).toMatchObject({ closingDate: '2026-11-26', dueDate: '2026-12-03' });
    expect(dates(12, 26, 3)).toMatchObject({ closingDate: '2026-12-26', dueDate: '2027-01-03' });
  });

  it('clamps a due day to a short month and has no due date without one', () => {
    expect(dates(1, 20, 31)).toMatchObject({ closingDate: '2026-01-20', dueDate: '2026-01-31' });
    expect(dates(2, 20, 31)).toMatchObject({ closingDate: '2026-02-20', dueDate: '2026-02-28' });
    expect(dates(10, 2, null).dueDate).toBeNull();
  });

  it('is the calendar month without a closing day', () => {
    expect(dates(2, null, null)).toMatchObject({ windowStart: '2026-02-01', windowEnd: '2026-02-28', closingDate: '2026-03-01' });
  });
});

describe('invoiceDates on short months and equal closing/due days', () => {
  const dates = (m: number, closing: number, due: number | null) => invoiceDates(creditCardInvoiceWindow(2026, m, closing), due);

  it('closing 30 on February closes on Feb 28 (never Mar 2) and the windows stay continuous', () => {
    expect(dates(2, 30, 9)).toMatchObject({ windowStart: '2026-01-30', windowEnd: '2026-02-27', closingDate: '2026-02-28', dueDate: '2026-03-09' });
    expect(dates(3, 30, 9)).toMatchObject({ windowStart: '2026-02-28', windowEnd: '2026-03-29', closingDate: '2026-03-30' });
  });

  it('closing 31 on February and April closes on the last day of the month', () => {
    expect(dates(2, 31, 9)).toMatchObject({ closingDate: '2026-02-28', windowStart: '2026-01-31', windowEnd: '2026-02-27' });
    expect(dates(4, 31, 9)).toMatchObject({ closingDate: '2026-04-30', windowStart: '2026-03-31', windowEnd: '2026-04-29' });
    expect(dates(5, 31, 9)).toMatchObject({ closingDate: '2026-05-31', windowStart: '2026-04-30', windowEnd: '2026-05-30' });
  });

  it('a leap February keeps day 29', () => {
    expect(invoiceDates(creditCardInvoiceWindow(2028, 2, 30), 9).closingDate).toBe('2028-02-29');
  });

  it('every window starts the day the previous one closed (no gap, no overlap) for closing 28..31', () => {
    for (const closing of [28, 29, 30, 31]) {
      for (let m = 2; m <= 12; m += 1) {
        const prev = invoiceDates(creditCardInvoiceWindow(2026, m - 1, closing), 9);
        const cur = invoiceDates(creditCardInvoiceWindow(2026, m, closing), 9);
        expect(cur.windowStart, `closing ${closing} month ${m}`).toBe(prev.closingDate);
      }
    }
  });

  it('closing day equal to the due day: the due date is the NEXT month (due is strictly after closing)', () => {
    expect(dates(11, 9, 9)).toMatchObject({ closingDate: '2026-11-09', dueDate: '2026-12-09' });
  });
});

describe('invoiceState', () => {
  it('is open until the closing date, then closed or paid', () => {
    expect(invoiceState('2026-11-02', '2026-11-01', false)).toBe('open');
    expect(invoiceState('2026-11-02', '2026-11-02', false)).toBe('closed');
    expect(invoiceState('2026-11-02', '2026-11-20', true)).toBe('paid');
    expect(invoiceState('2026-11-02', '2026-11-01', true)).toBe('open');
  });
});

describe('projectRecurrence', () => {
  const win = { windowStart: '2026-10-02', windowEnd: '2026-11-01' };
  const base = {
    id: 'r', description: 'Spotify', categoryName: 'x', amount: 12.9, frequency: 'MONTHLY' as const,
    startDate: day('2026-01-08'), endDate: null, nextRunAt: day('2026-10-08'), followLastAmount: false, sign: 1 as const,
  };

  it('counts a monthly occurrence once when its next run is inside the window', () => {
    const items = projectRecurrence(base, win, '2026-10-06', new Set());
    expect(items.map((i) => [i.date, i.amount])).toEqual([['2026-10-08', 12.9]]);
  });

  it('does not count the next month occurrence that falls after the window', () => {
    expect(projectRecurrence(base, win, '2026-10-06', new Set()).map((i) => i.date)).not.toContain('2026-11-08');
  });

  it('skips a month that already holds a generated occurrence (the cron would create nothing)', () => {
    expect(projectRecurrence(base, win, '2026-10-06', new Set(['r:2026-10']))).toEqual([]);
  });

  it('counts a weekly recurrence on every week inside the window', () => {
    const weekly = { ...base, frequency: 'WEEKLY' as const, nextRunAt: day('2026-10-09'), startDate: day('2026-10-02') };
    expect(projectRecurrence(weekly, win, '2026-10-06', new Set()).map((i) => i.date)).toEqual(['2026-10-09', '2026-10-16', '2026-10-23', '2026-10-30']);
  });

  it('counts a biweekly one and skips an exact day already generated', () => {
    const bi = { ...base, frequency: 'BIWEEKLY' as const, nextRunAt: day('2026-10-09') };
    expect(projectRecurrence(bi, win, '2026-10-06', new Set(['r:2026-10-09'])).map((i) => i.date)).toEqual(['2026-10-23']);
  });

  it('counts a yearly recurrence only when its anniversary is inside the window', () => {
    const yearly = { ...base, frequency: 'YEARLY' as const, nextRunAt: day('2026-10-20') };
    expect(projectRecurrence(yearly, win, '2026-10-06', new Set()).map((i) => i.date)).toEqual(['2026-10-20']);
    expect(projectRecurrence({ ...yearly, nextRunAt: day('2027-10-20') }, win, '2026-10-06', new Set())).toEqual([]);
  });

  it('stops at the end date and drops a late occurrence dated before the window start (the next one counts)', () => {
    expect(projectRecurrence({ ...base, endDate: day('2026-10-07') }, win, '2026-10-06', new Set())).toEqual([]);
    expect(projectRecurrence({ ...base, nextRunAt: day('2026-09-20') }, { ...win, windowStart: '2026-10-02' }, '2026-10-06', new Set())
      .map((i) => i.date)).toEqual(['2026-10-20']);
  });

  it('dates an overdue monthly occurrence on its scheduled day (the cron is late, the month is still the same)', () => {
    const overdue = { ...base, nextRunAt: day('2026-10-03') };
    expect(projectRecurrence(overdue, win, '2026-10-06', new Set()).map((i) => i.date)).toEqual(['2026-10-03']);
  });

  it('negates an income recurrence and keeps whole cents', () => {
    const [item] = projectRecurrence({ ...base, sign: -1, amount: 0.1 + 0.2 }, win, '2026-10-06', new Set());
    expect(item.amount).toBe(-0.3);
  });

  it('reads the day of a nextRunAt stored as local midnight the same as UTC midnight', () => {
    const local = projectRecurrence({ ...base, nextRunAt: new Date(2026, 9, 8) }, win, '2026-10-06', new Set());
    expect(local.map((i) => i.date)).toEqual(['2026-10-08']);
  });
});

describe('buildForecast', () => {
  const dates = invoiceDates(creditCardInvoiceWindow(2026, 11, 2), 9);
  it('has nothing to forecast once the closing date has come', () => {
    const f = buildForecast([], new Set(), dates, '2026-11-02', 108546);
    expect(f).toEqual({ applicable: false, items: [], total: 0, expectedClosingTotal: 1085.46 });
  });
});

describe('calculateCreditCardInvoice forecast', () => {
  const seedNovember = () => {
    store.tx = [purchase('2026-10-20', 1085.46)];
  };

  it('adds the two recurrences of the card to the November invoice posted so far (1085.46 + 12.90 + 170.00 = 1268.36)', async () => {
    seedNovember();
    store.rec = [
      recurrence('spotify', { description: 'Spotify', amount: decimal(12.9), nextRunAt: day('2026-10-08') }),
      recurrence('academia', { description: 'Academia', amount: decimal(170), nextRunAt: day('2026-10-19') }),
    ];

    const nov = await invoice('2026-11');

    expect(nov.statementTotal).toBe(1085.46);
    expect(nov.currentExpenses).toBeCloseTo(1085.46, 2);
    expect(nov.closingDate).toBe('2026-11-02');
    expect(nov.dueDate).toBe('2026-11-09');
    expect(nov.state).toBe('open');
    expect(nov.forecast.applicable).toBe(true);
    expect(nov.forecast.items.map((i: any) => [i.description, i.date, i.amount])).toEqual([
      ['Spotify', '2026-10-08', 12.9],
      ['Academia', '2026-10-19', 170],
    ]);
    expect(nov.forecast.total).toBe(182.9);
    expect(nov.forecast.expectedClosingTotal).toBe(1268.36);
  });

  it('separates the statement from the debt: October closed 5384.98 stays outstanding in November', async () => {
    store.tx = [purchase('2026-09-15', 5384.98), purchase('2026-10-20', 1085.46)];

    const nov = await invoice('2026-11');

    expect(nov.outstandingFromPrevious).toBeCloseTo(5384.98, 2);
    expect(nov.statementTotal).toBe(1085.46);
    expect(nov.total).toBeCloseTo(6470.44, 2);
    expect(nov.debtTotal).toBe(6470.44);
    expect(nov.outstandingFromPrevious).toBe(5384.98);
    const oct = await invoice('2026-10');
    expect(oct.statementTotal).toBe(5384.98);
    expect(oct.state).toBe('closed');
    expect(oct.closingDate).toBe('2026-10-02');
    expect(oct.dueDate).toBe('2026-10-09');
    expect(oct.forecast).toEqual({ applicable: false, items: [], total: 0, expectedClosingTotal: 5384.98 });
  });

  it('counts an occurrence once even when its month already holds a generated transaction', async () => {
    seedNovember();
    store.tx.push(purchase('2026-10-08', 12.9, { recurringTransactionId: 'spotify' }));
    store.rec = [recurrence('spotify', { amount: decimal(12.9), nextRunAt: day('2026-10-08') })];

    const nov = await invoice('2026-11');

    expect(nov.statementTotal).toBeCloseTo(1098.36, 2);
    expect(nov.forecast.items).toEqual([]);
    expect(nov.forecast.expectedClosingTotal).toBe(1098.36);
  });

  it('ignores inactive recurrences and the ones of other cards', async () => {
    seedNovember();
    store.rec = [
      recurrence('off', { isActive: false }),
      recurrence('other', { accountId: 'card-2' }),
      recurrence('mine', { amount: decimal(25) }),
    ];

    const nov = await invoice('2026-11');

    expect(nov.forecast.items.map((i: any) => i.recurringTransactionId)).toEqual(['mine']);
    expect(nov.forecast.expectedClosingTotal).toBe(1110.46);
  });

  it('keeps future installments already stored in the posted amount, not in the forecast', async () => {
    store.tx = [purchase('2026-10-25', 300, { description: 'parcela 2/3' })];
    store.rec = [recurrence('mine', { amount: decimal(25) })];

    const nov = await invoice('2026-11');

    expect(nov.statementTotal).toBe(300);
    expect(nov.forecast.total).toBe(25);
    expect(nov.forecast.expectedClosingTotal).toBe(325);
  });

  it('has no forecast for a closed invoice and does not even read the recurrences', async () => {
    store.rec = [recurrence('mine')];

    const oct = await invoice('2026-10');

    expect(oct.forecast.applicable).toBe(false);
    expect(calls.recFind).toHaveLength(0);
  });

  it('forecasts a future invoice from its window start (December: nothing before Nov 2)', async () => {
    store.rec = [recurrence('mine', { amount: decimal(25), nextRunAt: day('2026-10-08') })];

    const dec = await invoice('2026-12');

    // Next runs Oct 8 (Oct window) then Nov 8 (Nov window) then Dec 8 -> only the Nov 8 occurrence is in Nov 2..Dec 1
    expect(dec.forecast.items.map((i: any) => i.date)).toEqual(['2026-11-08']);
    expect(dec.state).toBe('open');
  });

  it('turns an income recurrence into a negative item (a credit)', async () => {
    seedNovember();
    store.rec = [recurrence('refund', { categoryName: 'salary', amount: decimal(50) })];
    const income = (await import('../../shared/enums/index.js')).getCategoriesByType((await import('../../shared/enums/index.js')).CategoryType.INCOME)[0];
    store.rec[0].categoryName = income;

    const nov = await invoice('2026-11');

    expect(nov.forecast.items[0].amount).toBe(-50);
    expect(nov.forecast.expectedClosingTotal).toBe(1035.46);
  });

  it('reads the UTC date of today: 23:30 on Oct 6 in UTC-3 is already Oct 7 in UTC, the occurrence of Oct 7 stays', async () => {
    store.rec = [recurrence('mine', { nextRunAt: day('2026-10-07') })];
    const nov = await invoice('2026-11', utcTodayOf('2026-10-06T23:30:00-03:00'));
    expect(nov.forecast.items.map((i: any) => i.date)).toEqual(['2026-10-07']);
  });

  it('marks the invoice closed on its closing date and open the day before', async () => {
    seedNovember();
    expect((await invoice('2026-11', day('2026-11-01'))).state).toBe('open');
    expect((await invoice('2026-11', day('2026-11-02'))).state).toBe('closed');
  });

  it('a paid invoice owes 0 and a one-cent residue is neither debt nor outstanding of the next invoice', async () => {
    store.tx = [
      purchase('2026-07-10', 100),
      purchase('2026-08-20', 50),
      { ...purchase('2026-08-05', 99.99), attachmentUrl: `invoice_pay:${CARD.id}:2026-7` },
    ];
    const aug = await invoice('2026-08');
    expect(aug.statementTotal).toBe(100);
    expect(aug.isPaid).toBe(true);
    expect(aug.state).toBe('paid');
    expect(aug.debtTotal).toBe(0);
    const sep = await invoice('2026-09');
    expect(sep.outstandingFromPrevious).toBe(0);
    expect(sep.statementTotal).toBe(50);
    expect(sep.debtTotal).toBe(50);
  });

  it('keeps every legacy field of the response', async () => {
    seedNovember();
    const nov = await invoice('2026-11');
    for (const key of ['accountId', 'month', 'previousBalance', 'currentExpenses', 'currentPayments', 'total', 'isPaid', 'paymentTransactions', 'invoiceTransactions']) {
      expect(nov).toHaveProperty(key);
    }
  });
});

function utcTodayOf(iso: string): Date {
  const d = new Date(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
