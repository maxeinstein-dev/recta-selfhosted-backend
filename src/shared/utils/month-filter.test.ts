import { afterAll, describe, expect, it } from 'vitest';
import { matchesWhere } from '../__fixtures__/where-eval.js';
import { effectiveMonthRangeWhere, effectiveMonthWhere, monthOrRangeWhere } from './competence.js';
import { parseMonthFilter, utcDayString } from './pagination.js';

/**
 * Month bounds against a `@db.Date` column. The driver sends the UTC date part of a Date bound and Prisma returns the
 * column as UTC midnight, so a month filter is right only when its bounds are UTC-midnight days. Every case runs under
 * the production zone (behind UTC, where the bug showed), UTC, and two zones ahead of it (Tokyo, +14 Kiritimati).
 */
const ZONES = ['America/Sao_Paulo', 'UTC', 'Asia/Tokyo', 'Pacific/Kiritimati'];
const originalTz = process.env.TZ;

afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

// [month, first day, last day]: first/last of each month, a leap and a non-leap February, a year turn, a 30-day month
const MONTHS: Array<[string, string, string]> = [
  ['2026-01', '2026-01-01', '2026-01-31'],
  ['2026-02', '2026-02-01', '2026-02-28'],
  ['2024-02', '2024-02-01', '2024-02-29'],
  ['2100-02', '2100-02-01', '2100-02-28'],
  ['2026-09', '2026-09-01', '2026-09-30'],
  ['2026-10', '2026-10-01', '2026-10-31'],
  ['2026-12', '2026-12-01', '2026-12-31'],
];

const addDay = (day: string, n: number) => utcDayString(new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000));

describe.each(ZONES)('month bounds with TZ=%s', (zone) => {
  const inZone = () => {
    process.env.TZ = zone;
  };

  it.each(MONTHS)('parseMonthFilter(%s) is the first and last day as UTC midnight', (month, first, last) => {
    inZone();
    const { start, end } = parseMonthFilter(month);
    expect(start.toISOString()).toBe(`${first}T00:00:00.000Z`);
    expect(end.toISOString()).toBe(`${last}T00:00:00.000Z`);
  });

  it('utcDayString reads the UTC day, not the local one', () => {
    inZone();
    expect(utcDayString(new Date('2026-10-01T00:00:00.000Z'))).toBe('2026-10-01');
    expect(utcDayString(new Date('2026-10-31T23:59:59.999Z'))).toBe('2026-10-31');
  });

  it('a row on the first day of the next month and one on the last day of the previous month are out', () => {
    inZone();
    for (const [month, first, last] of MONTHS) {
      const where = effectiveMonthWhere(month);
      const row = (date: string) => ({ date, competenceMonth: null });
      expect(matchesWhere(row(first), where as never)).toBe(true);
      expect(matchesWhere(row(last), where as never)).toBe(true);
      expect(matchesWhere(row(addDay(last, 1)), where as never)).toBe(false);
      expect(matchesWhere(row(addDay(first, -1)), where as never)).toBe(false);
    }
  });

  it('every day of a year turn belongs to exactly one month', () => {
    inZone();
    const months = ['2025-11', '2025-12', '2026-01', '2026-02'];
    for (let n = 0; n < 120; n += 1) {
      const date = addDay('2025-11-01', n);
      const hits = months.filter((m) => matchesWhere({ date, competenceMonth: null }, effectiveMonthWhere(m) as never));
      expect(hits, date).toEqual([date.slice(0, 7)]);
    }
  });

  it('a month range covers its first and last day and nothing beside them', () => {
    inZone();
    const where = effectiveMonthRangeWhere('2026-09', '2026-10');
    const hit = (date: string) => matchesWhere({ date, competenceMonth: null }, where as never);
    expect([hit('2026-08-31'), hit('2026-09-01'), hit('2026-10-31'), hit('2026-11-01')]).toEqual([false, true, true, false]);
  });

  it('an explicit startDate/endDate range stays an inclusive date range', () => {
    inZone();
    const where = monthOrRangeWhere({ startDate: new Date(Date.UTC(2026, 8, 30)), endDate: new Date(Date.UTC(2026, 8, 30)) });
    const hit = (date: string) => matchesWhere({ date }, where as never);
    expect([hit('2026-09-29'), hit('2026-09-30'), hit('2026-10-01')]).toEqual([false, true, false]);
  });
});
