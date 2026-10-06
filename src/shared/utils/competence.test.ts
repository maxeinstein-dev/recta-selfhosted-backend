import { describe, expect, it } from 'vitest';
import { matchesWhere } from '../__fixtures__/where-eval.js';
import {
  addMonths,
  competenceWithinRange,
  effectiveMonth,
  effectiveMonthRangeWhere,
  effectiveMonthWhere,
  monthDistance,
  monthOfDate,
  monthOrRangeWhere,
} from './competence.js';

// Invented rows only. date is 'YYYY-MM-DD'; a null competenceMonth is "no reference month".
const rows = [
  { id: 'no-comp-in', date: '2026-10-15', competenceMonth: null },
  { id: 'no-comp-first', date: '2026-10-01', competenceMonth: null },
  { id: 'no-comp-last', date: '2026-10-31', competenceMonth: null },
  { id: 'no-comp-prev', date: '2026-09-30', competenceMonth: null },
  { id: 'no-comp-next', date: '2026-11-01', competenceMonth: null },
  { id: 'voucher', date: '2026-09-25', competenceMonth: '2026-10' },
  { id: 'leaves-oct', date: '2026-10-25', competenceMonth: '2026-11' },
  { id: 'same-month', date: '2026-10-05', competenceMonth: '2026-10' },
  { id: 'back-dated', date: '2026-11-03', competenceMonth: '2026-10' },
];
const idsIn = (where: Record<string, unknown>) => rows.filter((r) => matchesWhere(r, where)).map((r) => r.id);

describe('effectiveMonth', () => {
  it('is the month of the date when there is no reference month', () => {
    expect(effectiveMonth({ date: new Date(Date.UTC(2026, 9, 31)), competenceMonth: null })).toBe('2026-10');
    expect(effectiveMonth({ date: new Date(Date.UTC(2026, 9, 31)) })).toBe('2026-10');
    expect(effectiveMonth({ date: new Date(2026, 0, 1) })).toBe('2026-01');
  });
  it('is the reference month when set, whatever the date', () => {
    expect(effectiveMonth({ date: new Date(Date.UTC(2026, 8, 25)), competenceMonth: '2026-10' })).toBe('2026-10');
  });
  it('monthOfDate reads a local midnight and a stored UTC midnight alike', () => {
    expect(monthOfDate(new Date(2026, 9, 1))).toBe('2026-10');
    expect(monthOfDate(new Date(Date.UTC(2026, 9, 1)))).toBe('2026-10');
  });
});

describe('effectiveMonthWhere', () => {
  it('with no reference month it selects exactly the rows of the date range of the month (old behaviour)', () => {
    const noComp = rows.filter((r) => r.competenceMonth === null);
    const old = noComp.filter((r) => r.date >= '2026-10-01' && r.date <= '2026-10-31').map((r) => r.id);
    expect(noComp.filter((r) => matchesWhere(r, effectiveMonthWhere('2026-10'))).map((r) => r.id)).toEqual(old);
    expect(old).toEqual(['no-comp-in', 'no-comp-first', 'no-comp-last']);
  });
  it('a row dated in September that refers to October counts in October and not in September', () => {
    expect(idsIn(effectiveMonthWhere('2026-10'))).toContain('voucher');
    expect(idsIn(effectiveMonthWhere('2026-09'))).not.toContain('voucher');
    expect(idsIn(effectiveMonthWhere('2026-09'))).toEqual(['no-comp-prev']);
  });
  it('a row dated in October that refers to November leaves October and enters November', () => {
    expect(idsIn(effectiveMonthWhere('2026-10'))).not.toContain('leaves-oct');
    expect(idsIn(effectiveMonthWhere('2026-11'))).toEqual(['no-comp-next', 'leaves-oct']);
  });
  it('a row dated after the month that refers back to it counts in the reference month only', () => {
    expect(idsIn(effectiveMonthWhere('2026-10'))).toContain('back-dated');
    expect(idsIn(effectiveMonthWhere('2026-11'))).not.toContain('back-dated');
  });
  it('first and last day of the month stay in the month', () => {
    const ids = idsIn(effectiveMonthWhere('2026-10'));
    expect(ids).toContain('no-comp-first');
    expect(ids).toContain('no-comp-last');
    expect(ids).not.toContain('no-comp-prev');
    expect(ids).not.toContain('no-comp-next');
  });
  it('every row counts in exactly one month', () => {
    for (const r of rows) {
      const months = ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12'].filter((m) => matchesWhere(r, effectiveMonthWhere(m)));
      expect(months, r.id).toEqual([effectiveMonth({ date: new Date(`${r.date}T00:00:00`), competenceMonth: r.competenceMonth })]);
    }
  });
});

