import { describe, expect, it } from 'vitest';

import { computeMonthlyPayroll, DEFAULT_PAYROLL_METHOD } from './payroll-calc.js';
import { nthBusinessDay, previousBusinessDay, weekdayOf } from './payroll-dates.js';
import {
  buildPayrollEvents,
  computeCompetence,
  extraPayrollEvents,
  fixedItemsAt,
  paymentDateOfCompetence,
  salaryPaidInMonth,
  vacationCashDate,
  valueInForce,
  type EmploymentData,
} from './payroll-events.js';

// Invented data only.
const base = (over: Partial<EmploymentData> = {}): EmploymentData => ({
  employmentId: 'emp-1',
  admissionDate: '2025-02-10',
  dependents: 0,
  payDay: 5,
  method: DEFAULT_PAYROLL_METHOD,
  thirteenth: { first: { month: 6, day: 30 }, second: { month: 12, day: 20 } },
  salaries: [{ startDate: '2025-02-10', amountCents: 400000 }],
  items: [],
  vacations: [],
  fgts: { balance: null, withdrawals: [] },
  ...over,
});

describe('dates', () => {
  it('weekends move back to Friday, weekdays stay', () => {
    expect(weekdayOf('2026-08-01')).toBe(6);
    expect(previousBusinessDay('2026-08-01')).toBe('2026-07-31'); // Saturday
    expect(previousBusinessDay('2026-08-02')).toBe('2026-07-31'); // Sunday
    expect(previousBusinessDay('2026-08-03')).toBe('2026-08-03'); // Monday
    expect(previousBusinessDay('2026-07-31')).toBe('2026-07-31'); // Friday
  });

  it('vacation cash date: two days before the start, then back to a weekday', () => {
    expect(vacationCashDate('2026-08-03')).toBe('2026-07-31'); // start Monday: -2 is Saturday
    expect(vacationCashDate('2026-08-04')).toBe('2026-07-31'); // start Tuesday: -2 is Sunday
    expect(vacationCashDate('2026-08-05')).toBe('2026-08-03'); // start Wednesday: -2 is Monday
    expect(vacationCashDate('2027-01-01')).toBe('2026-12-30'); // crosses the year
  });

  it('the salary of a competence month is paid on the pay day of the next month', () => {
    expect(paymentDateOfCompetence('2026-03', 5)).toBe('2026-04-05');
    expect(paymentDateOfCompetence('2026-12', 5)).toBe('2027-01-05');
    expect(paymentDateOfCompetence('2026-01', 31)).toBe('2026-02-28');
  });
});

describe('nth business day', () => {
  it('month starting on a Saturday: the first business day is the Monday', () => {
    expect(weekdayOf('2026-08-01')).toBe(6);
    expect(nthBusinessDay('2026-08', 1)).toBe('2026-08-03');
    expect(nthBusinessDay('2026-08', 5)).toBe('2026-08-07');
  });
  it('month starting on a Sunday', () => {
    expect(weekdayOf('2026-02-01')).toBe(0);
    expect(nthBusinessDay('2026-02', 1)).toBe('2026-02-02');
    expect(nthBusinessDay('2026-02', 5)).toBe('2026-02-06');
  });
  it('month starting on a Monday: the 5th is the Friday of the first week', () => {
    expect(weekdayOf('2026-06-01')).toBe(1);
    expect(nthBusinessDay('2026-06', 5)).toBe('2026-06-05');
  });
  it('month starting on a Friday skips the weekend', () => {
    expect(nthBusinessDay('2026-05', 5)).toBe('2026-05-07');
  });
  it('refuses a bad n or month', () => {
    expect(() => nthBusinessDay('2026-05', 0)).toThrow();
    expect(() => nthBusinessDay('2026-05', 21)).toThrow();
    expect(() => nthBusinessDay('2026/05', 1)).toThrow();
  });
});

