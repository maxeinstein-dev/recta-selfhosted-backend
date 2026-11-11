import { describe, expect, it } from 'vitest';

import {
  computeFgts,
  computeInss,
  computeIrrf,
  computeMonthlyPayroll,
  findGrossForNet,
  irrfReduction,
  prorateSalary,
  type PayrollItem,
  type PayrollMethod,
} from './payroll-calc.js';
import { selectFgtsTable, selectInssTable, selectIrrfTable } from './payroll-tables.js';

// Invented data only. Hand-computed expectations, in cents.
const INSS26 = selectInssTable('2026-06-01').table;
const IRRF26 = selectIrrfTable('2026-06-01').table;
const IRRF25 = selectIrrfTable('2025-06-01').table;

const allowance = (amountCents: number): PayrollItem => ({
  label: 'Allowance',
  amountCents,
  kind: 'earning',
  inInssBase: false,
  inIrrfBase: false,
  inFgtsBase: false,
});

describe('computeInss (2026, deduction + truncate)', () => {
  it.each([
    [0, 0],
    [100000, 7500], // first band
    [162100, 12157], // top of the first band: 12157.5 truncated
    [162101, 12157], // first cent of the 9% band: continuous
    [250000, 20068], // 9% band
    [290284, 23693], // top of the 9% band
    [290285, 23693], // first cent of the 12% band: continuous
    [400000, 36859], // 12% band
    [435427, 41110], // top of the 12% band
    [435428, 41109], // first cent of the 14% band: 1 cent lower, the rounded deductions are not exactly continuous
    [500000, 50150], // 14% band
    [847555, 98807], // the ceiling
    [2000000, 98807], // above the ceiling: capped
  ])('base %i gives %i', (base, expected) => {
    expect(computeInss(base, INSS26)).toBe(expected);
  });

  it('is never negative', () => {
    expect(computeInss(-500, INSS26)).toBe(0);
  });

  it('rejects fractional cents', () => {
    expect(() => computeInss(1000.5, INSS26)).toThrow();
  });
});

describe('payroll method', () => {
  const m = (bracket: PayrollMethod['bracket'], rounding: PayrollMethod['rounding']): PayrollMethod => ({ bracket, rounding });

  it('direct and rounded can differ from the default by a cent', () => {
    expect(computeInss(400000, INSS26, m('deduction', 'truncate'))).toBe(36859);
    expect(computeInss(400000, INSS26, m('direct', 'truncate'))).toBe(36859);
    expect(computeInss(400000, INSS26, m('direct', 'round'))).toBe(36860);
    expect(computeInss(400000, INSS26, m('deduction', 'round'))).toBe(36859);
  });

  it('direct sums each slice at its own rate', () => {
    // 12157.5 + 11536.56 + 17417.16 + 57697.92 = 98809.14 at the ceiling
    expect(computeInss(847555, INSS26, m('direct', 'truncate'))).toBe(98809);
  });

  it('applies the method to the FGTS and to the proration', () => {
    const fgts = selectFgtsTable('2026-06-01').table;
    expect(computeFgts(123457, fgts, m('deduction', 'truncate'))).toBe(9876); // 9876.56
    expect(computeFgts(123457, fgts, m('deduction', 'round'))).toBe(9877);
    expect(prorateSalary(100001, 20, 'truncate')).toBe(66667);
    expect(prorateSalary(100001, 20, 'round')).toBe(66667);
    expect(prorateSalary(100000, 7, 'truncate')).toBe(23333);
    expect(prorateSalary(100000, 7, 'round')).toBe(23333);
    expect(prorateSalary(100000, 8, 'round')).toBe(26667);
    expect(prorateSalary(100000, 8, 'truncate')).toBe(26666);
  });
});

describe('irrfReduction (2026)', () => {
  it('is the fixed cap up to 5,000.00', () => {
    expect(irrfReduction(100000, IRRF26)).toBe(31289);
    expect(irrfReduction(500000, IRRF26)).toBe(31289);
  });

  it('falls linearly between 5,000.00 and 7,350.00', () => {
    expect(irrfReduction(500001, IRRF26)).toBe(31289);
    expect(irrfReduction(600000, IRRF26)).toBe(17975); // 978.62 - 0.133145 * 6000
    expect(irrfReduction(734999, IRRF26)).toBe(1);
  });

  it('is zero from 7,350.00 on', () => {
    expect(irrfReduction(735000, IRRF26)).toBe(0);
    expect(irrfReduction(900000, IRRF26)).toBe(0);
  });

  it('does not exist before 2026', () => {
    expect(irrfReduction(300000, IRRF25)).toBe(0);
  });
});

