import { describe, expect, it } from 'vitest';

import { computeMonthlyPayroll, type PayrollItem } from './payroll-calc.js';
import { computeThirteenth, countThirteenthAvos } from './payroll-thirteenth.js';
import { computeVacation, resolveVacationPeriod, vacationDaysInMonth, workedDaysWithVacation } from './payroll-vacation.js';

// Invented data only. Cents.

describe('countThirteenthAvos', () => {
  it('counts months with 15 days or more', () => {
    expect(countThirteenthAvos('2025-01-01', 2026)).toBe(12);
    expect(countThirteenthAvos('2026-03-10', 2026)).toBe(10); // March 10-31 = 22 days
    expect(countThirteenthAvos('2026-03-17', 2026)).toBe(10); // March 17-31 = 15 days: counts
    expect(countThirteenthAvos('2026-03-18', 2026)).toBe(9); // 14 days: does not
    expect(countThirteenthAvos('2026-12-20', 2026)).toBe(0);
    expect(countThirteenthAvos('2027-01-05', 2026)).toBe(0);
  });

  it('closes the count at a termination date', () => {
    expect(countThirteenthAvos('2024-01-01', 2026, '2026-06-14')).toBe(5);
    expect(countThirteenthAvos('2024-01-01', 2026, '2026-06-15')).toBe(6);
    expect(countThirteenthAvos('2024-01-01', 2026, '2025-12-31')).toBe(0);
  });

  it('handles February in a leap year', () => {
    expect(countThirteenthAvos('2028-02-15', 2028)).toBe(11); // 15 days of 29
    expect(countThirteenthAvos('2027-02-15', 2027)).toBe(10); // 14 days of 28
  });
});

describe('computeThirteenth', () => {
  it('splits in two installments, taxes on the whole amount deducted from the second', () => {
    const t = computeThirteenth({ year: 2026, grossCents: 400000, avos: 12 });
    expect(t.tables).toEqual({ inss: 'inss-2026', irrf: 'irrf-2026-01', fgts: 'fgts-8' });
    expect(t.totalCents).toBe(400000);
    expect(t.first).toEqual({ date: '2026-06-30', amountCents: 200000 });
    expect(t.inssCents).toBe(36859);
    expect(t.irrfCents).toBe(0);
    expect(t.second).toEqual({ date: '2026-12-20', grossCents: 200000, inssCents: 36859, irrfCents: 0, netCents: 163141 });
    expect(t.netCents).toBe(363141);
    expect(t.fgtsCents).toBe(32000);
  });

  it('is proportional to the avos', () => {
    const t = computeThirteenth({ year: 2026, grossCents: 400001, avos: 7 });
    expect(t.totalCents).toBe(233333);
    expect(t.first.amountCents).toBe(116666);
    expect(t.second.grossCents).toBe(116667);
    expect(computeThirteenth({ year: 2026, grossCents: 400001, avos: 7, method: { bracket: 'deduction', rounding: 'round' } }).totalCents).toBe(
      233334,
    );
    expect(computeThirteenth({ year: 2026, grossCents: 400000, avos: 0 }).netCents).toBe(0);
  });

  it('lets the month and day of each installment be configured', () => {
    const t = computeThirteenth({ year: 2026, grossCents: 400000, avos: 12, first: { month: 11, day: 31 }, second: { month: 12, day: 15 } });
    expect(t.first.date).toBe('2026-11-30');
    expect(t.second.date).toBe('2026-12-15');
  });

  it('charges INSS and IRRF on the whole 13th, separately from the salary', () => {
    const t = computeThirteenth({ year: 2026, grossCents: 1000000, avos: 12 });
    expect(t.inssCents).toBe(98807); // capped at the ceiling
    expect(t.irrfCents).toBe(156955);
    expect(t.second.netCents).toBe(244238);
    expect(t.netCents).toBe(744238);
  });

  it('applies the reducer to the 13th too', () => {
    const t = computeThirteenth({ year: 2026, grossCents: 600000, avos: 12 });
    expect(t.irrfCents).toBe(38510);
  });

  it('warns when the second installment falls beyond the INSS table', () => {
    const t = computeThirteenth({ year: 2027, grossCents: 400000, avos: 12 });
    expect(t.warnings).toEqual([{ code: 'projection_old_table', tax: 'inss', tableId: 'inss-2026' }]);
  });

  it('rejects bad input', () => {
    expect(() => computeThirteenth({ year: 2026, grossCents: 400000, avos: 13 })).toThrow();
    expect(() => computeThirteenth({ year: 2026, grossCents: 400000.5, avos: 12 })).toThrow();
  });
});

describe('resolveVacationPeriod', () => {
  it('assumes 30 days from day 1 and marks the period as estimated when only the month is known', () => {
    expect(resolveVacationPeriod({ month: '2027-01' })).toEqual({ start: '2027-01-01', end: '2027-01-30', days: 30, estimated: true });
  });

  it('uses the given dates and takes the sold days off the default length', () => {
    expect(resolveVacationPeriod({ start: '2027-03-10', sellDays: 10 })).toEqual({
      start: '2027-03-10',
      end: '2027-03-29',
      days: 20,
      estimated: false,
    });
    expect(resolveVacationPeriod({ start: '2027-02-20', days: 14 }).end).toBe('2027-03-05');
  });

  it('validates days and sold days', () => {
    expect(() => resolveVacationPeriod({})).toThrow();
    expect(() => resolveVacationPeriod({ start: '2027-03-10', sellDays: 11 })).toThrow();
    expect(() => resolveVacationPeriod({ start: '2027-03-10', days: 25, sellDays: 10 })).toThrow();
    expect(() => resolveVacationPeriod({ start: '2027-03-10', days: 0 })).toThrow();
  });
});