describe('values in force', () => {
  it('picks the latest start not after the day', () => {
    const list = [
      { startDate: '2026-01-01', amountCents: 1 },
      { startDate: '2026-06-01', amountCents: 2 },
    ];
    expect(valueInForce(list, '2025-12-31')).toBeUndefined();
    expect(valueInForce(list, '2026-05-31')?.amountCents).toBe(1);
    expect(valueInForce(list, '2026-06-01')?.amountCents).toBe(2);
  });

  it('fixed items follow their own value history and drop out before the first value', () => {
    const items = [
      {
        id: 'i1',
        name: 'Allowance',
        kind: 'earning' as const,
        inInssBase: false,
        inIrrfBase: false,
        inFgtsBase: false,
        values: [
          { startDate: '2026-01-01', amountCents: 10000 },
          { startDate: '2026-07-01', amountCents: 12000 },
        ],
      },
    ];
    expect(fixedItemsAt(items, '2025-12-31')).toEqual([]);
    expect(fixedItemsAt(items, '2026-03-31')[0]!.amountCents).toBe(10000);
    expect(fixedItemsAt(items, '2026-07-31')[0]!.amountCents).toBe(12000);
  });
});

describe('monthly salary', () => {
  it('matches the direct calculation with the gross in force on the last day of the competence month', () => {
    const data = base({
      salaries: [
        { startDate: '2025-02-10', amountCents: 400000 },
        { startDate: '2026-05-20', amountCents: 450000 },
      ],
    });
    const april = computeCompetence(data, '2026-04')!;
    const may = computeCompetence(data, '2026-05')!;
    expect(april.grossCents).toBe(400000);
    expect(may.grossCents).toBe(450000);
    expect(april.paymentDate).toBe('2026-05-05');
    expect(april.netCents).toBe(computeMonthlyPayroll({ date: '2026-05-05', grossCents: 400000, workedDays: 30 }).netCents);
    expect(may.netCents).toBeGreaterThan(april.netCents);
  });

  it('is empty before the admission and when no salary is in force', () => {
    expect(computeCompetence(base(), '2025-01')).toBeNull();
    expect(computeCompetence(base({ salaries: [] }), '2026-01')).toBeNull();
  });

  it('prorates the admission month on the 30-day month', () => {
    const data = base({ admissionDate: '2026-03-16', salaries: [{ startDate: '2026-03-16', amountCents: 300000 }] });
    const first = computeCompetence(data, '2026-03')!;
    expect(first.workedDays).toBe(15);
    expect(first.payroll.salaryCents).toBe(150000);
    expect(computeCompetence(data, '2026-04')!.workedDays).toBe(30);
  });

  it('adds the fixed items in force to the net, outside the bases when so flagged', () => {
    const data = base({
      items: [
        {
          id: 'i1',
          name: 'Allowance',
          kind: 'earning',
          inInssBase: false,
          inIrrfBase: false,
          inFgtsBase: false,
          values: [{ startDate: '2025-02-10', amountCents: 15000 }],
        },
      ],
    });
    const withItem = computeCompetence(data, '2026-03')!;
    const without = computeCompetence(base(), '2026-03')!;
    expect(withItem.netCents - without.netCents).toBe(15000);
    expect(withItem.payroll.inssCents).toBe(without.payroll.inssCents);
  });

  it('a table projected past its validity marks the salary as estimated', () => {
    expect(computeCompetence(base(), '2026-03')!.estimated).toBe(false);
    expect(computeCompetence(base(), '2027-03')!.estimated).toBe(true);
  });

  it('salaryPaidInMonth reads the competence of the month before', () => {
    expect(salaryPaidInMonth(base(), '2026-04')!.competence).toBe('2026-03');
  });
});

