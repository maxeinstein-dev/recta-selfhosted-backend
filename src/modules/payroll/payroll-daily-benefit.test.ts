import { describe, expect, it } from 'vitest';

import { benefitPaymentDate, computeDailyBenefit, type DailyBenefitData } from './payroll-daily-benefit.js';
import { DEFAULT_PAYROLL_METHOD } from './payroll-calc.js';
import { benefitEvents, benefitPaidInMonth, buildPayrollEvents, fixedItemsAt, type EmploymentData } from './payroll-events.js';
import type { HolidayConfig } from './payroll-holidays.js';

// Invented data only. Cents. Weekdays of 2026: Feb 20, Mar 22, Apr 22, May 21, Jun 22, Jul 23, Aug 21, Sep 22, Oct 22, Nov 21, Dec 23.
const RATE = 1250;
const SE_ARACAJU: HolidayConfig = { uf: 'SE', city: 'Aracaju', optionalOff: true };

const benefit = (over: Partial<DailyBenefitData> = {}): DailyBenefitData => ({
  id: 'meal',
  name: 'Meal voucher',
  values: [{ startDate: '2026-01-01', amountCents: RATE }],
  payDay: 25,
  referenceMonthOffset: 1,
  accountId: null,
  isAvailableCash: true,
  recurringTransactionId: null,
  recurrenceActive: false,
  marginDays: 0,
  ...over,
});
const ctx = (over: Record<string, unknown> = {}) => ({ admissionDate: '2025-01-10', endDate: null, calendar: SE_ARACAJU, vacations: [], ...over });
const compute = (month: string, b = benefit(), c = ctx()) => computeDailyBenefit(b, month, c)!;

