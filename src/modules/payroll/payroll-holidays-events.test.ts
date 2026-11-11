import { describe, expect, it } from 'vitest';

import { DEFAULT_PAYROLL_METHOD } from './payroll-calc.js';
import { buildPayrollEvents, extraPayrollEvents, vacationCashDate, type EmploymentData } from './payroll-events.js';
import type { HolidayConfig } from './payroll-holidays.js';

// Invented data only.
const SE_ARACAJU: HolidayConfig = { uf: 'SE', city: 'Aracaju', optionalOff: true };
const base = (over: Partial<EmploymentData> = {}): EmploymentData => ({
  employmentId: 'emp-1',
  admissionDate: '2026-01-01',
  dependents: 0,
  payDay: 5,
  method: DEFAULT_PAYROLL_METHOD,
  thirteenth: { first: { month: 6, day: 30 }, second: { month: 12, day: 20 } },
  salaries: [{ startDate: '2026-01-01', amountCents: 300000 }],
  items: [],
  vacations: [],
  fgts: {
    balance: { asOfDate: '2026-03-31', amountCents: 600000 },
    withdrawals: [],
    modes: [{ startDate: '2026-01-01', mode: 'birthday', birthdayMonth: 5 }],
  },
  ...over,
});
const range = { from: '2026-04-01', to: '2026-12-31', today: '2026-04-01' };

describe('holidays in the FGTS birthday withdrawal (5th business day)', () => {
  it('without a calendar the 5th business day is the one of the weekdays (7 May 2026), as before', () => {
    expect(buildPayrollEvents(base(), range).birthdayWithdrawals[0]!.date).toBe('2026-05-07');
    expect(buildPayrollEvents(base({ calendar: null }), range).birthdayWithdrawals[0]!.date).toBe('2026-05-07');
    expect(buildPayrollEvents(base({ calendar: { uf: null, city: 'Aracaju' } }), range).birthdayWithdrawals[0]!.date).toBe('2026-05-07');
  });

  it('with the calendar 1 May is a holiday and the withdrawal moves to the 8th, with the same amount', () => {
    const plain = buildPayrollEvents(base(), range).birthdayWithdrawals[0]!;
    const withCalendar = buildPayrollEvents(base({ calendar: SE_ARACAJU }), range).birthdayWithdrawals[0]!;
    expect(withCalendar.date).toBe('2026-05-08');
    expect(withCalendar.amountCents).toBe(plain.amountCents);
    const extra = extraPayrollEvents(base({ calendar: SE_ARACAJU }), range).find((e) => e.kind === 'fgts_birthday');
    expect(extra!.date).toBe('2026-05-08');
  });

  it('a municipal holiday also counts: birthday in March puts the 5th business day after 17 March', () => {
    const data = (calendar: HolidayConfig | null) =>
      base({ calendar, fgts: { balance: null, withdrawals: [], modes: [{ startDate: '2026-01-01', mode: 'birthday', birthdayMonth: 3, expectedAmountCents: 50000 }] } });
    const r = { from: '2026-01-01', to: '2026-12-31', today: '2026-01-01' };
    expect(buildPayrollEvents(data(null), r).birthdayWithdrawals[0]!.date).toBe('2026-03-06'); // 2, 3, 4, 5, 6
    expect(buildPayrollEvents(data(SE_ARACAJU), r).birthdayWithdrawals[0]!.date).toBe('2026-03-06'); // the 17th is after it: unchanged
    // September: the 7th is a national holiday
    const sep = (calendar: HolidayConfig | null) =>
      base({ calendar, fgts: { balance: null, withdrawals: [], modes: [{ startDate: '2026-01-01', mode: 'birthday', birthdayMonth: 9, expectedAmountCents: 50000 }] } });
    expect(buildPayrollEvents(sep(null), r).birthdayWithdrawals[0]!.date).toBe('2026-09-07');
    expect(buildPayrollEvents(sep(SE_ARACAJU), r).birthdayWithdrawals[0]!.date).toBe('2026-09-08');
  });
});

describe('holidays in the vacation payment', () => {
  it('without a calendar only weekends move the payment back', () => {
    expect(vacationCashDate('2026-09-09')).toBe('2026-09-07'); // 7 Sep is a Monday
    expect(vacationCashDate('2026-09-09', null)).toBe('2026-09-07');
    expect(vacationCashDate('2026-04-06')).toBe('2026-04-03'); // Saturday 4th -> Friday 3rd
  });

  it('with the calendar a holiday moves it back too', () => {
    expect(vacationCashDate('2026-09-09', SE_ARACAJU)).toBe('2026-09-04'); // Monday 7th is a holiday: Friday 4th
    expect(vacationCashDate('2026-04-06', SE_ARACAJU)).toBe('2026-04-02'); // Saturday, then Good Friday: Thursday
    expect(vacationCashDate('2026-09-14', SE_ARACAJU)).toBe('2026-09-11'); // a normal weekday stays
  });

  it('the vacation event carries the moved payment date', () => {
    const data = (calendar: HolidayConfig | null) => base({ calendar, vacations: [{ id: 'v1', start: '2026-09-09', days: 20, sellDays: 0, items: [] }] });
    const r = { from: '2026-08-01', to: '2026-09-30', today: '2026-08-01' };
    expect(buildPayrollEvents(data(null), r).vacations[0]!.paymentDate).toBe('2026-09-07');
    expect(buildPayrollEvents(data(SE_ARACAJU), r).vacations[0]!.paymentDate).toBe('2026-09-04');
  });
});

describe('an employment without uf behaves exactly as before the calendar', () => {
  it('the whole event set is identical with the calendar absent, null or without a uf', () => {
    const full = (calendar: HolidayConfig | null | undefined) =>
      base({ calendar, vacations: [{ id: 'v1', start: '2026-09-09', days: 20, sellDays: 0, items: [] }] });
    const r = { from: '2026-01-01', to: '2027-06-30', today: '2026-01-01' };
    const absent = buildPayrollEvents(full(undefined), r);
    expect(buildPayrollEvents(full(null), r)).toEqual(absent);
    expect(buildPayrollEvents(full({ uf: null, city: 'Aracaju', optionalOff: true }), r)).toEqual(absent);
    expect(extraPayrollEvents(full(null), r)).toEqual(extraPayrollEvents(full(undefined), r));
  });
});
