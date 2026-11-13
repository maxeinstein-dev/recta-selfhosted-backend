import { describe, expect, it } from 'vitest';

import { allocatedCentsByAccount, contributionDate, monthsBetween, plannedContributions, plannedCentsFor, type PlanGoal } from './savings-goals.planning.js';

// Invented data only.
const goal = (over: Partial<PlanGoal> = {}): PlanGoal => ({
  id: 'g1',
  accountId: 'acc-1',
  name: 'Emergency',
  kind: 'RESERVE',
  targetCents: 600000,
  currentCents: 100000,
  monthlyCents: 50000,
  contributionDay: 10,
  dueMonth: null,
  ...over,
});

describe('monthsBetween', () => {
  it('counts calendar months, inclusive of both ends', () => {
    expect(monthsBetween('2026-11', '2026-11')).toBe(1);
    expect(monthsBetween('2026-11', '2027-02')).toBe(4);
    expect(monthsBetween('2026-11', '2026-10')).toBe(0);
  });
});

describe('plannedCentsFor', () => {
  it('RESERVE: the monthly contribution, capped by what is missing to the target', () => {
    expect(plannedCentsFor(goal(), '2026-11', 100000)).toBe(50000);
    expect(plannedCentsFor(goal(), '2026-11', 30000)).toBe(30000);
    expect(plannedCentsFor(goal(), '2026-11', 0)).toBe(0);
  });

  it('RESERVE without a monthly contribution plans nothing', () => {
    expect(plannedCentsFor(goal({ monthlyCents: null }), '2026-11', 500000)).toBe(0);
  });

  it('PROVISION without a monthly value: what is missing divided by the months left up to the due month (rounded up)', () => {
    const g = goal({ kind: 'PROVISION', dueMonth: '2027-02', monthlyCents: null, targetCents: 120000, currentCents: 20000 });
    // 1000.00 missing, 4 months (Nov, Dec, Jan, Feb) => 250.00
    expect(plannedCentsFor(g, '2026-11', 100000)).toBe(25000);
    // after the Nov contribution, 750.00 over 3 months
    expect(plannedCentsFor(g, '2026-12', 75000)).toBe(25000);
    // not divisible: 1000.01 / 3 rounds up, the last month takes the rest through the cap
    expect(plannedCentsFor(g, '2026-12', 100001)).toBe(33334);
  });

  it('PROVISION: in the due month the whole rest is planned; after it nothing (the bill is past)', () => {
    const g = goal({ kind: 'PROVISION', dueMonth: '2027-02', monthlyCents: null });
    expect(plannedCentsFor(g, '2027-02', 40000)).toBe(40000);
    expect(plannedCentsFor(g, '2027-03', 40000)).toBe(0);
  });

  it('PROVISION with a monthly value uses it (capped), the user chose the pace', () => {
    const g = goal({ kind: 'PROVISION', dueMonth: '2027-02', monthlyCents: 10000 });
    expect(plannedCentsFor(g, '2026-11', 100000)).toBe(10000);
  });
});

describe('contributionDate', () => {
  it('is the contribution day of the month', () => {
    expect(contributionDate('2026-11', 10)).toBe('2026-11-10');
    expect(contributionDate('2026-02', 28)).toBe('2026-02-28');
  });
});

describe('plannedContributions', () => {
  const base = { today: '2026-11-12', end: '2027-01-31', doneMonths: new Set<string>() };

  it('lists the months from today to the end, on the contribution day', () => {
    const out = plannedContributions([goal()], base);
    expect(out.map((p) => [p.month, p.date, p.amountCents])).toEqual([
      ['2026-11', '2026-11-10', 50000],
      ['2026-12', '2026-12-10', 50000],
      ['2027-01', '2027-01-10', 50000],
    ]);
  });

  it('a month already contributed to is not planned again; the running balance counts the money kept', () => {
    const out = plannedContributions([goal({ targetCents: 160000 })], { ...base, doneMonths: new Set(['g1:2026-11']) });
    // 1000 kept of 1600: Dec 500, Jan only the 100 that is left
    expect(out.map((p) => [p.month, p.amountCents])).toEqual([['2026-12', 50000], ['2027-01', 10000]]);
  });

  it('the planned amounts of the months add up: they stop once the target is reached', () => {
    const out = plannedContributions([goal({ targetCents: 130000 })], base);
    expect(out.map((p) => p.amountCents)).toEqual([30000]);
  });

  it('a past contribution day of this month is overdue, not dropped (the builder moves it to today)', () => {
    const [first] = plannedContributions([goal()], base);
    expect(first).toMatchObject({ month: '2026-11', date: '2026-11-10' });
  });

  it('a goal without account or without a day plans nothing (nowhere to take the money from)', () => {
    expect(plannedContributions([goal({ accountId: null })], base)).toEqual([]);
    expect(plannedContributions([goal({ contributionDay: null })], base)).toEqual([]);
  });

  it('a provision stops after its due month', () => {
    const out = plannedContributions([goal({ kind: 'PROVISION', dueMonth: '2026-12', monthlyCents: null, targetCents: 160000 })], base);
    expect(out.map((p) => [p.month, p.amountCents])).toEqual([['2026-11', 30000], ['2026-12', 30000]]);
    // 600.00 missing over 2 months
  });
});

describe('allocatedCentsByAccount', () => {
  it('sums what the goals hold per account; goals without account hold nothing in any account', () => {
    const map = allocatedCentsByAccount([
      goal({ id: 'a', accountId: 'x', currentCents: 100000 }),
      goal({ id: 'b', accountId: 'x', currentCents: 25050 }),
      goal({ id: 'c', accountId: 'y', currentCents: 7000 }),
      goal({ id: 'd', accountId: null, currentCents: 99999 }),
    ]);
    expect(map.get('x')).toBe(125050);
    expect(map.get('y')).toBe(7000);
    expect(map.size).toBe(2);
  });
});