describe('computeIrrf', () => {
  it('is zero under the exempt band', () => {
    const r = computeIrrf(300000, 25000, 0, IRRF26);
    expect(r.deduction).toBe('simplified');
    expect(r.baseCents).toBe(239280);
    expect(r.taxCents).toBe(0);
  });

  it('is zeroed by the reducer up to 5,000.00', () => {
    const r = computeIrrf(400000, 40000, 0, IRRF26);
    expect(r.baseCents).toBe(339280);
    expect(r.taxBeforeReductionCents).toBe(11476);
    expect(r.reductionCents).toBe(11476); // limited to the tax
    expect(r.taxCents).toBe(0);
  });

  it('is partly reduced between 5,000.00 and 7,350.00', () => {
    const r = computeIrrf(600000, 70000, 0, IRRF26);
    expect(r.deduction).toBe('legal');
    expect(r.baseCents).toBe(530000);
    expect(r.taxBeforeReductionCents).toBe(54877);
    expect(r.reductionCents).toBe(17975);
    expect(r.taxCents).toBe(36902);
  });

  it('is the plain table above 7,350.00', () => {
    const r = computeIrrf(800000, 90000, 0, IRRF26);
    expect(r.reductionCents).toBe(0);
    expect(r.taxCents).toBe(104377);
  });

  it('uses the dependents deduction when it beats the simplified one', () => {
    const none = computeIrrf(450000, 40000, 0, IRRF25);
    const two = computeIrrf(450000, 40000, 2, IRRF25);
    expect(none.deduction).toBe('simplified');
    expect(none.deductionCents).toBe(60720);
    expect(two.deduction).toBe('legal');
    expect(two.deductionCents).toBe(40000 + 2 * 18959);
    expect(two.baseCents).toBe(372082);
    expect(two.taxCents).toBe(16396);
    expect(two.taxCents).toBeLessThan(none.taxCents);
  });

  it('never goes negative', () => {
    expect(computeIrrf(10000, 5000, 0, IRRF26).taxCents).toBe(0);
    expect(computeIrrf(0, 0, 0, IRRF26).taxCents).toBe(0);
  });

  it('rejects a negative or fractional dependents count', () => {
    expect(() => computeIrrf(100000, 0, -1, IRRF26)).toThrow();
    expect(() => computeIrrf(100000, 0, 1.5, IRRF26)).toThrow();
  });
});

describe('computeMonthlyPayroll', () => {
  it('composes bases, taxes, items and the net (allowance outside every base)', () => {
    const p = computeMonthlyPayroll({ date: '2026-11-05', grossCents: 400000, items: [allowance(20000)] });
    expect(p.tables).toEqual({ inss: 'inss-2026', irrf: 'irrf-2026-01', fgts: 'fgts-8' });
    expect(p.warnings).toEqual([]);
    expect(p.salaryCents).toBe(400000);
    expect(p.extraEarningsCents).toBe(20000);
    expect(p.bases).toEqual({ inssCents: 400000, irrfIncomeCents: 400000, irrfCents: 339280, fgtsCents: 400000 });
    expect(p.inssCents).toBe(36859);
    expect(p.irrfCents).toBe(0);
    expect(p.fgtsCents).toBe(32000);
    expect(p.netCents).toBe(383141);
  });

  it('puts an earning with the flags in the right bases', () => {
    const bonus: PayrollItem = { ...allowance(50000), label: 'Bonus', inInssBase: true, inIrrfBase: true, inFgtsBase: false };
    const p = computeMonthlyPayroll({ date: '2026-11-05', grossCents: 400000, items: [bonus] });
    expect(p.bases.inssCents).toBe(450000);
    expect(p.bases.irrfIncomeCents).toBe(450000);
    expect(p.bases.fgtsCents).toBe(400000);
    expect(p.inssCents).toBe(43150);
  });

  it('subtracts fixed deductions from the net only', () => {
    const base = computeMonthlyPayroll({ date: '2026-11-05', grossCents: 400000 });
    const withDiscount = computeMonthlyPayroll({
      date: '2026-11-05',
      grossCents: 400000,
      items: [{ ...allowance(15000), kind: 'deduction' }],
    });
    expect(withDiscount.fixedDeductionsCents).toBe(15000);
    expect(withDiscount.inssCents).toBe(base.inssCents);
    expect(withDiscount.netCents).toBe(base.netCents - 15000);
  });

  it('caps the INSS base at the ceiling', () => {
    const p = computeMonthlyPayroll({ date: '2026-11-05', grossCents: 800000 });
    expect(p.bases.inssCents).toBe(800000);
    const high = computeMonthlyPayroll({ date: '2026-11-05', grossCents: 1200000 });
    expect(high.bases.inssCents).toBe(847555);
    expect(high.inssCents).toBe(98807);
  });

  it('computes a high salary end to end', () => {
    const p = computeMonthlyPayroll({ date: '2026-11-05', grossCents: 800000 });
    expect(p.inssCents).toBe(92150);
    expect(p.irrf.deduction).toBe('legal');
    expect(p.irrfCents).toBe(103785);
    expect(p.netCents).toBe(604065);
  });

  it('prorates the salary by the days worked', () => {
    const p = computeMonthlyPayroll({ date: '2026-11-05', grossCents: 300000, workedDays: 18 });
    expect(p.salaryCents).toBe(180000);
    expect(p.inssCents).toBe(13768);
    expect(p.netCents).toBe(166232);
    expect(computeMonthlyPayroll({ date: '2026-11-05', grossCents: 300000, workedDays: 0 }).netCents).toBe(0);
  });

  it('switches tables on the day a new one starts', () => {
    const before = computeMonthlyPayroll({ date: '2025-12-31', grossCents: 600000 });
    const after = computeMonthlyPayroll({ date: '2026-01-01', grossCents: 600000 });
    expect(before.tables).toMatchObject({ inss: 'inss-2025', irrf: 'irrf-2025-05' });
    expect(after.tables).toMatchObject({ inss: 'inss-2026', irrf: 'irrf-2026-01' });
    expect(before.inssCents).toBe(64959);
    expect(before.irrfCents).toBe(56263);
    expect(after.inssCents).toBe(64150);
    expect(after.irrfCents).toBe(38510);
  });

  it('uses the last table past its validity and warns', () => {
    const p = computeMonthlyPayroll({ date: '2027-03-05', grossCents: 400000 });
    expect(p.tables.inss).toBe('inss-2026');
    expect(p.warnings).toEqual([{ code: 'projection_old_table', tax: 'inss', tableId: 'inss-2026' }]);
  });

  it('accepts a custom table set', () => {
    const p = computeMonthlyPayroll({
      date: '2026-05-05',
      grossCents: 100000,
      tables: {
        inss: [
          {
            id: 'fake',
            validFrom: '2020-01-01',
            validUntil: null,
            ceilingCents: 500000,
            bands: [{ upToCents: 500000, rateBp: 1000, deductionCents: 0 }],
            source: { urls: [], unconfirmed: [] },
          },
        ],
      },
    });
    expect(p.tables.inss).toBe('fake');
    expect(p.inssCents).toBe(10000);
  });

  it('rejects bad input', () => {
    expect(() => computeMonthlyPayroll({ date: '2026-05-05', grossCents: 100.5 })).toThrow();
    expect(() => computeMonthlyPayroll({ date: '2026-05-05', grossCents: -1 })).toThrow();
    expect(() => computeMonthlyPayroll({ date: '2026-05-05', grossCents: 100000, items: [allowance(-5)] })).toThrow();
    expect(() => computeMonthlyPayroll({ date: '2026-05-05', grossCents: 100000, workedDays: 31 })).toThrow();
  });
});