describe('vacation', () => {
  const vacation = (over: Record<string, unknown> = {}) => ({ id: 'v1', sellDays: 0, items: [], ...over });

  it('a month-only marking is 30 days from day 1, estimated, and the salary of that competence falls to the items only', () => {
    const data = base({ vacations: [vacation({ month: '2027-01' })] });
    const ev = buildPayrollEvents(data, { from: '2026-12-01', to: '2027-02-28' });
    expect(ev.vacations).toHaveLength(1);
    const v = ev.vacations[0]!;
    expect(v.estimated).toBe(true);
    expect(v.period).toMatchObject({ start: '2027-01-01', end: '2027-01-30', days: 30, estimated: true });
    expect(v.paymentDate).toBe('2026-12-30');
    expect(v.netCents).toBeGreaterThan(0);
    // paid on Feb 5: competence January, 30 vacation days inside it
    const feb = ev.salary.find((s) => s.paymentDate === '2027-02-05')!;
    expect(feb.vacationDays).toBe(30);
    expect(feb.workedDays).toBe(0);
    expect(feb.netCents).toBe(0);
    const jan = ev.salary.find((s) => s.paymentDate === '2027-01-05')!;
    expect(jan.workedDays).toBe(30);
  });

  it('the pay date moves back from a weekend', () => {
    const data = base({ vacations: [vacation({ start: '2026-08-03' })] });
    const ev = buildPayrollEvents(data, { from: '2026-07-01', to: '2026-07-31' });
    expect(ev.vacations[0]!.paymentDate).toBe('2026-07-31');
    expect(ev.vacations[0]!.estimated).toBe(false);
  });

  it('a vacation paid before today is not forecast, but still reduces the salary of its month', () => {
    const data = base({ vacations: [vacation({ start: '2026-03-02' })] });
    const ev = buildPayrollEvents(data, { from: '2026-02-01', to: '2026-04-30', today: '2026-03-10' });
    expect(ev.vacations).toEqual([]);
    const april = ev.salary.find((s) => s.paymentDate === '2026-04-05')!;
    expect(april.vacationDays).toBe(30);
    expect(april.workedDays).toBe(0);
  });

  it('sold days leave the period shorter and add to the net', () => {
    const plain = buildPayrollEvents(base({ vacations: [vacation({ start: '2026-08-05' })] }), { from: '2026-07-01', to: '2026-08-31' });
    const sold = buildPayrollEvents(base({ vacations: [vacation({ start: '2026-08-05', sellDays: 10 })] }), { from: '2026-07-01', to: '2026-08-31' });
    expect(sold.vacations[0]!.period.days).toBe(20);
    expect(plain.vacations[0]!.period.days).toBe(30);
  });

  it('one-off lines paid with the vacation raise its net', () => {
    const extra = vacation({
      start: '2026-08-05',
      items: [{ label: 'Advance', amountCents: 10000, kind: 'earning', inInssBase: false, inIrrfBase: false, inFgtsBase: false }],
    });
    const a = buildPayrollEvents(base({ vacations: [vacation({ start: '2026-08-05' })] }), { from: '2026-07-01', to: '2026-08-31' });
    const b = buildPayrollEvents(base({ vacations: [extra] }), { from: '2026-07-01', to: '2026-08-31' });
    expect(b.vacations[0]!.netCents - a.vacations[0]!.netCents).toBe(10000);
  });
});

