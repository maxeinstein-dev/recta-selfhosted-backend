import { describe, expect, it } from 'vitest';
import {
  balanceAt,
  buildNetWorth,
  cardDebtAt,
  investmentAt,
  lastDayOfMonth,
  monthsEndingAt,
  type NetWorthInput,
} from './net-worth.js';

// Invented data only. Amounts in whole cents.
const TODAY = '2026-11-12';

const empty = (over: Partial<NetWorthInput> = {}): NetWorthInput => ({
  months: ['2026-09', '2026-10', '2026-11'],
  today: TODAY,
  cashAccounts: [],
  investmentAccounts: [],
  cards: [],
  fgts: [],
  reservesByMonth: new Map(),
  flows: new Map(),
  ...over,
});

describe('months', () => {
  it('lists the months up to and including the current one, oldest first', () => {
    expect(monthsEndingAt('2026-11', 3)).toEqual(['2026-09', '2026-10', '2026-11']);
    expect(monthsEndingAt('2026-02', 3)).toEqual(['2025-12', '2026-01', '2026-02']);
  });

  it('finds the last day, February included', () => {
    expect(lastDayOfMonth('2026-10')).toBe('2026-10-31');
    expect(lastDayOfMonth('2026-02')).toBe('2026-02-28');
    expect(lastDayOfMonth('2028-02')).toBe('2028-02-29');
  });
});

describe('balanceAt: the current balance walked back through what moved after the month end', () => {
  const effects = [
    { date: '2026-10-20', cents: -5_000 },
    { date: '2026-11-05', cents: 30_000 },
  ];

  it('the current month is the balance as it is today, future-dated paid entries included', () => {
    // 25/11 is later than today and 05/12 is even in the next month: both are already in the balance the app shows
    expect(balanceAt(100_000, [...effects, { date: '2026-11-25', cents: 7_000 }, { date: '2026-12-05', cents: 1_000 }], '2026-11', TODAY)).toBe(100_000);
  });

  it('a past month removes what moved after its last day', () => {
    expect(balanceAt(100_000, effects, '2026-10', TODAY)).toBe(70_000);
    expect(balanceAt(100_000, effects, '2026-09', TODAY)).toBe(75_000);
  });

  it('an entry on the last day of the month still belongs to that month', () => {
    expect(balanceAt(100_000, [{ date: '2026-10-31', cents: 9_000 }], '2026-10', TODAY)).toBe(100_000);
  });
});

describe('investmentAt: the latest market value up to the month end, plus what was contributed after it', () => {
  const account = {
    id: 'inv',
    name: 'Corretora',
    balanceCents: 1_050_000,
    effects: [
      { date: '2026-10-15', cents: 50_000 },
      { date: '2026-11-03', cents: 20_000 },
    ],
    valuations: [
      { date: '2026-09-30', cents: 1_000_000 },
      { date: '2026-10-31', cents: 1_100_000 },
    ],
  };

  it('uses the value of the month end when there is one (the contribution before it is already inside)', () => {
    expect(investmentAt(account, '2026-10', TODAY)).toEqual({ cents: 1_100_000, source: 'valuation', valuationDate: '2026-10-31' });
  });

  it('adds the net contributions made after the value date', () => {
    // value of 30/09 + the contribution of 15/10
    const onlyFirst = { ...account, valuations: [account.valuations[0]!] };
    expect(investmentAt(onlyFirst, '2026-10', TODAY)).toEqual({ cents: 1_050_000, source: 'valuation', valuationDate: '2026-09-30' });
    // the current month: value of 30/09 + 15/10 + 03/11
    expect(investmentAt(onlyFirst, '2026-11', TODAY).cents).toBe(1_070_000);
  });

  it('without any value up to that month, falls back to what was put in (the account balance then), flagged', () => {
    const noValues = { ...account, valuations: [{ date: '2026-10-31', cents: 1_100_000 }] };
    expect(investmentAt(noValues, '2026-09', TODAY)).toEqual({ cents: 1_050_000 - 50_000 - 20_000, source: 'contributions', valuationDate: null });
  });
});

describe('cardDebtAt: net purchases minus payments, up to the month end (today for the current month)', () => {
  const card = {
    id: 'card',
    name: 'Cartao',
    balanceCents: 0,
    purchases: [
      { date: '2026-09-10', cents: 100_000 },
      { date: '2026-10-05', cents: 50_000 },
      { date: '2026-10-25', cents: -2_000 }, // a refund lowers the debt
      { date: '2026-11-20', cents: 9_000 }, // later than today: not yet
    ],
    payments: [{ date: '2026-10-20', cents: 80_000 }],
  };

  it('walks the debt month by month', () => {
    expect(cardDebtAt(card, '2026-09', TODAY)).toBe(100_000);
    expect(cardDebtAt(card, '2026-10', TODAY)).toBe(100_000 + 50_000 - 2_000 - 80_000);
    expect(cardDebtAt(card, '2026-11', TODAY)).toBe(68_000);
  });

  it('a credit left on the card is not a negative debt', () => {
    expect(cardDebtAt({ ...card, payments: [{ date: '2026-10-20', cents: 500_000 }] }, '2026-10', TODAY)).toBe(0);
  });

  it('a card with no entry at all owes what its balance says', () => {
    expect(cardDebtAt({ id: 'c', name: 'C', balanceCents: 12_345, purchases: [], payments: [] }, '2026-10', TODAY)).toBe(12_345);
    expect(cardDebtAt({ id: 'c', name: 'C', balanceCents: -300, purchases: [], payments: [] }, '2026-10', TODAY)).toBe(0);
  });
});