describe('findGrossForNet', () => {
  const dates = ['2025-12-31', '2026-11-05'];
  const itemSets: PayrollItem[][] = [[], [allowance(15000)]];

  it('round-trips and returns the smallest gross, in every salary zone', () => {
    for (const date of dates) {
      for (const items of itemSets) {
        for (const dependents of [0, 2]) {
          for (let gross = 120000; gross <= 1500000; gross += 23457) {
            const net = computeMonthlyPayroll({ date, grossCents: gross, dependents, items }).netCents;
            const r = findGrossForNet({ date, targetNetCents: net, dependents, items });
            expect(r.grossCents).toBeLessThanOrEqual(gross);
            expect(r.differenceCents).toBe(0);
            expect(computeMonthlyPayroll({ date, grossCents: r.grossCents, dependents, items }).netCents).toBe(net);
            // the smallest: one cent less is short of the target
            expect(computeMonthlyPayroll({ date, grossCents: r.grossCents - 1, dependents, items }).netCents).toBeLessThan(net);
          }
        }
      }
    }
  });

  it('returns the lower of two neighbouring grosses with the same net', () => {
    const date = '2026-11-05';
    let found = false;
    for (let gross = 300000; gross < 300400 && !found; gross++) {
      const a = computeMonthlyPayroll({ date, grossCents: gross }).netCents;
      const b = computeMonthlyPayroll({ date, grossCents: gross + 1 }).netCents;
      if (a === b) {
        found = true;
        expect(findGrossForNet({ date, targetNetCents: a }).grossCents).toBeLessThanOrEqual(gross);
      }
    }
    expect(found).toBe(true);
  });

  it('finds the gross of an exact target inside the reducer zone', () => {
    const r = findGrossForNet({ date: '2026-11-05', targetNetCents: 500000 });
    expect(r.payroll.netCents).toBe(500000);
    expect(r.payroll.bases.irrfIncomeCents).toBe(r.grossCents);
    expect(r.grossCents).toBeGreaterThan(500000);
  });

  it('answers 0 when the fixed earnings already reach the target', () => {
    const r = findGrossForNet({ date: '2026-11-05', targetNetCents: 10000, items: [allowance(15000)] });
    expect(r.grossCents).toBe(0);
    expect(r.differenceCents).toBe(5000);
  });

  it('throws when the target is out of reach', () => {
    expect(() => findGrossForNet({ date: '2026-11-05', targetNetCents: 10_000_000_000_000 })).toThrow();
  });
});