describe('13th salary', () => {
  it('defaults to June 30 and December 20; installments already past are not forecast', () => {
    const all = buildPayrollEvents(base(), { from: '2026-01-01', to: '2026-12-31' });
    expect(all.thirteenth.map((t) => [t.installment, t.date])).toEqual([
      [1, '2026-06-30'],
      [2, '2026-12-20'],
    ]);
    const late = buildPayrollEvents(base(), { from: '2026-01-01', to: '2026-12-31', today: '2026-07-01' });
    expect(late.thirteenth.map((t) => [t.installment, t.date])).toEqual([[2, '2026-12-20']]);
    const sameDay = buildPayrollEvents(base(), { from: '2026-01-01', to: '2026-12-31', today: '2026-12-20' });
    expect(sameDay.thirteenth).toHaveLength(1);
  });

  it('the first installment is half of the total and the second carries the taxes and the first already paid', () => {
    const t = buildPayrollEvents(base(), { from: '2026-01-01', to: '2026-12-31' }).thirteenth;
    const total = t[0]!.thirteenth.totalCents;
    expect(total).toBe(400000);
    expect(t[0]!.netCents).toBe(200000);
    expect(t[1]!.netCents).toBe(total - t[1]!.thirteenth.inssCents - t[1]!.thirteenth.irrfCents - 200000);
  });

  it('uses the avos of the year and the gross in force in December', () => {
    const data = base({
      admissionDate: '2024-09-16',
      salaries: [
        { startDate: '2024-09-16', amountCents: 300000 },
        { startDate: '2024-11-01', amountCents: 360000 },
      ],
    });
    const t = buildPayrollEvents(data, { from: '2024-01-01', to: '2024-12-31' }).thirteenth;
    expect(t[0]!.thirteenth.avos).toBe(4); // Sep (15 days), Oct, Nov, Dec
    expect(t[0]!.thirteenth.totalCents).toBe(Math.floor((360000 * 4) / 12));
  });

  it('uses the configured months', () => {
    const data = base({ thirteenth: { first: { month: 11, day: 30 }, second: { month: 12, day: 20 } } });
    const t = buildPayrollEvents(data, { from: '2026-01-01', to: '2026-12-31' }).thirteenth;
    expect(t[0]!.date).toBe('2026-11-30');
  });

  it('the first year has no 13th before the admission year', () => {
    expect(buildPayrollEvents(base(), { from: '2024-01-01', to: '2024-12-31' }).thirteenth).toEqual([]);
  });
});

describe('extra events', () => {
  it('lists 13th and vacation as dated amounts, in order', () => {
    const data = base({ vacations: [{ id: 'v1', month: '2027-01', sellDays: 0, items: [] }] });
    const extras = extraPayrollEvents(data, { from: '2026-11-11', to: '2027-02-28', today: '2026-11-11' });
    expect(extras.map((e) => [e.kind, e.date, e.estimated])).toEqual([
      ['thirteenth_second', '2026-12-20', false],
      ['vacation', '2026-12-30', true],
    ]);
    expect(extras[0]!.description).toBe('13º salário (2ª parcela)');
  });
});

describe('FGTS', () => {
  const simple = (over: Partial<EmploymentData> = {}) =>
    base({ admissionDate: '2026-01-01', salaries: [{ startDate: '2026-01-01', amountCents: 300000 }], ...over });

  it('accumulates the monthly deposits since the admission, at 8% of the gross', () => {
    const f = buildPayrollEvents(simple(), { from: '2026-01-01', to: '2026-03-31' }).fgts;
    expect(f.months.map((m) => m.salaryDepositCents)).toEqual([24000, 24000, 24000]);
    expect(f.months.map((m) => m.accumulatedCents)).toEqual([24000, 48000, 72000]);
    expect(f.basis).toBeNull();
  });

  it('starts from the informed balance and counts only what happens after its date', () => {
    const data = simple({ fgts: { balance: { asOfDate: '2026-02-15', amountCents: 100000 }, withdrawals: [] } });
    const f = buildPayrollEvents(data, { from: '2026-01-01', to: '2026-03-31' }).fgts;
    // January and February deposits are dated before the informed date? February's is dated Feb 28, after it.
    expect(f.months[2]!.accumulatedCents).toBe(100000 + 24000 + 24000);
    expect(f.basis).toEqual({ asOfDate: '2026-02-15', amountCents: 100000 });
  });

  it('subtracts dated withdrawals once: after the informed date they count, before it they are already in the balance', () => {
    const data = simple({
      fgts: {
        balance: { asOfDate: '2026-02-15', amountCents: 100000 },
        withdrawals: [
          { date: '2026-02-01', amountCents: 7000 },
          { date: '2026-03-10', amountCents: 10000 },
        ],
      },
    });
    const f = buildPayrollEvents(data, { from: '2026-01-01', to: '2026-03-31' }).fgts;
    expect(f.months[2]!.accumulatedCents).toBe(100000 + 48000 - 10000);
    expect(f.months[2]!.withdrawalsCents).toBe(10000);
    const none = simple({ fgts: { balance: null, withdrawals: [{ date: '2026-02-01', amountCents: 7000 }] } });
    expect(buildPayrollEvents(none, { from: '2026-01-01', to: '2026-03-31' }).fgts.months[2]!.accumulatedCents).toBe(72000 - 7000);
  });

  it('13th and vacation deposits enter in their own months', () => {
    const data = simple({ vacations: [{ id: 'v1', start: '2026-08-05', sellDays: 0, items: [] }] });
    const f = buildPayrollEvents(data, { from: '2026-01-01', to: '2026-12-31' }).fgts;
    const august = f.months.find((m) => m.month === '2026-08')!; // paid Aug 3
    expect(august.vacationDepositCents).toBe(Math.floor((300000 + 100000) * 0.08));
    const dec = f.months.find((m) => m.month === '2026-12')!;
    expect(dec.thirteenthDepositCents).toBeGreaterThan(0);
    // competence August: 27 of the 30 days are vacation, so 3 worked days: 3000.00 x 3/30 = 300.00, 8% = 24.00
    expect(f.months.find((m) => m.month === '2026-08')!.salaryDepositCents).toBe(2400);
  });

  it('reports the accumulated balance at today when given', () => {
    const f = buildPayrollEvents(simple(), { from: '2026-03-01', to: '2026-03-31', today: '2026-03-15' }).fgts;
    expect(f.accumulatedTodayCents).toBe(48000); // January and February closed, March not yet
  });
});