describe('computeVacation', () => {
  it('pays the days plus a third, taxes on the total, two days before the start', () => {
    const v = computeVacation({ grossCents: 300000, start: '2027-01-05' });
    expect(v.paymentDate).toBe('2027-01-03');
    expect(v.vacationCents).toBe(300000);
    expect(v.thirdCents).toBe(100000);
    expect(v.bases.inssCents).toBe(400000);
    expect(v.inssCents).toBe(36859);
    expect(v.irrfCents).toBe(0);
    expect(v.netCents).toBe(363141);
    expect(v.fgtsCents).toBe(32000);
    expect(v.estimated).toBe(false);
  });

  it('with only the month: estimated, paid in the last days of the previous month', () => {
    const v = computeVacation({ grossCents: 300000, month: '2027-01' });
    expect(v.estimated).toBe(true);
    expect(v.period).toMatchObject({ start: '2027-01-01', end: '2027-01-30', days: 30 });
    expect(v.paymentDate).toBe('2026-12-30');
    expect(v.tables.inss).toBe('inss-2026');
    expect(v.warnings).toEqual([]);
  });

  it('with abono: the sold days are paid with a third, outside every tax and the FGTS', () => {
    const v = computeVacation({ grossCents: 300000, start: '2026-08-03', sellDays: 10 });
    expect(v.period.days).toBe(20);
    expect(v.vacationCents).toBe(200000);
    expect(v.thirdCents).toBe(66666);
    expect(v.abonoCents).toBe(100000);
    expect(v.abonoThirdCents).toBe(33333);
    expect(v.bases.inssCents).toBe(266666);
    expect(v.inssCents).toBe(21567);
    expect(v.irrfCents).toBe(0);
    expect(v.fgtsCents).toBe(21333);
    expect(v.netCents).toBe(378432);
  });

  it('takes one-off earnings (advance of a raise) into the bases', () => {
    const advance: PayrollItem = {
      label: 'Advance',
      amountCents: 12000,
      kind: 'earning',
      inInssBase: true,
      inIrrfBase: true,
      inFgtsBase: true,
    };
    const advanceThird: PayrollItem = { ...advance, label: 'Advance third', amountCents: 4000 };
    const v = computeVacation({ grossCents: 300000, start: '2026-08-03', items: [advance, advanceThird] });
    expect(v.extraEarningsCents).toBe(16000);
    expect(v.bases.inssCents).toBe(416000);
    expect(v.inssCents).toBe(38779);
    expect(v.irrfCents).toBe(0);
    expect(v.netCents).toBe(377221);
  });

  it('uses the tables of the payment day and warns past the INSS table', () => {
    const v = computeVacation({ grossCents: 300000, start: '2027-03-01' });
    expect(v.paymentDate).toBe('2027-02-27');
    expect(v.warnings).toEqual([{ code: 'projection_old_table', tax: 'inss', tableId: 'inss-2026' }]);
  });

  it('taxes a large vacation with the progressive table', () => {
    const v = computeVacation({ grossCents: 900000, start: '2026-08-03' });
    expect(v.bases.inssCents).toBe(847555); // 1,200,000 capped
    expect(v.inssCents).toBe(98807);
    expect(v.irrfCents).toBeGreaterThan(0);
  });
});

describe('month after the vacation', () => {
  const period = { start: '2027-01-20', end: '2027-02-18' };

  it('counts the vacation days inside each month', () => {
    expect(vacationDaysInMonth(period, '2027-01')).toBe(12);
    expect(vacationDaysInMonth(period, '2027-02')).toBe(18);
    expect(vacationDaysInMonth(period, '2027-03')).toBe(0);
    expect(vacationDaysInMonth(period, '2026-12')).toBe(0);
  });

  it('pays fewer days in the months the vacation touches', () => {
    expect(workedDaysWithVacation(period, '2027-01')).toBe(18);
    expect(workedDaysWithVacation(period, '2027-02')).toBe(12);
    expect(workedDaysWithVacation(period, '2027-03')).toBe(30);
    expect(workedDaysWithVacation({ start: '2027-01-01', end: '2027-01-30' }, '2027-01')).toBe(0);
    expect(workedDaysWithVacation({ start: '2027-01-01', end: '2027-01-30' }, '2027-02')).toBe(30);
  });

  it('feeds the monthly calculation with the lower salary', () => {
    const full = computeMonthlyPayroll({ date: '2027-02-05', grossCents: 300000 });
    const less = computeMonthlyPayroll({ date: '2027-02-05', grossCents: 300000, workedDays: workedDaysWithVacation(period, '2027-01') });
    expect(less.salaryCents).toBe(180000);
    expect(less.netCents).toBeLessThan(full.netCents);
  });
});
