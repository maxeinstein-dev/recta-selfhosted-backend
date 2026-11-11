import { describe, expect, it } from 'vitest';

import { isBusinessDay, nthBusinessDay, previousBusinessDay } from './payroll-dates.js';
import {
  cityKey,
  countsAsOff,
  holidaysOfYear,
  MUNICIPAL_HOLIDAY_TABLES,
  NATIONAL_HOLIDAYS,
  offDayChecker,
  offDaysOfYear,
  STATE_HOLIDAY_TABLES,
  tablesFor,
  type HolidayConfig,
} from './payroll-holidays.js';

const SE_ARACAJU: HolidayConfig = { uf: 'SE', city: 'Aracaju', optionalOff: true };
const dates = (config: HolidayConfig | null, year: number) => holidaysOfYear(config, year).map((h) => h.date);
const byId = (config: HolidayConfig | null, year: number, id: string) => holidaysOfYear(config, year).find((h) => h.id === id);

describe('holiday calendar levels', () => {
  it('without a uf there is no calendar at all: not even the national holidays (weekends only, as before)', () => {
    expect(holidaysOfYear(null, 2026)).toEqual([]);
    expect(holidaysOfYear({}, 2026)).toEqual([]);
    expect(holidaysOfYear({ uf: '  ', city: 'Aracaju' }, 2026)).toEqual([]);
    expect(offDayChecker(null)('2026-09-07')).toBe(false);
    expect(tablesFor({ city: 'Aracaju' })).toBeNull();
  });

  it('a uf with a state table and a city with a municipal table add their levels on top of the national one', () => {
    const levels = new Set(holidaysOfYear(SE_ARACAJU, 2026).map((h) => h.level));
    expect(levels).toEqual(new Set(['national', 'state', 'municipal']));
    expect(byId(SE_ARACAJU, 2026, 'se-political-emancipation')).toMatchObject({ date: '2026-07-08', level: 'state' });
    expect(byId(SE_ARACAJU, 2026, 'aracaju-anniversary')).toMatchObject({ date: '2026-03-17', level: 'municipal' });
    expect(byId(SE_ARACAJU, 2026, 'aracaju-sao-joao')).toMatchObject({ date: '2026-06-24', level: 'municipal' });
  });

  it('the city is matched without caring for case, accents or spaces; the uf, without case', () => {
    expect(cityKey('  ARACAJÚ ')).toBe('aracaju');
    expect(dates({ uf: 'se', city: ' aracaju ' }, 2026)).toEqual(dates(SE_ARACAJU, 2026));
  });

  it('a uf without a table gets the national holidays and a warning; a city without a table, the state ones and a warning', () => {
    const ba = tablesFor({ uf: 'BA', city: 'Salvador' })!;
    expect(ba.warnings.map((w) => w.code)).toEqual(['no_state_table', 'no_city_table']);
    expect(ba.tables.map((t) => t.level)).toEqual(['national']);

    const lagarto = tablesFor({ uf: 'SE', city: 'Lagarto' })!;
    expect(lagarto.warnings.map((w) => w.code)).toEqual(['no_city_table']);
    expect(lagarto.tables.map((t) => t.level)).toEqual(['national', 'state']);

    expect(tablesFor({ uf: 'SE' })!.warnings).toEqual([]); // no city informed: nothing to warn about
    expect(tablesFor(SE_ARACAJU)!.warnings).toEqual([]);
    expect(dates({ uf: 'BA' }, 2026)).not.toContain('2026-07-08');
  });

  it('every entry says where it comes from', () => {
    const entries = [...NATIONAL_HOLIDAYS, ...STATE_HOLIDAY_TABLES.flatMap((t) => t.entries), ...MUNICIPAL_HOLIDAY_TABLES.flatMap((t) => t.entries)];
    for (const e of entries) {
      expect(e.source.urls.length, e.id).toBeGreaterThan(0);
      expect(e.source.note, e.id).not.toBe('');
    }
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  });
});

describe('fixed holidays', () => {
  it('national fixed days of 2026', () => {
    const d = dates({ uf: 'SE' }, 2026);
    for (const day of ['2026-01-01', '2026-04-21', '2026-05-01', '2026-09-07', '2026-10-12', '2026-11-02', '2026-11-15', '2026-11-20', '2026-12-25']) {
      expect(d, day).toContain(day);
    }
  });

  it('Consciência Negra (20/11) exists only from 2024', () => {
    expect(dates({ uf: 'SE' }, 2023)).not.toContain('2023-11-20');
    expect(dates({ uf: 'SE' }, 2024)).toContain('2024-11-20');
  });
});

