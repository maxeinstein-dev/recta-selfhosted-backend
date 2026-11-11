import { describe, expect, it } from 'vitest';

import { birthdayWithdrawalCents, FGTS_BIRTHDAY_TABLES, selectBirthdayTable } from './payroll-fgts-birthday.js';

const table = FGTS_BIRTHDAY_TABLES[0]!;

describe('FGTS birthday table', () => {
  it('has the seven bands of the official annex, with its source', () => {
    expect(table.bands).toHaveLength(7);
    expect(table.source.urls[0]).toContain('fgts.gov.br');
    expect(selectBirthdayTable('2026-05-01').id).toBe(table.id);
  });

  it('applies the rate of the band plus its additional amount, at each band edge', () => {
    const at = (reais: number) => birthdayWithdrawalCents(Math.round(reais * 100), table);
    expect(at(0)).toBe(0);
    expect(at(500)).toBe(25000); // 50%
    expect(at(500.01)).toBe(Math.floor(50001 * 0.4) + 5000);
    expect(at(1000)).toBe(40000 + 5000);
    expect(at(1000.01)).toBe(Math.floor(100001 * 0.3) + 15000);
    expect(at(5000)).toBe(150000 + 15000);
    expect(at(5000.01)).toBe(Math.floor(500001 * 0.2) + 65000);
    expect(at(10000)).toBe(200000 + 65000);
    expect(at(15000)).toBe(225000 + 115000);
    expect(at(20000)).toBe(200000 + 190000);
    expect(at(20000.01)).toBe(Math.floor(2000001 * 0.05) + 290000);
  });

  it('never goes down when the balance goes up inside the table', () => {
    let last = 0;
    for (let c = 0; c <= 3_000_000; c += 137) {
      const v = birthdayWithdrawalCents(c, table);
      expect(v).toBeGreaterThanOrEqual(last - 0);
      last = v;
    }
  });
});
