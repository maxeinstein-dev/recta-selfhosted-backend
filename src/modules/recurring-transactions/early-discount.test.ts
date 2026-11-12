import { describe, expect, it } from 'vitest';
import {
  amountOnDay,
  discountedAmount,
  earlyDiscountLimit,
  earlyDiscountOf,
  earlyDiscountQuote,
  validateEarlyDiscount,
} from './early-discount.js';

// Invented values only; they have the same shape as the real cases (a fixed amount, a percentage rounded up).
const fixed = { day: 8, type: 'FIXED', value: 25 } as const;
const percent = { day: 8, type: 'PERCENT', value: 8 } as const;

describe('discountedAmount', () => {
  it('subtracts a fixed amount', () => {
    expect(discountedAmount(200, fixed)).toBe(175);
    expect(discountedAmount(163.4, { day: 5, type: 'FIXED', value: 12.35 })).toBe(151.05);
  });

  it('applies a percentage and rounds UP to the cent', () => {
    // 123.45 - 8% = 113.574 -> 113.58 (not 113.57)
    expect(discountedAmount(123.45, percent)).toBe(113.58);
    // 99.95 - 10% = 89.955 -> 89.96
    expect(discountedAmount(99.95, { day: 8, type: 'PERCENT', value: 10 })).toBe(89.96);
  });

  it('keeps an exact result exact (no floating point drift rounds it up)', () => {
    expect(discountedAmount(100, { day: 8, type: 'PERCENT', value: 5 })).toBe(95);
    expect(discountedAmount(114.4, { day: 8, type: 'PERCENT', value: 12.5 })).toBe(100.1);
    expect(discountedAmount(0.7, { day: 8, type: 'PERCENT', value: 10 })).toBe(0.63);
  });
});

describe('earlyDiscountLimit', () => {
  it('is the limit day of the month of the occurrence date', () => {
    expect(earlyDiscountLimit('2026-12-10', 8)).toBe('2026-12-08');
    expect(earlyDiscountLimit('2027-01-02', 8)).toBe('2027-01-08');
  });

  it('a limit past the end of the month is the last day of that month (28, 29, 30 and 31 days)', () => {
    expect(earlyDiscountLimit('2027-02-10', 31)).toBe('2027-02-28');
    expect(earlyDiscountLimit('2028-02-10', 31)).toBe('2028-02-29');
    expect(earlyDiscountLimit('2027-04-10', 31)).toBe('2027-04-30');
    expect(earlyDiscountLimit('2027-03-10', 31)).toBe('2027-03-31');
  });
});

describe('amountOnDay', () => {
  const occurrence = '2026-12-10';

  it('uses the discounted amount the day before, ON and the limit day, and the full amount the day after', () => {
    expect(amountOnDay(200, fixed, occurrence, '2026-12-07')).toBe(175);
    expect(amountOnDay(200, fixed, occurrence, '2026-12-08')).toBe(175);
    expect(amountOnDay(200, fixed, occurrence, '2026-12-09')).toBe(200);
    expect(amountOnDay(200, fixed, occurrence, '2026-12-10')).toBe(200);
  });

  it('a past month (a stale occurrence) is the full amount', () => {
    expect(amountOnDay(200, fixed, '2026-10-10', '2026-12-01')).toBe(200);
  });

  it('a future month still counts the discount, from today', () => {
    expect(amountOnDay(200, fixed, '2027-02-10', '2026-12-01')).toBe(175);
  });

  it('a short month with limit 31 holds the discount until its last day', () => {
    const last = { day: 31, type: 'FIXED', value: 25 } as const;
    expect(amountOnDay(200, last, '2027-02-28', '2027-02-28')).toBe(175);
    expect(amountOnDay(200, last, '2027-04-30', '2027-04-30')).toBe(175);
    expect(amountOnDay(200, last, '2027-04-30', '2027-05-01')).toBe(200);
  });

  it('without a discount it is the amount, whatever the day', () => {
    expect(amountOnDay(200, null, occurrence, '2026-12-01')).toBe(200);
  });

  it('a discount that would leave zero or less, or no saving, is ignored for the amount', () => {
    expect(amountOnDay(20, { day: 8, type: 'FIXED', value: 25 }, occurrence, '2026-12-01')).toBe(20);
    expect(amountOnDay(25, { day: 8, type: 'FIXED', value: 25 }, occurrence, '2026-12-01')).toBe(25);
  });
});