describe('end date and several employments', () => {
  it('prorates the last month and stops after the end date', () => {
    const data = base({ endDate: '2026-06-10' });
    expect(computeCompetence(data, '2026-06')!.workedDays).toBe(10);
    expect(computeCompetence(data, '2026-07')).toBeNull();
    const ev = buildPayrollEvents(data, { from: '2026-06-01', to: '2026-12-31', today: '2026-06-01' });
    expect(ev.thirteenth).toEqual([]); // both installments are after the end date
  });

  it('every event set carries the id of its employment', () => {
    const a = buildPayrollEvents(base({ employmentId: 'emp-a' }), { from: '2026-01-01', to: '2026-12-31' });
    const b = extraPayrollEvents(base({ employmentId: 'emp-b' }), { from: '2026-01-01', to: '2026-12-31' });
    expect(a.employmentId).toBe('emp-a');
    expect(new Set(b.map((e) => e.employmentId))).toEqual(new Set(['emp-b']));
  });
});

describe('FGTS birthday withdrawal', () => {
  const withMode = (over: Partial<EmploymentData['fgts']> = {}, modeOver: Record<string, unknown> = {}): EmploymentData =>
    base({
      admissionDate: '2026-01-01',
      salaries: [{ startDate: '2026-01-01', amountCents: 300000 }],
      fgts: {
        balance: { asOfDate: '2026-03-31', amountCents: 600000 },
        withdrawals: [],
        modes: [{ startDate: '2026-01-01', mode: 'birthday', birthdayMonth: 5, ...modeOver }],
        ...over,
      },
    });

  it('the table is applied over the estimated balance on the 5th business day of the birthday month', () => {
    // balance 6.000,00 at Mar 31; April deposit 240,00 (Apr 30) -> 6.240,00 on the eve of May 7: 20% + 650,00
    const ev = buildPayrollEvents(withMode(), { from: '2026-04-01', to: '2026-06-30', today: '2026-04-10' });
    expect(ev.birthdayWithdrawals).toEqual([
      { year: 2026, date: '2026-05-07', amountCents: Math.floor(624000 * 0.2) + 65000, source: 'table', balanceCents: 624000, tableId: 'fgts-birthday-2020' },
    ]);
    const may = ev.fgts.months.find((m) => m.month === '2026-05')!;
    expect(may.forecastWithdrawalCents).toBe(Math.floor(624000 * 0.2) + 65000);
    expect(may.accumulatedCents).toBe(624000 + 24000 - (Math.floor(624000 * 0.2) + 65000));
  });

  it('extra events carry it as estimated', () => {
    const e = extraPayrollEvents(withMode(), { from: '2026-04-01', to: '2026-06-30', today: '2026-04-10' });
    expect(e.map((x) => [x.kind, x.date, x.estimated])).toContainEqual(['fgts_birthday', '2026-05-07', true]);
  });

  it('an informed amount overrides the table', () => {
    const ev = buildPayrollEvents(withMode({}, { expectedAmountCents: 99900 }), { from: '2026-04-01', to: '2026-06-30', today: '2026-04-10' });
    expect(ev.birthdayWithdrawals[0]).toMatchObject({ amountCents: 99900, source: 'informed', balanceCents: 0, tableId: null });
  });

  it('termination mode, a date already past and a recorded birthday withdrawal of the year forecast nothing', () => {
    const range = { from: '2026-04-01', to: '2026-06-30', today: '2026-04-10' };
    expect(buildPayrollEvents(withMode({ modes: [{ startDate: '2026-01-01', mode: 'termination' }] }), range).birthdayWithdrawals).toEqual([]);
    expect(buildPayrollEvents(withMode(), { ...range, today: '2026-05-08' }).birthdayWithdrawals).toEqual([]);
    const recorded = withMode({ withdrawals: [{ date: '2026-05-04', amountCents: 50000, kind: 'birthday' }] });
    expect(buildPayrollEvents(recorded, range).birthdayWithdrawals).toEqual([]);
  });

  it('follows the mode history: the mode in force on the birthday month decides', () => {
    const data = withMode({
      modes: [
        { startDate: '2026-01-01', mode: 'birthday', birthdayMonth: 5 },
        { startDate: '2026-04-15', mode: 'termination' },
      ],
    });
    expect(buildPayrollEvents(data, { from: '2026-04-01', to: '2026-06-30', today: '2026-04-10' }).birthdayWithdrawals).toEqual([]);
  });

  it('a later year sees the earlier forecast withdrawal leave the balance', () => {
    const ev = buildPayrollEvents(withMode(), { from: '2026-04-01', to: '2027-06-30', today: '2026-04-10' });
    expect(ev.birthdayWithdrawals.map((b) => b.year)).toEqual([2026, 2027]);
    const first = ev.birthdayWithdrawals[0]!;
    const second = ev.birthdayWithdrawals[1]!;
    expect(second.balanceCents).toBeLessThan(first.balanceCents + 12 * 24000 + 1);
    expect(second.balanceCents).toBeGreaterThan(0);
  });
});