describe('movable holidays from Easter', () => {
  // Easter Sunday: 2025-04-20, 2026-04-05, 2027-03-28, 2028-04-16
  it.each([
    [2025, { carnival: ['2025-03-03', '2025-03-04'], goodFriday: '2025-04-18', corpus: '2025-06-19' }],
    [2026, { carnival: ['2026-02-16', '2026-02-17'], goodFriday: '2026-04-03', corpus: '2026-06-04' }],
    [2027, { carnival: ['2027-02-08', '2027-02-09'], goodFriday: '2027-03-26', corpus: '2027-05-27' }],
    [2028, { carnival: ['2028-02-28', '2028-02-29'], goodFriday: '2028-04-14', corpus: '2028-06-15' }],
  ])('%i', (year, want) => {
    expect(byId(SE_ARACAJU, year, 'carnival-monday')!.date).toBe(want.carnival[0]);
    expect(byId(SE_ARACAJU, year, 'carnival-tuesday')!.date).toBe(want.carnival[1]);
    expect(byId(SE_ARACAJU, year, 'good-friday')!.date).toBe(want.goodFriday);
    expect(byId(SE_ARACAJU, year, 'corpus-christi')!.date).toBe(want.corpus);
  });

  it('carnival and Corpus Christi are marked optional; Good Friday is not', () => {
    expect(byId(SE_ARACAJU, 2026, 'carnival-monday')!.optional).toBe(true);
    expect(byId(SE_ARACAJU, 2026, 'carnival-tuesday')!.optional).toBe(true);
    expect(byId(SE_ARACAJU, 2026, 'corpus-christi')!.optional).toBe(true);
    expect(byId(SE_ARACAJU, 2026, 'good-friday')!.optional).toBe(false);
  });
});

describe('what counts as a day off', () => {
  it('optional days count only when the employment says so', () => {
    expect(offDaysOfYear({ uf: 'SE', optionalOff: false }, 2026).has('2026-02-16')).toBe(false);
    expect(offDaysOfYear({ uf: 'SE', optionalOff: true }, 2026).has('2026-02-16')).toBe(true);
    expect(offDaysOfYear({ uf: 'SE', optionalOff: false }, 2026).has('2026-04-03')).toBe(true); // Good Friday: always
  });

  it('an unconfirmed entry is listed but never counted', () => {
    const conception = byId(SE_ARACAJU, 2026, 'aracaju-our-lady-conception')!;
    expect(conception).toMatchObject({ date: '2026-12-08', confirmed: false });
    expect(countsAsOff(conception, SE_ARACAJU)).toBe(false);
    expect(offDaysOfYear(SE_ARACAJU, 2026).has('2026-12-08')).toBe(false);
  });

  it('the checker works across years', () => {
    const off = offDayChecker(SE_ARACAJU);
    expect(off('2026-07-08')).toBe(true);
    expect(off('2027-07-08')).toBe(true);
    expect(off('2027-07-09')).toBe(false);
  });
});

describe('business-day helpers with holidays', () => {
  const off = offDayChecker(SE_ARACAJU);

  it('isBusinessDay and previousBusinessDay skip holidays only when given the checker', () => {
    expect(isBusinessDay('2026-09-07')).toBe(true);
    expect(isBusinessDay('2026-09-07', off)).toBe(false);
    expect(previousBusinessDay('2026-09-07')).toBe('2026-09-07');
    expect(previousBusinessDay('2026-09-07', off)).toBe('2026-09-04');
    // Saturday -> Friday that is Good Friday -> Thursday
    expect(previousBusinessDay('2026-04-04', off)).toBe('2026-04-02');
    expect(previousBusinessDay('2026-04-04')).toBe('2026-04-03');
  });

  it('the n-th business day counts holidays out; without the checker nothing changes', () => {
    expect(nthBusinessDay('2026-05', 5)).toBe('2026-05-07');
    expect(nthBusinessDay('2026-05', 5, off)).toBe('2026-05-08'); // May 1 is a holiday
    expect(nthBusinessDay('2026-09', 5)).toBe('2026-09-07');
    expect(nthBusinessDay('2026-09', 5, off)).toBe('2026-09-08'); // Sep 7 is a holiday: 1, 2, 3, 4 and then the 8th
  });
});
