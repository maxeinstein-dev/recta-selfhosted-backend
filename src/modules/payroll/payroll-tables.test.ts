import { describe, expect, it } from 'vitest';

import {
  FGTS_TABLES,
  INSS_TABLES,
  IRRF_TABLES,
  pickTable,
  selectFgtsTable,
  selectInssTable,
  selectIrrfTable,
  type InssTable,
} from './payroll-tables.js';

// Invented tables only, for the lookup logic.
const fake = (id: string, validFrom: string, validUntil: string | null): InssTable => ({
  id,
  validFrom,
  validUntil,
  ceilingCents: 100000,
  bands: [{ upToCents: 100000, rateBp: 1000, deductionCents: 0 }],
  source: { urls: [], unconfirmed: [] },
});

describe('pickTable', () => {
  const tables = [fake('b', '2030-01-01', '2030-12-31'), fake('a', '2029-01-01', null)];

  it('picks the table in force, whatever the order of the list', () => {
    expect(pickTable(tables, '2029-06-01')).toEqual({ table: tables[1], warning: null });
    expect(pickTable(tables, '2030-01-01').table.id).toBe('b');
    expect(pickTable(tables, '2029-12-31').table.id).toBe('a');
  });

  it('keeps the last table inside its known validity without a warning', () => {
    expect(pickTable(tables, '2030-12-31')).toEqual({ table: tables[0], warning: null });
  });

  it('uses the last table past its validity and warns about the projection', () => {
    expect(pickTable(tables, '2031-01-01')).toEqual({ table: tables[0], warning: 'projection_old_table' });
  });

  it('warns when the date is before every table', () => {
    expect(pickTable(tables, '2028-12-31')).toEqual({ table: tables[1], warning: 'before_first_table' });
  });

  it('never warns about an older table that was replaced', () => {
    const t = [fake('old', '2029-01-01', '2029-12-31'), fake('new', '2030-01-01', null)];
    expect(pickTable(t, '2029-07-01').warning).toBeNull();
  });

  it('rejects an empty list', () => {
    expect(() => pickTable([], '2030-01-01')).toThrow();
  });
});

describe('registered tables', () => {
  it('picks the INSS table of the year', () => {
    expect(selectInssTable('2025-12-31').table.id).toBe('inss-2025');
    expect(selectInssTable('2026-01-01').table.id).toBe('inss-2026');
    expect(selectInssTable('2027-01-01')).toMatchObject({ warning: 'projection_old_table' });
  });

  it('picks the IRRF table by the date it started', () => {
    expect(selectIrrfTable('2025-04-30').table.id).toBe('irrf-2025-01');
    expect(selectIrrfTable('2025-05-01').table.id).toBe('irrf-2025-05');
    expect(selectIrrfTable('2026-01-01').table.id).toBe('irrf-2026-01');
    expect(selectIrrfTable('2030-01-01').warning).toBeNull();
  });

  it('has FGTS at 8%', () => {
    expect(selectFgtsTable('2026-11-01').table.rateBp).toBe(800);
  });

  it('keeps the bands ascending and the last INSS band at the ceiling', () => {
    for (const t of INSS_TABLES) {
      const limits = t.bands.map((b) => b.upToCents);
      expect([...limits].sort((a, b) => a - b)).toEqual(limits);
      expect(limits[limits.length - 1]).toBe(t.ceilingCents);
      expect(t.bands[0]!.deductionCents).toBe(0);
    }
    for (const t of IRRF_TABLES) {
      expect(t.bands[t.bands.length - 1]!.upToCents).toBeNull();
    }
    expect(FGTS_TABLES.length).toBeGreaterThan(0);
  });

  it('gives every table an id, a source and a start date', () => {
    for (const t of [...INSS_TABLES, ...IRRF_TABLES, ...FGTS_TABLES]) {
      expect(t.id).toMatch(/\S/);
      expect(t.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(t.source.unconfirmed).toBeInstanceOf(Array);
    }
  });

  it('only the 2026 IRRF table has the reducer', () => {
    expect(IRRF_TABLES.filter((t) => t.reducer).map((t) => t.id)).toEqual(['irrf-2026-01']);
  });
});
