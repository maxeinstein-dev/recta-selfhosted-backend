import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/db/prisma.js', () => ({ prisma: {} }));

import { computeMonthlyPayroll } from './payroll-calc.js';
import { toEmploymentData, type EmploymentRow } from './payroll.links.js';
import { moneyDeep, simulateGross, simulateNet, todayString } from './payroll.service.js';

// Invented data only.
const common = { dependents: 0, items: [] as never[], bracketMethod: 'DEDUCTION' as const, rounding: 'TRUNCATE' as const };

describe('moneyDeep', () => {
  it('turns fooCents into foo (reais) and keeps the rest', () => {
    expect(moneyDeep({ netCents: 12345, workedDays: 30, nested: [{ taxCents: 100 }], id: 'x' })).toEqual({
      net: 123.45,
      workedDays: 30,
      nested: [{ tax: 1 }],
      id: 'x',
    });
  });

  it('a key that would collide with a sibling is named fooAmount', () => {
    expect(moneyDeep({ irrf: { taxCents: 5 }, irrfCents: 500 })).toEqual({ irrf: { tax: 0.05 }, irrfAmount: 5 });
  });
});

describe('simulation', () => {
  it('gross to net is the pure calculation, in reais', () => {
    const out = simulateNet({ ...common, gross: 4000, date: '2026-11-05' }) as { payroll: { net: number; tables: object } };
    const direct = computeMonthlyPayroll({ date: '2026-11-05', grossCents: 400000 });
    expect(out.payroll.net).toBe(direct.netCents / 100);
    expect(out.payroll.tables).toEqual(direct.tables);
  });

  it('items go through with their base flags', () => {
    const out = simulateNet({
      ...common,
      gross: 4000,
      date: '2026-11-05',
      items: [{ label: 'Allowance', amount: 150.5, kind: 'EARNING', inInssBase: false, inIrrfBase: false, inFgtsBase: false }],
    }) as { payroll: { net: number } };
    const base = computeMonthlyPayroll({ date: '2026-11-05', grossCents: 400000 }).netCents;
    expect(Math.round(out.payroll.net * 100)).toBe(base + 15050);
  });

  it('net to gross round-trips to the cent', () => {
    const net = simulateNet({ ...common, gross: 5234.56, date: '2026-11-05' }) as { payroll: { net: number } };
    const back = simulateGross({ ...common, targetNet: net.payroll.net, date: '2026-11-05' }) as { gross: number; difference: number };
    expect(back.difference).toBeLessThanOrEqual(0.01);
    expect(Math.abs(back.gross - 5234.56)).toBeLessThan(0.03);
  });

  it('sub-cent amounts are refused', () => {
    expect(() => simulateNet({ ...common, gross: 100.123 })).toThrow(/decimal/);
  });

  it('an unreachable net is a 400', () => {
    expect(() => simulateGross({ ...common, targetNet: 9_999_999_999 })).toThrow(/out of reach/);
  });
});

describe('todayString', () => {
  it('is the UTC day', () => {
    expect(todayString(new Date('2026-11-10T23:30:00Z'))).toBe('2026-11-10');
  });
});

describe('toEmploymentData', () => {
  const dec = (n: number) => ({ toNumber: () => n });
  const utc = (d: string) => new Date(`${d}T00:00:00.000Z`);
  const row = {
    id: 'e1',
    householdId: 'h',
    admissionDate: utc('2025-01-10'),
    endDate: null,
    dependents: 1,
    payDay: 5,
    bracketMethod: 'DIRECT',
    rounding: 'ROUND',
    thirteenthFirstMonth: 6,
    thirteenthFirstDay: 30,
    thirteenthSecondMonth: 12,
    thirteenthSecondDay: 20,
    salaries: [{ amount: dec(3000.5), startDate: utc('2025-01-10') }],
    items: [{ id: 'i', name: 'Allowance', kind: 'EARNING', inInssBase: false, inIrrfBase: true, inFgtsBase: false, values: [{ amount: dec(10.1), startDate: utc('2025-01-10') }] }],
    vacations: [{ id: 'v', startDate: null, month: '2027-01', days: null, sellDays: 3, items: [{ label: 'Adv', amount: dec(5), kind: 'DEDUCTION', inInssBase: true, inIrrfBase: false, inFgtsBase: false }] }],
    fgtsBalances: [
      { amount: dec(100), asOfDate: utc('2026-01-01') },
      { amount: dec(250.25), asOfDate: utc('2026-06-01') },
    ],
    fgtsWithdrawals: [{ amount: dec(20), date: utc('2026-05-04'), kind: 'BIRTHDAY' }],
    fgtsModes: [{ mode: 'BIRTHDAY', birthdayMonth: 5, expectedAmount: dec(99.9), startDate: utc('2026-01-01') }],
  } as unknown as EmploymentRow;

  it('maps money to cents, enums to the calculation names and picks the latest informed FGTS balance', () => {
    const d = toEmploymentData(row);
    expect(d.method).toEqual({ bracket: 'direct', rounding: 'round' });
    expect(d.salaries).toEqual([{ startDate: '2025-01-10', amountCents: 300050 }]);
    expect(d.items[0]).toMatchObject({ kind: 'earning', inIrrfBase: true, values: [{ startDate: '2025-01-10', amountCents: 1010 }] });
    expect(d.vacations[0]).toMatchObject({ start: null, month: '2027-01', sellDays: 3, items: [{ kind: 'deduction', amountCents: 500 }] });
    expect(d.fgts.balance).toEqual({ asOfDate: '2026-06-01', amountCents: 25025 });
    expect(d.fgts.withdrawals).toEqual([{ date: '2026-05-04', amountCents: 2000, kind: 'birthday' }]);
    expect(d.fgts.modes).toEqual([{ startDate: '2026-01-01', mode: 'birthday', birthdayMonth: 5, expectedAmountCents: 9990 }]);
  });
});