describe('days counted in the reference month', () => {
  it('a month without holidays counts every weekday (August 2026)', () => {
    const e = compute('2026-08');
    expect(e).toMatchObject({ weekdays: 21, holidayDays: 0, vacationDays: 0, marginDays: 0, countedDays: 21, amountCents: 21 * RATE, estimated: true });
  });

  it('national holiday: 7 September takes one day off', () => {
    const e = compute('2026-09');
    expect(e).toMatchObject({ weekdays: 22, holidayDays: 1, countedDays: 21 });
    expect(e.holidays).toEqual([{ date: '2026-09-07', name: 'Independência do Brasil', level: 'national', optional: false }]);
  });

  it('state holiday: 8 July (Sergipe) takes one day off, and not for an employment of another state', () => {
    expect(compute('2026-07')).toMatchObject({ weekdays: 23, holidayDays: 1, countedDays: 22 });
    expect(compute('2026-07', benefit(), ctx({ calendar: { uf: 'BA', optionalOff: true } }))).toMatchObject({ holidayDays: 0, countedDays: 23 });
  });

  it('municipal holiday: 17 March (Aracaju) takes one day off, and not without the city', () => {
    expect(compute('2026-03')).toMatchObject({ weekdays: 22, holidayDays: 1, countedDays: 21 });
    expect(compute('2026-03', benefit(), ctx({ calendar: { uf: 'SE', optionalOff: true } }))).toMatchObject({ holidayDays: 0, countedDays: 22 });
  });

  it('optional days (carnival; Corpus Christi + São João) follow the employment choice', () => {
    expect(compute('2026-02')).toMatchObject({ weekdays: 20, holidayDays: 2, countedDays: 18 });
    expect(compute('2026-06')).toMatchObject({ weekdays: 22, holidayDays: 2, countedDays: 20 });
    const strict = ctx({ calendar: { ...SE_ARACAJU, optionalOff: false } });
    expect(compute('2026-02', benefit(), strict)).toMatchObject({ holidayDays: 0, countedDays: 20 });
    // Corpus Christi (optional) no longer counts, São João (municipal) still does
    expect(compute('2026-06', benefit(), strict)).toMatchObject({ holidayDays: 1, countedDays: 21 });
  });

  it('a holiday on a weekend takes nothing off (15 November 2026 is a Sunday)', () => {
    expect(compute('2026-11')).toMatchObject({ weekdays: 21, holidayDays: 2, countedDays: 19 }); // Nov 2 and Nov 20 only
  });

  it('an unconfirmed holiday (8 December in Aracaju) is not taken off and raises a warning', () => {
    const e = compute('2026-12');
    expect(e).toMatchObject({ weekdays: 23, holidayDays: 1, countedDays: 22 }); // 25/12 only
    expect(e.warnings).toEqual([expect.objectContaining({ code: 'unconfirmed_holiday', date: '2026-12-08' })]);
  });

  it('without a calendar only weekends are off (the behaviour before the calendar existed)', () => {
    expect(compute('2026-09', benefit(), ctx({ calendar: null }))).toMatchObject({ weekdays: 22, holidayDays: 0, countedDays: 22 });
    expect(compute('2026-09', benefit(), ctx({ calendar: undefined }))).toMatchObject({ countedDays: 22 });
  });

  it('a uf or city without a table is reported as a warning, and only the national holidays count', () => {
    const e = compute('2026-07', benefit(), ctx({ calendar: { uf: 'SE', city: 'Lagarto', optionalOff: true } }));
    expect(e.warnings.map((w) => w.code)).toEqual(['no_city_table']);
    expect(e.holidayDays).toBe(1); // 8 July is a state holiday of Sergipe
    const ba = compute('2026-07', benefit(), ctx({ calendar: { uf: 'BA', optionalOff: true } }));
    expect(ba.warnings.map((w) => w.code)).toEqual(['no_state_table']);
  });

  it('vacation days are taken off by business day, not by calendar day', () => {
    // Sep 14-23 (10 days): business days 14..18 and 21..23 = 8; plus the holiday of the 7th
    const e = compute('2026-09', benefit(), ctx({ vacations: [{ start: '2026-09-14', end: '2026-09-23' }] }));
    expect(e).toMatchObject({ weekdays: 22, holidayDays: 1, vacationDays: 8, countedDays: 13 });
  });

  it('a vacation over a holiday does not take the holiday off twice; overlapping vacations count a day once', () => {
    const e = compute('2026-09', benefit(), ctx({ vacations: [{ start: '2026-09-01', end: '2026-09-09' }, { start: '2026-09-08', end: '2026-09-10' }] }));
    // weekdays Sep 1-4, 7 (holiday), 8-10 -> vacation business days: 1,2,3,4,8,9,10 = 7
    expect(e).toMatchObject({ holidayDays: 1, vacationDays: 7, countedDays: 14 });
  });

  it('a month-only vacation covers the whole month', () => {
    // Jan 2027: 21 weekdays, 1 January is a holiday, the 30 days from day 1 (to Saturday the 30th) cover the other 20
    const e = compute('2027-01', benefit(), ctx({ vacations: [{ start: '2027-01-01', end: '2027-01-30' }] }));
    expect(e).toMatchObject({ weekdays: 21, holidayDays: 1, vacationDays: 20, countedDays: 0, amountCents: 0 });
  });

  it('the margin comes off the count and never makes it negative', () => {
    expect(compute('2026-08', benefit({ marginDays: 2 }))).toMatchObject({ marginDays: 2, countedDays: 19, amountCents: 19 * RATE });
    const huge = compute('2026-08', benefit({ marginDays: 40 }));
    expect(huge).toMatchObject({ countedDays: 0, amountCents: 0 });
    // margin and vacation together also stop at zero
    expect(compute('2026-09', benefit({ marginDays: 30 }), ctx({ vacations: [{ start: '2026-09-14', end: '2026-09-23' }] })).amountCents).toBe(0);
  });

  it('the employment window limits the days: admission in the middle of the month and an end date', () => {
    // Sep 16 to 30: 16,17,18,21..25,28,29,30 = 11 weekdays
    expect(compute('2026-09', benefit(), ctx({ admissionDate: '2026-09-16' }))).toMatchObject({ weekdays: 11, countedDays: 11 });
    // up to Sep 10: 1..4, 8, 9, 10 (7th is a holiday) -> 8 weekdays, 7 counted
    expect(compute('2026-09', benefit(), ctx({ endDate: '2026-09-10' }))).toMatchObject({ weekdays: 8, holidayDays: 1, countedDays: 7 });
    expect(computeDailyBenefit(benefit(), '2026-10', ctx({ endDate: '2026-09-10' }))).toBeNull();
    expect(computeDailyBenefit(benefit(), '2026-08', ctx({ admissionDate: '2026-09-16' }))).toBeNull();
  });
});

describe('value history', () => {
  const raise = benefit({ values: [{ startDate: '2025-01-01', amountCents: 1000 }, { startDate: '2026-07-01', amountCents: 1100 }] });

  it('a new value applies from the month it starts; earlier months do not change', () => {
    expect(compute('2026-06', raise).ratePerDayCents).toBe(1000);
    expect(compute('2026-07', raise).ratePerDayCents).toBe(1100);
    expect(compute('2026-07', raise).amountCents).toBe(22 * 1100);
    expect(compute('2026-06', raise).amountCents).toBe(20 * 1000);
    expect(compute('2025-03', raise).ratePerDayCents).toBe(1000);
  });

  it('a value that starts in the middle of a month takes effect in the next month', () => {
    const mid = benefit({ values: [{ startDate: '2026-01-01', amountCents: 1000 }, { startDate: '2026-07-15', amountCents: 1100 }] });
    expect(compute('2026-07', mid).ratePerDayCents).toBe(1000);
    expect(compute('2026-08', mid).ratePerDayCents).toBe(1100);
  });

  it('no value in force yet: no event', () => {
    expect(computeDailyBenefit(benefit({ values: [{ startDate: '2027-01-01', amountCents: 1000 }] }), '2026-08', ctx())).toBeNull();
    expect(computeDailyBenefit(benefit({ values: [] }), '2026-08', ctx())).toBeNull();
  });
});

