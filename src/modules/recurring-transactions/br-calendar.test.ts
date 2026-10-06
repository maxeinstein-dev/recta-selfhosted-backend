import { describe, expect, it } from 'vitest';
import {
  businessDaysInMonth,
  easterSunday,
  isBusinessDay,
  isValidNonWorkingDay,
  nationalHolidays,
  normalizeNonWorkingDays,
  optionalHolidayDays,
} from './br-calendar.js';

// Easter Sunday of the known years (published ecclesiastical calendar).
const EASTER: Record<number, string> = {
  2020: '2020-04-12',
  2023: '2023-04-09',
  2024: '2024-03-31',
  2025: '2025-04-20',
  2026: '2026-04-05',
  2027: '2027-03-28',
  2028: '2028-04-16',
  2029: '2029-04-01',
  2030: '2030-04-21',
};

describe('easterSunday (Meeus/Gauss)', () => {
  for (const [year, day] of Object.entries(EASTER)) {
    it(`${year} is ${day}`, () => {
      expect(easterSunday(Number(year))).toBe(day);
    });
  }
  it('always falls on a Sunday between 22 March and 25 April', () => {
    for (let year = 1900; year <= 2100; year += 1) {
      const day = easterSunday(year);
      expect(new Date(`${day}T00:00:00Z`).getUTCDay()).toBe(0);
      expect(day >= `${year}-03-22` && day <= `${year}-04-25`).toBe(true);
    }
  });
});

describe('holidays', () => {
  it('national holidays of 2026: nine fixed plus Good Friday (03/04)', () => {
    expect(nationalHolidays(2026)).toEqual([
      '2026-01-01', '2026-04-03', '2026-04-21', '2026-05-01', '2026-09-07', '2026-10-12', '2026-11-02', '2026-11-15', '2026-11-20', '2026-12-25',
    ]);
  });
  it('Good Friday is Easter minus two days (2024: 29/03, 2025: 18/04, 2027: 26/03)', () => {
    expect(nationalHolidays(2024)).toContain('2024-03-29');
    expect(nationalHolidays(2025)).toContain('2025-04-18');
    expect(nationalHolidays(2027)).toContain('2027-03-26');
  });
  it('20/11 (Consciencia Negra) is national only from 2024', () => {
    expect(nationalHolidays(2023)).not.toContain('2023-11-20');
    expect(nationalHolidays(2024)).toContain('2024-11-20');
  });
  it('Carnaval (Monday and Tuesday) and Corpus Christi are optional, off by default', () => {
    expect(optionalHolidayDays(2026, [])).toEqual([]);
    expect(optionalHolidayDays(2026, null)).toEqual([]);
    expect(optionalHolidayDays(2026, ['CARNIVAL'])).toEqual(['2026-02-16', '2026-02-17']);
    expect(optionalHolidayDays(2026, ['CORPUS_CHRISTI'])).toEqual(['2026-06-04']);
    expect(optionalHolidayDays(2024, ['CARNIVAL', 'CORPUS_CHRISTI'])).toEqual(['2024-02-12', '2024-02-13', '2024-05-30']);
    expect(optionalHolidayDays(2025, ['CARNIVAL', 'CORPUS_CHRISTI'])).toEqual(['2025-03-03', '2025-03-04', '2025-06-19']);
  });
});

