import { describe, expect, it } from 'vitest';
import { conservativeWindowOf, expectedAmountFor, explainExpectedAmount } from './expected-amount.js';
import type { ConfirmedOccurrence, ExpectedAmountRecurrence } from './expected-amount.js';

// Invented data only. History is newest first, like the service loads it.
const hist = (...amounts: number[]): ConfirmedOccurrence[] => amounts.map((amount, i) => ({ amount, date: `2026-0${9 - i}-05` }));

describe('LAST (default)', () => {
  it('is the recurrence amount, whatever the history holds', () => {
    expect(expectedAmountFor({ amount: 100 }, [], '2026-10')).toBe(100);
    expect(expectedAmountFor({ amount: 100, followLastAmount: true }, hist(90, 80), '2026-10')).toBe(100);
    expect(expectedAmountFor({ amount: 100, forecastStrategy: 'LAST' }, hist(1), '2026-10')).toBe(100);
  });
  it('an unknown or null strategy behaves as LAST', () => {
    expect(expectedAmountFor({ amount: 100, forecastStrategy: null }, hist(1), '2026-10')).toBe(100);
    expect(expectedAmountFor({ amount: 100, forecastStrategy: 'NOPE' }, hist(1), '2026-10')).toBe(100);
  });
});

describe('FIXED', () => {
  it('is the typed amount; confirmed values never replace it', () => {
    expect(expectedAmountFor({ amount: 250, forecastStrategy: 'FIXED' }, hist(999, 1), '2026-10')).toBe(250);
    expect(explainExpectedAmount({ amount: 250, forecastStrategy: 'FIXED' }, hist(999), '2026-10')).toEqual({ amount: 250, strategy: 'FIXED' });
  });
});

describe('CONSERVATIVE', () => {
  const income = (extra: Partial<ExpectedAmountRecurrence> = {}): ExpectedAmountRecurrence => ({ amount: 500, forecastStrategy: 'CONSERVATIVE', type: 'INCOME', ...extra });
  const expense = (extra: Partial<ExpectedAmountRecurrence> = {}): ExpectedAmountRecurrence => ({ amount: 500, forecastStrategy: 'CONSERVATIVE', type: 'EXPENSE', ...extra });

  it('income: the SMALLEST of the last N (default 6)', () => {
    // 8 confirmed, newest first: only the first 6 count, so the 100 (7th) is out
    const h = hist(700, 650, 800, 720, 690, 710, 100, 900);
    expect(conservativeWindowOf(income())).toBe(6);
    expect(expectedAmountFor(income(), h, '2026-10')).toBe(650);
    expect(explainExpectedAmount(income(), h, '2026-10')).toMatchObject({ window: 6, usedValues: [700, 650, 800, 720, 690, 710] });
  });
  it('expense: the LARGEST of the last N (default 3)', () => {
    const h = hist(100, 120, 110, 900);
    expect(conservativeWindowOf(expense())).toBe(3);
    expect(expectedAmountFor(expense(), h, '2026-10')).toBe(120);
  });
  it('the same history gives opposite picks for income and expense', () => {
    const h = hist(300, 100, 200);
    expect(expectedAmountFor(income({ forecastWindow: 3 }), h, '2026-10')).toBe(100);
    expect(expectedAmountFor(expense({ forecastWindow: 3 }), h, '2026-10')).toBe(300);
  });
  it('N is configurable per recurrence (1 = the last value)', () => {
    const h = hist(300, 100, 200);
    expect(expectedAmountFor(income({ forecastWindow: 1 }), h, '2026-10')).toBe(300);
    expect(expectedAmountFor(income({ forecastWindow: 2 }), h, '2026-10')).toBe(100);
    expect(expectedAmountFor(expense({ forecastWindow: 2 }), h, '2026-10')).toBe(300);
  });
  it('fewer confirmed than N: uses the ones there are', () => {
    expect(expectedAmountFor(income({ forecastWindow: 12 }), hist(400, 350), '2026-10')).toBe(350);
    expect(explainExpectedAmount(income({ forecastWindow: 12 }), hist(400, 350), '2026-10')).toMatchObject({ window: 12, usedValues: [400, 350] });
  });
  it('none confirmed: falls back to the recurrence amount', () => {
    expect(expectedAmountFor(income(), [], '2026-10')).toBe(500);
    expect(explainExpectedAmount(income(), [], '2026-10')).toMatchObject({ amount: 500, fellBack: true });
  });
  it('ignores non-positive and non-finite history values', () => {
    expect(expectedAmountFor(income(), hist(0, Number.NaN, 420, -5), '2026-10')).toBe(420);
  });
  it('a window outside 1..36 is clamped / ignored', () => {
    expect(conservativeWindowOf({ type: 'INCOME', forecastWindow: 99 })).toBe(36);
    expect(conservativeWindowOf({ type: 'INCOME', forecastWindow: 0 })).toBe(6);
    expect(conservativeWindowOf({ type: 'EXPENSE', forecastWindow: 2.5 })).toBe(3);
  });
  it('a recurrence of unknown kind is treated as an expense (the larger value)', () => {
    expect(expectedAmountFor({ amount: 1, forecastStrategy: 'CONSERVATIVE' }, hist(10, 30, 20), '2026-10')).toBe(30);
  });
  it('compares in cents without float drift', () => {
    expect(expectedAmountFor(expense(), hist(0.1, 0.2, 0.3), '2026-10')).toBe(0.3);
    expect(expectedAmountFor(income(), hist(10.05, 10.06), '2026-10')).toBe(10.05);
  });
});