describe('reference month and payment date', () => {
  it('paid on the 25th for the next month', () => {
    expect(benefitPaymentDate(benefit(), '2026-12')).toBe('2026-11-25');
    expect(compute('2026-12').paymentDate).toBe('2026-11-25');
    expect(benefitPaymentDate(benefit(), '2026-01')).toBe('2025-12-25'); // across the year
  });

  it('offset 0 pays in the month itself; offset -1 pays the month after the one it refers to; the pay day is clamped', () => {
    expect(benefitPaymentDate(benefit({ referenceMonthOffset: 0, payDay: 10 }), '2026-08')).toBe('2026-08-10');
    expect(benefitPaymentDate(benefit({ referenceMonthOffset: -1, payDay: 5 }), '2026-08')).toBe('2026-09-05');
    expect(benefitPaymentDate(benefit({ referenceMonthOffset: 0, payDay: 31 }), '2026-02')).toBe('2026-02-28');
  });

  it('the benefit paid in a month is the one of the following reference month', () => {
    const data = base({ benefits: [benefit()] });
    const paidInNov = benefitPaidInMonth(data, benefit(), '2026-11')!;
    expect(paidInNov).toMatchObject({ referenceMonth: '2026-12', paymentDate: '2026-11-25' });
    expect(paidInNov.countedDays).toBe(22);
  });
});

function base(over: Partial<EmploymentData> = {}): EmploymentData {
  return {
    employmentId: 'emp-1',
    admissionDate: '2025-01-10',
    dependents: 0,
    payDay: 5,
    method: DEFAULT_PAYROLL_METHOD,
    thirteenth: { first: { month: 6, day: 30 }, second: { month: 12, day: 20 } },
    salaries: [{ startDate: '2025-01-10', amountCents: 400000 }],
    items: [],
    vacations: [],
    fgts: { balance: null, withdrawals: [] },
    calendar: SE_ARACAJU,
    ...over,
  };
}

describe('inside an employment', () => {
  it('uses the marked vacations of the employment', () => {
    const data = base({ benefits: [benefit()], vacations: [{ id: 'v', start: '2026-09-14', days: 10, sellDays: 0, items: [] }] });
    expect(benefitPaidInMonth(data, benefit(), '2026-08')).toMatchObject({ referenceMonth: '2026-09', vacationDays: 8, countedDays: 13 });
  });

  it('lists by payment date inside the period, with the benefit not filtered by today', () => {
    const data = base({ benefits: [benefit()] });
    const list = benefitEvents(data, '2026-09-01', '2026-12-31');
    expect(list.map((e) => [e.paymentDate, e.referenceMonth, e.countedDays])).toEqual([
      ['2026-09-25', '2026-10', 21], // 12 October is a holiday
      ['2026-10-25', '2026-11', 19], // 2 and 20 November
      ['2026-11-25', '2026-12', 22], // 25 December; 8 December is not confirmed
      ['2026-12-25', '2027-01', 20], // 1 January
    ]);
    expect(buildPayrollEvents(data, { from: '2026-09-01', to: '2026-12-31', today: '2026-12-01' }).benefits).toHaveLength(4);
    expect(benefitEvents(data, '2026-12-01', '2026-12-31').map((e) => [e.paymentDate, e.referenceMonth])).toEqual([['2026-12-25', '2027-01']]);
  });

  it('a benefit that is not available money still shows in the events, flagged', () => {
    const data = base({ benefits: [benefit({ isAvailableCash: false })] });
    const ev = buildPayrollEvents(data, { from: '2026-09-01', to: '2026-10-31' }).benefits;
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e) => e.isAvailableCash === false)).toBe(true);
  });

  it('stays out of the salary: the net, the bases and the FGTS are the same with or without the benefit', () => {
    const without = buildPayrollEvents(base(), { from: '2026-09-01', to: '2026-12-31' });
    const withBenefit = buildPayrollEvents(base({ benefits: [benefit()] }), { from: '2026-09-01', to: '2026-12-31' });
    expect(withBenefit.salary).toEqual(without.salary);
    expect(withBenefit.thirteenth).toEqual(without.thirteenth);
    expect(withBenefit.fgts).toEqual(without.fgts);
    expect(fixedItemsAt(base({ benefits: [benefit()] }).items, '2026-09-30')).toEqual([]);
  });
});