describe('business days', () => {
  it('november 2026 has 19 (02/11 Finados and 20/11 fall on Monday and Friday; 15/11 is a Sunday)', () => {
    expect(businessDaysInMonth('2026-11')).toBe(19);
  });
  it('december 2026 has 22 (25/12 is a Friday)', () => {
    expect(businessDaysInMonth('2026-12')).toBe(22);
  });
  it('january 2026 has 21 and february 2026 has 20, 18 with Carnaval', () => {
    expect(businessDaysInMonth('2026-01')).toBe(21);
    expect(businessDaysInMonth('2026-02')).toBe(20);
    expect(businessDaysInMonth('2026-02', { optionalHolidays: ['CARNIVAL'] })).toBe(18);
  });
  it('april 2026 loses Good Friday and Tiradentes (21/04 is a Tuesday)', () => {
    expect(businessDaysInMonth('2026-04')).toBe(20);
  });
  it('june 2026: Corpus Christi (Thursday 04/06) only when switched on', () => {
    expect(businessDaysInMonth('2026-06')).toBe(22);
    expect(businessDaysInMonth('2026-06', { optionalHolidays: ['CORPUS_CHRISTI'] })).toBe(21);
  });
  it('a holiday on a weekend takes nothing off (15/11/2026 is a Sunday: 21 weekdays, only 02/11 and 20/11 go)', () => {
    expect(businessDaysInMonth('2026-11')).toBe(21 - 2);
  });
  it('20/11 only stops counting from 2024', () => {
    // november 2023: 22 weekdays, minus 02/11 (Thursday) and 15/11 (Wednesday); 20/11 (Monday) still counts
    expect(businessDaysInMonth('2023-11')).toBe(20);
    // november 2024: 21 weekdays; 02/11 is a Saturday (nothing off), 15/11 (Friday) and 20/11 (Wednesday) go
    expect(businessDaysInMonth('2024-11')).toBe(19);
  });
  it('"dias sem vale" subtract: MM-DD every year, YYYY-MM-DD only that year, weekends ignored', () => {
    expect(businessDaysInMonth('2026-06', { nonWorkingDays: ['06-24'] })).toBe(21); // Wednesday
    expect(businessDaysInMonth('2027-06', { nonWorkingDays: ['06-24'] })).toBe(businessDaysInMonth('2027-06') - 1); // Thursday
    expect(businessDaysInMonth('2026-07', { nonWorkingDays: ['2026-07-08', '2027-07-08'] })).toBe(businessDaysInMonth('2026-07') - 1);
    expect(businessDaysInMonth('2028-07', { nonWorkingDays: ['2026-07-08'] })).toBe(businessDaysInMonth('2028-07'));
    // 20/06/2026 is a Saturday: nothing to take off
    expect(businessDaysInMonth('2026-06', { nonWorkingDays: ['06-20'] })).toBe(22);
    // the same day listed twice, or already a holiday, takes nothing more
    expect(businessDaysInMonth('2026-11', { nonWorkingDays: ['11-20', '11-20', '2026-11-20'] })).toBe(19);
  });
  it('a malformed month has no business days', () => {
    expect(businessDaysInMonth('2026-13')).toBe(0);
    expect(businessDaysInMonth('')).toBe(0);
    expect(businessDaysInMonth('2026-1')).toBe(0);
  });
  it('isBusinessDay: weekdays that are not holidays', () => {
    expect(isBusinessDay('2026-11-03')).toBe(true); // Tuesday
    expect(isBusinessDay('2026-11-02')).toBe(false); // Finados
    expect(isBusinessDay('2026-11-07')).toBe(false); // Saturday
    expect(isBusinessDay('2026-02-16')).toBe(true);
    expect(isBusinessDay('2026-02-16', { optionalHolidays: ['CARNIVAL'] })).toBe(false);
    expect(isBusinessDay('2026-06-24', { nonWorkingDays: ['06-24'] })).toBe(false);
    expect(isBusinessDay('not a day')).toBe(false);
  });
});

describe('"dias sem vale" values', () => {
  it('accepts real MM-DD and YYYY-MM-DD days', () => {
    for (const ok of ['06-24', '07-08', '02-29', '2026-07-08', '2024-02-29']) expect(isValidNonWorkingDay(ok)).toBe(true);
  });
  it('refuses impossible, malformed and unpadded values', () => {
    for (const bad of ['13-01', '04-31', '00-10', '2026-02-29', '2026-13-01', '6-24', '24/06', '', 'abc', '2026-7-8']) expect(isValidNonWorkingDay(bad)).toBe(false);
  });
  it('normalizes: trims, drops invalid ones, removes duplicates, sorts', () => {
    expect(normalizeNonWorkingDays([' 07-08', '06-24', '06-24', 'xx', '2026-01-02'])).toEqual(['06-24', '07-08', '2026-01-02']);
    expect(normalizeNonWorkingDays(null)).toEqual([]);
  });
});
