import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/db/prisma.js', () => ({ prisma: {} }));
vi.mock('./transactions.service.js', () => ({
  calculateCreditCardInvoice: vi.fn(),
  utcToday: () => new Date(Date.UTC(2026, 0, 15)),
}));

import { addMonthKey, buildCommitment, type CommitmentInput } from './credit-card-commitment.js';

// Invented data only.
const invoice = (
  month: string,
  postedCents: number,
  forecastCents: number,
  state: CommitmentInput['state'] = 'open',
): CommitmentInput => ({
  month,
  closingDate: `${month}-03`,
  dueDate: `${month}-10`,
  state,
  postedCents,
  forecastCents,
});

describe('addMonthKey', () => {
  it('walks over the end of the year in both directions', () => {
    expect(addMonthKey('2026-11', 1)).toBe('2026-12');
    expect(addMonthKey('2026-11', 2)).toBe('2027-01');
    expect(addMonthKey('2026-12', 13)).toBe('2028-01');
    expect(addMonthKey('2027-01', -1)).toBe('2026-12');
    expect(addMonthKey('2026-05', 0)).toBe('2026-05');
  });
});

describe('buildCommitment', () => {
  it('adds posted and forecast per invoice and compares with the income of the same month', () => {
    const result = buildCommitment(
      'card-1',
      [invoice('2026-03', 100000, 25000), invoice('2026-04', 40000, 25000)],
      new Map([
        ['2026-03', 500000],
        ['2026-04', 500000],
      ]),
    );
    expect(result.months[0]).toMatchObject({
      month: '2026-03',
      posted: 1000,
      forecast: 250,
      expectedTotal: 1250,
      expectedIncome: 5000,
      incomeShare: 0.25,
    });
    expect(result.months[1]).toMatchObject({ posted: 400, forecast: 250, expectedTotal: 650, incomeShare: 0.13 });
    expect(result.totals).toEqual({ posted: 1400, forecast: 500, expectedTotal: 1900, expectedIncome: 10000, incomeShare: 0.19 });
  });

  it('sums in whole cents: values that drift in binary still add up exactly', () => {
    const result = buildCommitment(
      'card-1',
      [invoice('2026-03', 10, 20), invoice('2026-04', 10, 20), invoice('2026-05', 10, 20)],
      new Map(),
    );
    expect(result.totals.posted).toBe(0.3);
    expect(result.totals.forecast).toBe(0.6);
    expect(result.totals.expectedTotal).toBe(0.9);
  });

  it('incomeShare is null when no income is expected, per month and in the totals', () => {
    const result = buildCommitment('card-1', [invoice('2026-03', 5000, 0)], new Map());
    expect(result.months[0]).toMatchObject({ expectedIncome: 0, incomeShare: null });
    expect(result.totals.incomeShare).toBeNull();
  });

  it('a refund-heavy invoice can be negative, and a month without income does not hide the others', () => {
    const result = buildCommitment(
      'card-1',
      [invoice('2026-03', -3000, 1000), invoice('2026-04', 20000, 0, 'closed')],
      new Map([['2026-04', 80000]]),
    );
    expect(result.months[0]).toMatchObject({ expectedTotal: -20, incomeShare: null });
    expect(result.months[1]).toMatchObject({ state: 'closed', expectedTotal: 200, incomeShare: 0.25 });
    expect(result.totals).toMatchObject({ expectedTotal: 180, expectedIncome: 800, incomeShare: 0.225 });
  });

  it('keeps the order and the dates it was given, and an empty list gives empty totals', () => {
    const result = buildCommitment('card-1', [invoice('2026-05', 1, 0), invoice('2026-03', 2, 0)], new Map());
    expect(result.months.map((m) => m.month)).toEqual(['2026-05', '2026-03']);
    expect(result.months[0]).toMatchObject({ closingDate: '2026-05-03', dueDate: '2026-05-10' });
    expect(buildCommitment('card-1', [], new Map()).totals).toEqual({
      posted: 0,
      forecast: 0,
      expectedTotal: 0,
      expectedIncome: 0,
      incomeShare: null,
    });
  });
});