describe('includePast (year calendar)', () => {
  const year = { from: '2026-01-01', to: '2026-12-31', today: '2026-08-15' };
  const vacation = (over: Record<string, unknown>) => ({ id: 'vac-1', sellDays: 0, items: [], ...over });
  const withBirthday = (withdrawals: EmploymentData['fgts']['withdrawals'] = []): EmploymentData =>
    base({
      admissionDate: '2025-02-10',
      vacations: [vacation({ start: '2026-03-02' }), vacation({ start: '2026-10-05', id: 'vac-2' })],
      fgts: { balance: null, withdrawals, modes: [{ startDate: '2025-02-10', mode: 'birthday', birthdayMonth: 5 }] },
    });

  it('without the flag the result is the same as before, with no past field', () => {
    const plain = buildPayrollEvents(withBirthday(), year);
    const explicit = buildPayrollEvents(withBirthday(), { ...year, includePast: false });
    expect(explicit).toEqual(plain);
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(plain));
    expect(JSON.stringify(plain)).not.toContain('"past"');
    expect(plain.thirteenth.map((t) => t.installment)).toEqual([2]);
    expect(plain.vacations.map((v) => v.id)).toEqual(['vac-2']);
  });

  it('returns the past 13th installment and vacation, marked past, next to the future ones', () => {
    const ev = buildPayrollEvents(withBirthday(), { ...year, includePast: true });
    expect(ev.thirteenth.map((t) => [t.installment, t.date, t.past])).toEqual([
      [1, '2026-06-30', true],
      [2, '2026-12-20', false],
    ]);
    expect(ev.vacations.map((v) => [v.id, v.past])).toEqual([
      ['vac-1', true],
      ['vac-2', false],
    ]);
    // The past ones carry the same value the future calculation gives (recalculated, not invented).
    const noToday = buildPayrollEvents(withBirthday(), { from: year.from, to: year.to });
    expect(ev.thirteenth[0]!.netCents).toBe(noToday.thirteenth[0]!.netCents);
    expect(ev.vacations[0]!.netCents).toBe(noToday.vacations[0]!.netCents);
  });

  it('an event dated today is not past', () => {
    const ev = buildPayrollEvents(base(), { from: '2026-01-01', to: '2026-12-31', today: '2026-12-20', includePast: true });
    expect(ev.thirteenth.map((t) => [t.installment, t.past])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it('respects the requested period', () => {
    const ev = buildPayrollEvents(withBirthday(), { from: '2026-07-01', to: '2026-12-31', today: '2026-08-15', includePast: true });
    expect(ev.thirteenth.map((t) => t.installment)).toEqual([2]);
    expect(ev.vacations.map((v) => v.id)).toEqual(['vac-2']);
  });

  it('a past birthday withdrawal comes only from the record, with its real amount', () => {
    const recorded = withBirthday([{ date: '2026-05-08', amountCents: 123456, kind: 'birthday' }]);
    const ev = buildPayrollEvents(recorded, { ...year, includePast: true });
    expect(ev.birthdayWithdrawals).toEqual([
      { year: 2026, date: '2026-05-08', amountCents: 123456, source: 'recorded', balanceCents: 0, tableId: null, past: true },
    ]);
    // Another kind of withdrawal is not a birthday withdrawal, and nothing recorded means nothing returned.
    const other = withBirthday([{ date: '2026-05-08', amountCents: 5000, kind: 'other' }]);
    expect(buildPayrollEvents(other, { ...year, includePast: true }).birthdayWithdrawals).toEqual([]);
    expect(buildPayrollEvents(withBirthday(), { ...year, includePast: true }).birthdayWithdrawals).toEqual([]);
    // Outside the period it is left out; without the flag it is never returned.
    expect(buildPayrollEvents(recorded, { ...year, from: '2026-06-01', includePast: true }).birthdayWithdrawals).toEqual([]);
    expect(buildPayrollEvents(recorded, year).birthdayWithdrawals).toEqual([]);
  });

  it('keeps the future forecast, marked not past, beside a recorded past withdrawal of an earlier year', () => {
    const recorded = withBirthday([{ date: '2025-05-09', amountCents: 40000, kind: 'birthday' }]);
    const ev = buildPayrollEvents(recorded, { from: '2025-01-01', to: '2027-12-31', today: '2026-08-15', includePast: true });
    expect(ev.birthdayWithdrawals.map((b) => [b.date, b.source, b.past])).toEqual([
      ['2025-05-09', 'recorded', true],
      ['2027-05-07', 'table', false],
    ]);
  });

  it('cash flow and card income (extraPayrollEvents) ignore the flag: nothing past, same events', () => {
    const data = withBirthday([{ date: '2026-05-08', amountCents: 123456, kind: 'birthday' }]);
    const a = extraPayrollEvents(data, year);
    const b = extraPayrollEvents(data, { ...year, includePast: true });
    expect(b).toEqual(a);
    expect(a.every((e) => e.date >= year.today)).toBe(true);
  });

  it('the salary list and the FGTS forecast do not change with the flag', () => {
    const a = buildPayrollEvents(withBirthday(), year);
    const b = buildPayrollEvents(withBirthday(), { ...year, includePast: true });
    expect(b.salary).toEqual(a.salary);
    expect(b.fgts).toEqual(a.fgts);
  });
});