describe('buildNetWorth', () => {
  const input = empty({
    cashAccounts: [
      { id: 'c1', name: 'Conta', balanceCents: 200_000, effects: [{ date: '2026-11-02', cents: 50_000 }] },
      { id: 'c2', name: 'Carteira', balanceCents: 10_000, effects: [] },
    ],
    investmentAccounts: [
      { id: 'i1', name: 'Corretora', balanceCents: 500_000, effects: [], valuations: [{ date: '2026-10-31', cents: 520_000 }] },
    ],
    cards: [{ id: 'k1', name: 'Cartao', balanceCents: 0, purchases: [{ date: '2026-10-10', cents: 30_000 }], payments: [] }],
    fgts: [
      { id: 'e1', name: 'Empresa A', byMonth: new Map([['2026-09', 800_000], ['2026-10', 810_000], ['2026-11', 820_000]]) },
      { id: 'e2', name: 'Empresa B', byMonth: new Map([['2026-10', 100_000], ['2026-11', 110_000]]) },
    ],
    flows: new Map([
      ['2026-10', { incomeCents: 500_000, expenseCents: 300_000, contributedCents: 50_000 }],
      ['2026-11', { incomeCents: 0, expenseCents: 10_000, contributedCents: 0 }],
    ]),
  });

  const out = buildNetWorth(input);
  const by = (month: string) => out.months.find((m) => m.month === month)!;

  it('every month total is the sum of its parts (cards subtract)', () => {
    for (const m of out.months) {
      expect(m.totalCents).toBe(m.cashCents + m.investmentsCents + m.reservesCents + m.fgtsCents - m.cardDebtCents);
    }
    const nov = by('2026-11');
    expect(nov.cashCents).toBe(210_000);
    expect(nov.investmentsCents).toBe(520_000);
    expect(nov.fgtsCents).toBe(930_000);
    expect(nov.cardDebtCents).toBe(30_000);
    expect(nov.totalCents).toBe(210_000 + 520_000 + 930_000 - 30_000);
  });

  it('a month without data in some part counts that part as zero instead of failing', () => {
    const sep = by('2026-09');
    expect(sep.fgtsCents).toBe(800_000); // company B has nothing yet
    expect(sep.cardDebtCents).toBe(0);
    expect(sep.cashCents).toBe(160_000); // 200000 + 10000 - the 50000 of November
    const bare = buildNetWorth(empty());
    expect(bare.months.map((m) => m.totalCents)).toEqual([0, 0, 0]);
  });

  it('the composition of the last month lists each piece and adds up to its total', () => {
    const kinds = out.composition.map((c) => c.kind);
    expect(kinds).toEqual(['cash', 'cash', 'investment', 'fgts', 'fgts', 'card']);
    expect(out.composition.reduce((s, c) => s + c.cents, 0)).toBe(by('2026-11').totalCents);
    expect(out.composition.find((c) => c.kind === 'card')!.cents).toBe(-30_000);
  });

  it('flags what is an estimate', () => {
    expect(out.composition.filter((c) => c.kind === 'fgts').every((c) => c.estimated)).toBe(true);
    expect(out.composition.find((c) => c.kind === 'investment')!.estimated).toBe(false);
    const noValue = buildNetWorth(
      empty({ investmentAccounts: [{ id: 'i1', name: 'Corretora', balanceCents: 1, effects: [], valuations: [] }] }),
    );
    expect(noValue.composition.find((c) => c.kind === 'investment')!.estimated).toBe(true);
  });

  it('savings: the surplus over the realized income, the contributions apart; no income means no rate', () => {
    expect(by('2026-10').savings).toEqual({ incomeCents: 500_000, expenseCents: 300_000, surplusCents: 200_000, contributedCents: 50_000, rate: 0.4 });
    expect(by('2026-11').savings.rate).toBeNull();
    expect(by('2026-09').savings).toEqual({ incomeCents: 0, expenseCents: 0, surplusCents: 0, contributedCents: 0, rate: null });
  });

  it('reserves are a part of their own, ready for the savings goals to feed (zero today)', () => {
    expect(by('2026-11').reservesCents).toBe(0);
    const withReserves = buildNetWorth({ ...input, reservesByMonth: new Map([['2026-11', 40_000]]) });
    const nov = withReserves.months.find((m) => m.month === '2026-11')!;
    expect(nov.reservesCents).toBe(40_000);
    expect(nov.totalCents).toBe(by('2026-11').totalCents + 40_000);
  });
});
