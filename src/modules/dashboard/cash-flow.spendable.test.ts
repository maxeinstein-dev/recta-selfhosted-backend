import { describe, expect, it } from 'vitest';

import { buildCashFlow, type CashFlowEventInput } from './cash-flow.js';

// Invented data only. "How much can I spend until the next income without the account going negative".
const TODAY = '2026-11-10';

const ev = (over: Partial<CashFlowEventInput> & Pick<CashFlowEventInput, 'date' | 'amountCents'>): CashFlowEventInput => ({
  description: 'Item',
  source: 'recurrence',
  certainty: 'expected',
  sourceId: 'src-1',
  accountId: 'acc-1',
  ...over,
});

const build = (events: CashFlowEventInput[], startingBalanceCents = 100000, days = 30) =>
  buildCashFlow({ startingBalanceCents, today: TODAY, days, events });

describe('buildCashFlow: next income and what can be spent until it', () => {
  it('the lowest balance between today and the next income, over the free balance', () => {
    const out = build([
      ev({ date: '2026-11-12', amountCents: -30000, description: 'Rent' }),
      ev({ date: '2026-11-15', amountCents: -20000, description: 'Internet' }),
      ev({ date: '2026-11-20', amountCents: 500000, description: 'Salary', sourceId: 'rec-sal' }),
      // After the income: does not count, even when it is lower
      ev({ date: '2026-11-25', amountCents: -590000, description: 'Big bill' }),
    ]);
    expect(out.summary.nextIncome).toEqual({ date: '2026-11-20', amount: 5000, description: 'Salary' });
    expect(out.summary.spendableUntilNextIncome).toEqual({ amount: 500, lowestDate: '2026-11-15', balance: 'free' });
  });

  it('no income in the period: both are null (the screen says so instead of a number)', () => {
    const out = build([ev({ date: '2026-11-12', amountCents: -30000 })]);
    expect(out.summary.nextIncome).toBeNull();
    expect(out.summary.spendableUntilNextIncome).toBeNull();
  });

  it('an income past the end of the period does not count', () => {
    const out = build([ev({ date: '2026-12-15', amountCents: 500000 })], 100000, 30);
    expect(out.summary.nextIncome).toBeNull();
    expect(out.summary.spendableUntilNextIncome).toBeNull();
  });

  it('an income on the last day of the period counts, and the window runs to it', () => {
    const out = build([ev({ date: '2026-12-05', amountCents: -40000 }), ev({ date: '2026-12-10', amountCents: 300000, description: 'Salary' })], 100000, 30);
    expect(out.summary.nextIncome).toMatchObject({ date: '2026-12-10', amount: 3000 });
    expect(out.summary.spendableUntilNextIncome).toMatchObject({ amount: 600, lowestDate: '2026-12-05' });
  });

  it('balance already negative: zero, never negative', () => {
    const out = build([ev({ date: '2026-11-20', amountCents: 500000 })], -25000);
    expect(out.summary.spendableUntilNextIncome).toEqual({ amount: 0, lowestDate: TODAY, balance: 'free' });
  });

  it('goes negative before the income: zero, dated on the lowest day', () => {
    const out = build([ev({ date: '2026-11-12', amountCents: -150000 }), ev({ date: '2026-11-20', amountCents: 500000 })]);
    expect(out.summary.spendableUntilNextIncome).toMatchObject({ amount: 0, lowestDate: '2026-11-12' });
  });

  it('an income today is already in today\'s balance: the next income is the following one', () => {
    const out = build([
      ev({ date: TODAY, amountCents: 500000, description: 'Salary today' }),
      ev({ date: '2026-11-15', amountCents: -100000 }),
      ev({ date: '2026-12-05', amountCents: 200000, description: 'Freelance' }),
    ]);
    expect(out.summary.nextIncome).toEqual({ date: '2026-12-05', amount: 2000, description: 'Freelance' });
    // 1000 + 5000 today = 6000; 5000 after the 15th
    expect(out.summary.spendableUntilNextIncome).toMatchObject({ amount: 5000, lowestDate: '2026-11-15' });
  });

  it('an income today and none later: null', () => {
    const out = build([ev({ date: TODAY, amountCents: 500000 })]);
    expect(out.summary.nextIncome).toBeNull();
    expect(out.summary.spendableUntilNextIncome).toBeNull();
  });

  it('an overdue income (moved to today) is not the next income either', () => {
    const out = build([ev({ date: '2026-11-01', amountCents: 500000, source: 'pending' })]);
    expect(out.summary.nextIncome).toBeNull();
  });

  it('the day of the income counts with what leaves on it: an outflow larger than the income lowers the number', () => {
    const out = build([ev({ date: '2026-11-20', amountCents: 50000, description: 'Refund' }), ev({ date: '2026-11-20', amountCents: -120000, description: 'Rent' })]);
    // 1000 until the 19th; the 20th ends at 300
    expect(out.summary.spendableUntilNextIncome).toMatchObject({ amount: 300, lowestDate: '2026-11-20' });
  });

  it('several incomes on that day: the amount is their sum, the description the largest one', () => {
    const out = build([
      ev({ date: '2026-11-20', amountCents: 20000, description: 'Cashback', sourceId: 'a' }),
      ev({ date: '2026-11-20', amountCents: 400000, description: 'Salary', sourceId: 'b' }),
    ]);
    expect(out.summary.nextIncome).toEqual({ date: '2026-11-20', amount: 4200, description: 'Salary' });
  });

  it('uses the free balance: what the savings goals keep stays out', () => {
    const out = buildCashFlow({
      startingBalanceCents: 30000,
      allocatedCents: 70000,
      today: TODAY,
      days: 30,
      events: [ev({ date: '2026-11-20', amountCents: 500000 })],
    });
    expect(out.summary.spendableUntilNextIncome).toEqual({ amount: 300, lowestDate: TODAY, balance: 'free' });
  });
});