describe('earlyDiscountQuote', () => {
  it('gives the data the screens need while the discount can still be had', () => {
    expect(earlyDiscountQuote(200, fixed, '2026-12-10', '2026-12-05')).toEqual({
      limitDate: '2026-12-08',
      fullAmount: 200,
      discountedAmount: 175,
      savings: 25,
    });
    expect(earlyDiscountQuote(123.45, percent, '2026-12-10', '2026-12-08')).toEqual({
      limitDate: '2026-12-08',
      fullAmount: 123.45,
      discountedAmount: 113.58,
      savings: 9.87,
    });
  });

  it('is null after the limit, without a discount, or for an invalid one', () => {
    expect(earlyDiscountQuote(200, fixed, '2026-12-10', '2026-12-09')).toBeNull();
    expect(earlyDiscountQuote(200, null, '2026-12-10', '2026-12-05')).toBeNull();
    expect(earlyDiscountQuote(20, fixed, '2026-12-10', '2026-12-05')).toBeNull();
  });
});

describe('earlyDiscountOf (stored row)', () => {
  it('reads the three columns, decimals included', () => {
    expect(earlyDiscountOf({ earlyDiscountDay: 8, earlyDiscountType: 'PERCENT', earlyDiscountValue: { toNumber: () => 8 } })).toEqual(percent);
  });

  it('is null when any column is missing (a recurrence without discount)', () => {
    expect(earlyDiscountOf({})).toBeNull();
    expect(earlyDiscountOf({ earlyDiscountDay: null, earlyDiscountType: null, earlyDiscountValue: null })).toBeNull();
    expect(earlyDiscountOf({ earlyDiscountDay: 8, earlyDiscountType: null, earlyDiscountValue: null })).toBeNull();
  });
});

describe('validateEarlyDiscount', () => {
  const ok = { day: 8, type: 'FIXED', value: 25, amount: 200 } as const;

  it('accepts a coherent discount', () => {
    expect(validateEarlyDiscount(ok)).toBeNull();
    expect(validateEarlyDiscount({ ...ok, type: 'PERCENT', value: 8 })).toBeNull();
  });

  it('refuses a day outside 1..31', () => {
    expect(validateEarlyDiscount({ ...ok, day: 0 })).toMatch(/day/i);
    expect(validateEarlyDiscount({ ...ok, day: 32 })).toMatch(/day/i);
    expect(validateEarlyDiscount({ ...ok, day: 8.5 })).toMatch(/day/i);
  });

  it('a fixed discount must be above zero and below the amount (never leaves zero or less)', () => {
    expect(validateEarlyDiscount({ ...ok, value: 0 })).toMatch(/greater than zero/i);
    expect(validateEarlyDiscount({ ...ok, value: -5 })).toMatch(/greater than zero/i);
    expect(validateEarlyDiscount({ ...ok, value: 200 })).toMatch(/less than the amount/i);
    expect(validateEarlyDiscount({ ...ok, value: 250 })).toMatch(/less than the amount/i);
    expect(validateEarlyDiscount({ ...ok, value: 199.99 })).toBeNull();
  });

  it('a percentage must be above 0 and below 100', () => {
    expect(validateEarlyDiscount({ ...ok, type: 'PERCENT', value: 0 })).toMatch(/between 0 and 100/i);
    expect(validateEarlyDiscount({ ...ok, type: 'PERCENT', value: 100 })).toMatch(/between 0 and 100/i);
    expect(validateEarlyDiscount({ ...ok, type: 'PERCENT', value: 120 })).toMatch(/between 0 and 100/i);
    expect(validateEarlyDiscount({ ...ok, type: 'PERCENT', value: 99.99 })).toBeNull();
  });

  it('refuses a percentage whose rounded result is no cheaper than the amount', () => {
    // 0.01% of 10.00 = 9.999 -> rounded up 10.00: no saving
    expect(validateEarlyDiscount({ day: 8, type: 'PERCENT', value: 0.01, amount: 10 })).toMatch(/saving|less/i);
  });

  it('needs a positive amount', () => {
    expect(validateEarlyDiscount({ ...ok, amount: 0 })).toMatch(/amount/i);
    expect(validateEarlyDiscount({ ...ok, amount: -200 })).toMatch(/amount/i);
  });
});