describe('PER_BUSINESS_DAY', () => {
  const perDay = (extra: Partial<ExpectedAmountRecurrence> = {}): ExpectedAmountRecurrence => ({
    amount: 1, forecastStrategy: 'PER_BUSINESS_DAY', type: 'INCOME', dailyRate: 36, ...extra,
  });

  it('rate x business days of the reference month: 36,00 x 19 = 684,00 (nov/2026) and x 22 = 792,00 (dec/2026)', () => {
    expect(expectedAmountFor(perDay(), [], '2026-11')).toBe(684);
    expect(expectedAmountFor(perDay(), [], '2026-12')).toBe(792);
    expect(explainExpectedAmount(perDay(), [], '2026-11')).toEqual({
      amount: 684, strategy: 'PER_BUSINESS_DAY', businessDays: 19, safetyBusinessDays: 0, countedBusinessDays: 19, dailyRate: 36,
    });
  });
  it('uses the REFERENCE month it is given, not any other', () => {
    expect(expectedAmountFor(perDay(), [], '2026-10')).toBe(36 * 21);
    expect(expectedAmountFor(perDay(), [], '2026-02')).toBe(36 * 20);
  });
  it('the safety margin discounts business days and the result never goes below zero', () => {
    expect(expectedAmountFor(perDay({ safetyBusinessDays: 2 }), [], '2026-11')).toBe(36 * 17);
    expect(explainExpectedAmount(perDay({ safetyBusinessDays: 2 }), [], '2026-11')).toMatchObject({ businessDays: 19, safetyBusinessDays: 2, countedBusinessDays: 17 });
    expect(expectedAmountFor(perDay({ safetyBusinessDays: 19 }), [], '2026-11')).toBe(0);
    expect(expectedAmountFor(perDay({ safetyBusinessDays: 25 }), [], '2026-11')).toBe(0);
    expect(expectedAmountFor(perDay({ safetyBusinessDays: -3 }), [], '2026-11')).toBe(684);
  });
  it('"dias sem vale" and optional holidays of the recurrence reduce the days', () => {
    expect(expectedAmountFor(perDay({ nonWorkingDays: ['06-24', '07-08'] }), [], '2026-06')).toBe(36 * 21);
    expect(expectedAmountFor(perDay({ nonWorkingDays: ['06-24', '07-08'] }), [], '2026-07')).toBe(36 * 22);
    expect(expectedAmountFor(perDay({ optionalHolidays: ['CARNIVAL'] }), [], '2026-02')).toBe(36 * 18);
    expect(expectedAmountFor(perDay({ optionalHolidays: ['CORPUS_CHRISTI'] }), [], '2026-06')).toBe(36 * 21);
  });
  it('is in cents: no float drift with a rate like 36,35 x 19', () => {
    expect(expectedAmountFor(perDay({ dailyRate: 36.35 }), [], '2026-11')).toBe(690.65);
    expect(expectedAmountFor(perDay({ dailyRate: 0.1 }), [], '2026-12')).toBe(2.2);
  });
  it('without a daily rate (or a valid month) it falls back to the recurrence amount', () => {
    expect(expectedAmountFor(perDay({ dailyRate: null, amount: 700 }), [], '2026-11')).toBe(700);
    expect(expectedAmountFor(perDay({ dailyRate: 0, amount: 700 }), [], '2026-11')).toBe(700);
    expect(expectedAmountFor(perDay({ amount: 700 }), [], '')).toBe(700);
    expect(expectedAmountFor(perDay({ amount: 700 }), [], '2026-13')).toBe(700);
  });
  it('ignores the confirmed history (a confirmed value does not move it)', () => {
    expect(expectedAmountFor(perDay(), hist(1, 2, 3), '2026-11')).toBe(684);
  });
});
