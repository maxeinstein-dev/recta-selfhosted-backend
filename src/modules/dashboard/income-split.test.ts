import { describe, expect, it } from 'vitest';
import { buildIncomeSplit, HOUSING_REFERENCE, ownCentsByCategory, type IncomeSplitInput } from './income-split.js';

// Invented data only. Pure part of GET /dashboard/income-split.
const CASA = 'g-casa';
const PESSOAL = 'g-pessoal';
const VAZIO = 'g-vazio';
const groups = [
  { id: CASA, name: 'Casa', sortOrder: 0, color: '#2457E6', isHousing: true },
  { id: PESSOAL, name: 'Pessoal', sortOrder: 1, color: null, isHousing: false },
  { id: VAZIO, name: 'Viagens', sortOrder: 2, color: null, isHousing: false },
];
const groupOf = new Map([
  ['HOUSING', CASA],
  ['UTILITIES', CASA],
  ['HEALTHCARE', PESSOAL],
]);
const input = (over: Partial<IncomeSplitInput> = {}): IncomeSplitInput => ({
  month: '2026-11',
  incomeCents: 1_000_000,
  groups,
  groupOf,
  realizedByCategory: new Map<string | null, number>([
    ['HOUSING', 250_000],
    ['UTILITIES', 33_333],
    ['HEALTHCARE', 12_345],
    ['FOOD', 50_001],
    [null, 999],
  ]),
  committedByCategory: new Map<string | null, number>([
    ['UTILITIES', 10_000],
    ['FOOD', 7_777],
  ]),
  ...over,
});
const cents = (n: number) => Math.round(n * 100);

describe('buildIncomeSplit', () => {
  it('puts each category in its group, realized plus committed, and the ungrouped (or uncategorized) in Outros', () => {
    const split = buildIncomeSplit(input());
    expect(split.groups.map((g) => [g.key, g.name, g.realized, g.committed, g.amount])).toEqual([
      [CASA, 'Casa', 2833.33, 100, 2933.33],
      [PESSOAL, 'Pessoal', 123.45, 0, 123.45],
      [VAZIO, 'Viagens', 0, 0, 0],
      ['OTHER', 'Outros', 510, 77.77, 587.77],
    ]);
    expect(split.groups[3]!.id).toBeNull();
    expect(split.income).toEqual({ amount: 10000, basis: 'expected' });
  });

  it('keeps an empty group in the bar with zero and a zero share', () => {
    const empty = buildIncomeSplit(input()).groups.find((g) => g.key === VAZIO)!;
    expect(empty).toMatchObject({ amount: 0, percentOfIncome: 0 });
  });

  it('adds the groups and the leftover up to the income, to the cent (one sum only)', () => {
    for (const incomeCents of [1_000_000, 333_333, 1, 50_000]) {
      const split = buildIncomeSplit(input({ incomeCents }));
      const total = split.groups.reduce((sum, g) => sum + cents(g.amount), 0) + cents(split.leftover.amount);
      expect(total).toBe(incomeCents);
      expect(cents(split.totalSpent)).toBe(split.groups.reduce((sum, g) => sum + cents(g.amount), 0));
    }
  });

  it('gives a negative leftover when the spending passes the income', () => {
    const split = buildIncomeSplit(input({ incomeCents: 100_000 }));
    expect(split.leftover.amount).toBe(-2644.55);
    expect(split.leftover.percentOfIncome).toBeLessThan(0);
  });

  it('answers null shares (never a division by zero) when there is no income', () => {
    const split = buildIncomeSplit(input({ incomeCents: 0 }));
    expect(split.income.amount).toBe(0);
    for (const g of split.groups) expect(g.percentOfIncome).toBeNull();
    expect(split.leftover).toEqual({ amount: -3644.55, percentOfIncome: null });
    expect(split.housing).toEqual({ amount: 2933.33, percentOfIncome: null, reference: HOUSING_REFERENCE, housingGroups: 1 });
  });

  it('shows housing as a share of the income against the 0.30 reference', () => {
    const split = buildIncomeSplit(input());
    expect(HOUSING_REFERENCE).toBe(0.3);
    expect(split.housing).toEqual({ amount: 2933.33, percentOfIncome: 0.2933, reference: 0.3, housingGroups: 1 });
    expect(split.groups.find((g) => g.key === CASA)!.percentOfIncome).toBe(0.2933);
  });

  it('sums every housing group, and reports zero housing groups when none is marked', () => {
    const both = buildIncomeSplit(input({ groups: groups.map((g) => ({ ...g, isHousing: g.id !== VAZIO })) }));
    expect(both.housing).toMatchObject({ amount: 3056.78, housingGroups: 2 });
    const none = buildIncomeSplit(input({ groups: groups.map((g) => ({ ...g, isHousing: false })) }));
    expect(none.housing).toMatchObject({ amount: 0, percentOfIncome: 0, housingGroups: 0 });
  });

  it('counts a category mapped to a group that no longer exists in Outros', () => {
    const split = buildIncomeSplit(input({ groupOf: new Map([['HOUSING', 'g-apagado']]) }));
    expect(split.groups.find((g) => g.key === 'OTHER')!.amount).toBe(3644.55);
  });
});

describe('ownCentsByCategory', () => {
  const dec = (n: number) => ({ toNumber: () => n });
  it('sums the own share of each expense per category, in whole cents', () => {
    const rows = [
      { id: 't1', categoryName: 'FOOD', amount: dec(-100) },
      { id: 't2', categoryName: 'FOOD', amount: dec(-0.1) },
      { id: 't3', categoryName: 'HOUSING', amount: dec(-1500) },
      { id: 't4', categoryName: null, amount: dec(-20) },
    ];
    const shares = new Map([
      ['t1', { transactionId: 't1', theirCents: 6000, amountCents: 10000, categoryName: 'FOOD' }],
      // what others owe can pass the amount: the own share stops at zero
      ['t3', { transactionId: 't3', theirCents: 999_999, amountCents: 150000, categoryName: 'HOUSING' }],
    ]);
    const out = ownCentsByCategory(rows, shares);
    expect(out.get('FOOD')).toBe(4010);
    expect(out.get('HOUSING')).toBe(0);
    expect(out.get(null)).toBe(2000);
  });
});
