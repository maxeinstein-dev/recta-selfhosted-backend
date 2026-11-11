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
  parts: { installmentCents?: number; recurringCents?: number } = {},
): CommitmentInput => ({
  month,
  closingDate: `${month}-03`,
  dueDate: `${month}-10`,
  state,
  postedCents,
  installmentCents: parts.installmentCents ?? 0,
  recurringCents: parts.recurringCents ?? 0,
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
    expect(result.totals).toEqual({ posted: 1400, postedInstallments: 0, postedRecurrences: 0, postedPurchases: 1400, forecast: 500, expectedTotal: 1900, expectedIncome: 10000, incomeShare: 0.19 });
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
      postedInstallments: 0,
      postedRecurrences: 0,
      postedPurchases: 0,
      forecast: 0,
      expectedTotal: 0,
      expectedIncome: 0,
      incomeShare: null,
    });
  });

  describe('posted split into installments, recurrences and purchases', () => {
    const withParts = buildCommitment(
      'card-1',
      [
        // 1000.00 posted = 600.00 installments + 150.00 recurrences + 250.00 purchases
        invoice('2026-03', 100000, 25000, 'open', { installmentCents: 60000, recurringCents: 15000 }),
        // 400.00 posted = 0 installments + 120.00 recurrences + 280.00 purchases (a month without installment)
        invoice('2026-04', 40000, 0, 'open', { recurringCents: 12000 }),
        // -30.00 posted = 0 installments + 0 recurrences + -30.00 purchases (a refund only)
        invoice('2026-05', -3000, 0),
      ],
      new Map(),
    );

    it('the three parts add up to posted in every month and in the totals', () => {
      for (const m of withParts.months) {
        expect(m.postedInstallments + m.postedRecurrences + m.postedPurchases).toBeCloseTo(m.posted, 2);
      }
      const t = withParts.totals;
      expect(t.postedInstallments + t.postedRecurrences + t.postedPurchases).toBeCloseTo(t.posted, 2);
    });

    it('the total does not change: posted and expectedTotal are the same as without the split', () => {
      const plain = buildCommitment(
        'card-1',
        [invoice('2026-03', 100000, 25000), invoice('2026-04', 40000, 0), invoice('2026-05', -3000, 0)],
        new Map(),
      );
      expect(withParts.totals.posted).toBe(plain.totals.posted);
      expect(withParts.totals.expectedTotal).toBe(plain.totals.expectedTotal);
      expect(withParts.totals.forecast).toBe(plain.totals.forecast);
      expect(withParts.months.map((m) => m.posted)).toEqual(plain.months.map((m) => m.posted));
      expect(withParts.months.map((m) => m.expectedTotal)).toEqual(plain.months.map((m) => m.expectedTotal));
    });

    it('splits each month and sums the parts in whole cents', () => {
      expect(withParts.months[0]).toMatchObject({ posted: 1000, postedInstallments: 600, postedRecurrences: 150, postedPurchases: 250 });
      expect(withParts.months[1]).toMatchObject({ posted: 400, postedInstallments: 0, postedRecurrences: 120, postedPurchases: 280 });
      expect(withParts.totals).toMatchObject({ posted: 1370, postedInstallments: 600, postedRecurrences: 270, postedPurchases: 500 });
    });

    it('a month without installments shows zero there and keeps its recurrences and purchases', () => {
      expect(withParts.months[1]).toMatchObject({ postedInstallments: 0, postedRecurrences: 120, postedPurchases: 280 });
      const noInstallment = buildCommitment('card-1', [invoice('2026-06', 5000, 0)], new Map());
      expect(noInstallment.months[0]).toMatchObject({ postedInstallments: 0, postedRecurrences: 0, postedPurchases: 50 });
      expect(noInstallment.totals.postedInstallments).toBe(0);
    });
  });
});
