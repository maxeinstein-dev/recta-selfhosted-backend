import { describe, expect, it } from 'vitest';

import { addDays, buildCashFlow, type CashFlowEventInput } from './cash-flow.js';

// Invented data only.
const TODAY = '2026-11-10';

const ev = (over: Partial<CashFlowEventInput> & Pick<CashFlowEventInput, 'date' | 'amountCents'>): CashFlowEventInput => ({
  description: 'Item',
  source: 'pending',
  certainty: 'confirmed',
  sourceId: 'src-1',
  accountId: 'acc-1',
  ...over,
});

const build = (events: CashFlowEventInput[], over: { startingBalanceCents?: number; days?: number } = {}) =>
  buildCashFlow({ startingBalanceCents: over.startingBalanceCents ?? 100000, today: TODAY, days: over.days ?? 90, events });

describe('addDays', () => {
  it('crosses month and year ends', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-11-10', 90)).toBe('2027-02-08');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('buildCashFlow: empty and arithmetic', () => {
  it('household without events: only the starting balance and an empty summary', () => {
    const out = build([]);
    expect(out.startingBalance).toBe(1000);
    expect(out.days).toEqual([]);
    expect(out.period).toEqual({ from: TODAY, to: '2027-02-08', days: 90 });
    expect(out.summary).toMatchObject({
      lowestBalance: { date: TODAY, amount: 1000 },
      firstNegativeDate: null,
      endingBalance: 1000,
      totalInflow: 0,
      totalOutflow: 0,
      eventCount: 0,
      estimatedCount: 0,
      overdueCount: 0,
    });
    expect(out.summary.balanceAfterDays.map((b) => b.balance)).toEqual([1000, 1000, 1000]);
  });

  it('starting balance plus the sum of the events is the ending balance, and each day carries the balance', () => {
    const out = build([
      ev({ date: '2026-11-12', amountCents: -25050 }),
      ev({ date: '2026-11-15', amountCents: 300000, source: 'recurrence', certainty: 'expected' }),
      ev({ date: '2026-11-20', amountCents: -12345 }),
    ]);
    expect(out.days.map((d) => [d.date, d.endBalance])).toEqual([
      ['2026-11-12', 749.5],
      ['2026-11-15', 3749.5],
      ['2026-11-20', 3626.05],
    ]);
    expect(out.summary.endingBalance).toBe(1000 + (-250.5 + 3000 - 123.45));
    expect(out.summary.totalInflow).toBe(3000);
    expect(out.summary.totalOutflow).toBe(373.95);
  });

  it('sums in whole cents: values that drift in binary add up exactly', () => {
    const out = build(
      [ev({ date: '2026-11-11', amountCents: -10 }), ev({ date: '2026-11-11', amountCents: -20 }), ev({ date: '2026-11-11', amountCents: -30 })],
      { startingBalanceCents: 0 },
    );
    expect(out.days[0]).toMatchObject({ outflow: 0.6, inflow: 0, net: -0.6, endBalance: -0.6 });
    expect(out.summary.endingBalance).toBe(-0.6);
  });

  it('refuses amounts that are not whole cents', () => {
    expect(() => build([ev({ date: '2026-11-11', amountCents: 10.5 })])).toThrow(/whole cents/);
  });
});

describe('buildCashFlow: summary', () => {
  it('lowest balance and first negative day', () => {
    const out = build(
      [
        ev({ date: '2026-11-11', amountCents: -80000 }),
        ev({ date: '2026-11-14', amountCents: -50000 }), // -300
        ev({ date: '2026-11-16', amountCents: 200000 }), // 1700
        ev({ date: '2026-11-18', amountCents: -250000 }), // -800 (lowest)
        ev({ date: '2026-11-25', amountCents: 500000 }),
      ],
    );
    expect(out.summary.lowestBalance).toEqual({ date: '2026-11-18', amount: -800 });
    expect(out.summary.firstNegativeDate).toBe('2026-11-14');
  });

  it('the lowest balance is the earliest day when two days tie, and may be today when nothing lowers it', () => {
    const tie = build([ev({ date: '2026-11-11', amountCents: -50000 }), ev({ date: '2026-11-12', amountCents: 10000 }), ev({ date: '2026-11-13', amountCents: -10000 })]);
    expect(tie.summary.lowestBalance).toEqual({ date: '2026-11-11', amount: 500 });
    const up = build([ev({ date: '2026-11-11', amountCents: 50000 })]);
    expect(up.summary.lowestBalance).toEqual({ date: TODAY, amount: 1000 });
    expect(up.summary.firstNegativeDate).toBeNull();
  });

  it('a balance exactly zero is not negative', () => {
    const out = build([ev({ date: '2026-11-11', amountCents: -100000 })]);
    expect(out.summary.firstNegativeDate).toBeNull();
    expect(out.summary.lowestBalance).toEqual({ date: '2026-11-11', amount: 0 });
  });

  it('a negative starting balance is negative today', () => {
    const out = build([], { startingBalanceCents: -500 });
    expect(out.summary.firstNegativeDate).toBe(TODAY);
  });

  it('balances after 30, 60 and 90 days are those at the end of that day, only the ones that fit', () => {
    const events = [
      ev({ date: '2026-12-10', amountCents: -1000 }), // day 30 exactly
      ev({ date: '2026-12-11', amountCents: -2000 }), // day 31
      ev({ date: '2027-01-09', amountCents: -4000 }), // day 60 exactly
      ev({ date: '2027-02-08', amountCents: -8000 }), // day 90 exactly
    ];
    const full = build(events);
    expect(full.summary.balanceAfterDays).toEqual([
      { days: 30, date: '2026-12-10', balance: 990 },
      { days: 60, date: '2027-01-09', balance: 930 },
      { days: 90, date: '2027-02-08', balance: 850 },
    ]);
    const short = build(events, { days: 45 });
    expect(short.summary.balanceAfterDays.map((b) => b.days)).toEqual([30]);
    expect(short.summary.endingBalance).toBe(1000 - 10 - 20);
    expect(build(events, { days: 29 }).summary.balanceAfterDays).toEqual([]);
  });

  it('counts estimated and overdue events', () => {
    const out = build([
      ev({ date: '2026-11-11', amountCents: -1000, certainty: 'estimated', source: 'recurrence' }),
      ev({ date: '2026-11-12', amountCents: -1000, certainty: 'expected', source: 'recurrence' }),
      ev({ date: '2026-11-01', amountCents: -1000 }),
    ]);
    expect(out.summary).toMatchObject({ eventCount: 3, estimatedCount: 1, overdueCount: 1 });
  });
});

describe('buildCashFlow: table 3.3, one case per row', () => {
  it('pending with a date from today on enters on its date, confirmed', () => {
    const out = build([ev({ date: '2026-11-20', amountCents: -9000, source: 'pending' })]);
    expect(out.days).toHaveLength(1);
    expect(out.days[0]!.date).toBe('2026-11-20');
    expect(out.days[0]!.events[0]).toMatchObject({ source: 'pending', certainty: 'confirmed', overdue: false, originalDate: null, amount: -90 });
  });

  it('pending dated today is not overdue', () => {
    const out = build([ev({ date: TODAY, amountCents: -9000 })]);
    expect(out.days[0]!.events[0]).toMatchObject({ date: TODAY, overdue: false });
  });

  it('pending dated in the past enters today, flagged overdue, keeping its original day', () => {
    const out = build([ev({ date: '2026-10-28', amountCents: -9000 })]);
    expect(out.days[0]!.events[0]).toMatchObject({ date: TODAY, overdue: true, originalDate: '2026-10-28', certainty: 'confirmed' });
    expect(out.days[0]!.endBalance).toBe(910);
  });

  it('a recurrence occurrence enters on its date with the certainty the loader gave', () => {
    const out = build([
      ev({ date: '2026-11-25', amountCents: 450000, source: 'recurrence', certainty: 'expected', description: 'Salary' }),
      ev({ date: '2026-11-26', amountCents: -20000, source: 'recurrence', certainty: 'estimated', description: 'Energy' }),
    ]);
    expect(out.days[0]!.events[0]).toMatchObject({ source: 'recurrence', certainty: 'expected', amount: 4500 });
    expect(out.days[1]!.events[0]).toMatchObject({ source: 'recurrence', certainty: 'estimated', amount: -200 });
  });

  it('a closed unpaid invoice enters on its due date (confirmed); already due, it enters today overdue', () => {
    const out = build([
      ev({ date: '2026-11-18', amountCents: -123456, source: 'invoice', certainty: 'confirmed', invoiceMonth: '2026-11' }),
      ev({ date: '2026-11-05', amountCents: -50000, source: 'invoice', certainty: 'confirmed', invoiceMonth: '2026-10', sourceId: 'card-2' }),
    ]);
    expect(out.days.map((d) => d.date)).toEqual([TODAY, '2026-11-18']);
    expect(out.days[0]!.events[0]).toMatchObject({ source: 'invoice', overdue: true, originalDate: '2026-11-05', invoiceMonth: '2026-10' });
    expect(out.days[1]!.events[0]).toMatchObject({ source: 'invoice', certainty: 'confirmed', amount: -1234.56, invoiceMonth: '2026-11' });
  });

  it('an open or future invoice enters on its due date, estimated', () => {
    const out = build([ev({ date: '2026-12-18', amountCents: -80000, source: 'invoice', certainty: 'estimated', invoiceMonth: '2026-12' })]);
    expect(out.days[0]!.events[0]).toMatchObject({ date: '2026-12-18', certainty: 'estimated' });
    expect(out.summary.estimatedCount).toBe(1);
  });
});

describe('buildCashFlow: section 5 edge cases', () => {
  it('an event after the end of the period is left out (an invoice due outside it does not enter)', () => {
    const out = build([ev({ date: '2026-12-10', amountCents: -1000 }), ev({ date: '2026-12-11', amountCents: -1000 })], { days: 30 });
    expect(out.days.map((d) => d.date)).toEqual(['2026-12-10']);
    expect(out.summary.endingBalance).toBe(990);
  });

  it('two cards paid by the same account on the same day: two events, one day', () => {
    const out = build([
      ev({ date: '2026-11-18', amountCents: -30000, source: 'invoice', sourceId: 'card-a', description: 'Fatura A' }),
      ev({ date: '2026-11-18', amountCents: -45000, source: 'invoice', sourceId: 'card-b', description: 'Fatura B' }),
    ]);
    expect(out.days).toHaveLength(1);
    expect(out.days[0]!.events.map((e) => e.sourceId)).toEqual(['card-a', 'card-b']);
    expect(out.days[0]).toMatchObject({ outflow: 750, endBalance: 250 });
  });

  it('several overdue items all land today (not spread)', () => {
    const out = build([
      ev({ date: '2026-08-05', amountCents: -10000, source: 'recurrence', certainty: 'expected', sourceId: 'rec-1' }),
      ev({ date: '2026-09-05', amountCents: -10000, source: 'recurrence', certainty: 'expected', sourceId: 'rec-1' }),
      ev({ date: '2026-10-05', amountCents: -10000, source: 'recurrence', certainty: 'expected', sourceId: 'rec-1' }),
    ]);
    expect(out.days).toHaveLength(1);
    expect(out.days[0]!.date).toBe(TODAY);
    expect(out.days[0]!.events.map((e) => e.originalDate)).toEqual(['2026-08-05', '2026-09-05', '2026-10-05']);
    expect(out.summary.overdueCount).toBe(3);
    expect(out.summary.endingBalance).toBe(700);
  });

  it('an event the loader marked overdue stays overdue even if dated today', () => {
    const out = build([ev({ date: TODAY, amountCents: -1000, overdue: true })]);
    expect(out.days[0]!.events[0]).toMatchObject({ overdue: true, originalDate: null });
  });

  it('unassigned invoices are listed apart and never enter the balance', () => {
    const out = buildCashFlow({
      startingBalanceCents: 100000,
      today: TODAY,
      days: 90,
      events: [],
      unassignedInvoices: [{ accountId: 'card-9', accountName: 'Card', month: '2026-11', dueDate: '2026-11-20', amountCents: 55000, reason: 'no_payer_account' }],
    });
    expect(out.unassignedInvoices).toEqual([{ accountId: 'card-9', accountName: 'Card', month: '2026-11', dueDate: '2026-11-20', amount: 550, reason: 'no_payer_account' }]);
    expect(out.summary.endingBalance).toBe(1000);
    expect(out.days).toEqual([]);
  });

  it('orders the events of a day: pending, recurrence, invoice', () => {
    const out = build([
      ev({ date: '2026-11-18', amountCents: -1, source: 'invoice' }),
      ev({ date: '2026-11-18', amountCents: -1, source: 'recurrence' }),
      ev({ date: '2026-11-18', amountCents: -1, source: 'pending' }),
    ]);
    expect(out.days[0]!.events.map((e) => e.source)).toEqual(['pending', 'recurrence', 'invoice']);
  });
});