describe('monthOrRangeWhere', () => {
  it('a month is the planning month; it is combined with AND so a search OR next to it is safe', () => {
    const where = monthOrRangeWhere({ month: '2026-10' });
    expect(Object.keys(where)).toEqual(['AND']);
    expect(idsIn({ ...where, OR: [{ id: 'voucher' }, { id: 'leaves-oct' }] })).toEqual(['voucher']);
  });
  it('an explicit range stays a plain date range (cash view): the reference month is ignored', () => {
    const where = monthOrRangeWhere({ startDate: new Date(2026, 8, 20), endDate: new Date(2026, 8, 30) });
    expect(idsIn(where)).toEqual(['no-comp-prev', 'voucher']);
  });
  it('a month wins over a range, and neither means no filter', () => {
    expect(monthOrRangeWhere({ month: '2026-10', startDate: new Date(2026, 0, 1) })).toEqual(monthOrRangeWhere({ month: '2026-10' }));
    expect(monthOrRangeWhere({})).toEqual({});
  });
});

describe('month arithmetic and the +-24 months rule', () => {
  it('moves across years', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-10', 14)).toBe('2027-12');
    expect(monthDistance('2026-10', '2028-10')).toBe(24);
  });
  it('accepts up to 24 months either way and refuses more', () => {
    const date = new Date(Date.UTC(2026, 9, 25));
    expect(competenceWithinRange('2026-11', date)).toBe(true);
    expect(competenceWithinRange('2028-10', date)).toBe(true);
    expect(competenceWithinRange('2024-10', date)).toBe(true);
    expect(competenceWithinRange('2028-11', date)).toBe(false);
    expect(competenceWithinRange('2024-09', date)).toBe(false);
  });
});

describe('effectiveMonthRangeWhere (monthFrom / monthTo)', () => {
  it('selects rows whose effective month is inside the range, by reference month or by date', () => {
    expect(idsIn(effectiveMonthRangeWhere('2026-10', '2026-11'))).toEqual([
      'no-comp-in', 'no-comp-first', 'no-comp-last', 'no-comp-next', 'voucher', 'leaves-oct', 'same-month', 'back-dated',
    ]);
  });
  it('a range of one month is the month filter', () => {
    expect(idsIn(effectiveMonthRangeWhere('2026-10', '2026-10'))).toEqual(idsIn(effectiveMonthWhere('2026-10')));
  });
  it('a row dated in the range that refers outside it is out; one dated outside that refers inside is in', () => {
    const ids = idsIn(effectiveMonthRangeWhere('2026-09', '2026-10'));
    expect(ids).toContain('voucher');
    expect(ids).not.toContain('leaves-oct');
    expect(ids).not.toContain('no-comp-next');
  });
  it('monthOrRangeWhere takes monthFrom/monthTo (one of them alone is a single month) and month wins', () => {
    expect(idsIn(monthOrRangeWhere({ monthFrom: '2026-10', monthTo: '2026-10' }))).toEqual(idsIn(effectiveMonthWhere('2026-10')));
    expect(monthOrRangeWhere({ monthFrom: '2026-10' })).toEqual(monthOrRangeWhere({ monthFrom: '2026-10', monthTo: '2026-10' }));
    expect(monthOrRangeWhere({ month: '2026-10', monthFrom: '2025-01', monthTo: '2027-01' })).toEqual(monthOrRangeWhere({ month: '2026-10' }));
  });
});
