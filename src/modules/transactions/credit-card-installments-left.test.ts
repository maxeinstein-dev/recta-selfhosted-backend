import { beforeEach, describe, expect, it, vi } from 'vitest';

// Invented data only. The invoice calculation is stubbed per month (it has its own tests); this file pins how the
// commitment walks the unpaid invoices to tell what is still owed in installments.
const db = vi.hoisted(() => ({
  transaction: { findMany: vi.fn(async () => []), findFirst: vi.fn() },
  recurringTransaction: { findMany: vi.fn(async () => []) },
  category: { findMany: vi.fn(async () => []) },
  employment: { findMany: vi.fn(async () => []) },
  person: { findFirst: vi.fn() },
}));
const invoices = vi.hoisted(() => new Map<string, { state: string; installments: number; ids: string[] }>());

vi.mock('../../shared/db/prisma.js', () => ({ prisma: db }));
vi.mock('./transactions.service.js', async (orig) => ({
  ...(await orig<object>()),
  utcToday: () => new Date(Date.UTC(2026, 10, 13)),
  calculateCreditCardInvoice: vi.fn(async (_account: string, month: string) => {
    const inv = invoices.get(month) ?? { state: 'open', installments: 0, ids: [] };
    return {
      data: {
        closingDate: `${month}-02`,
        dueDate: `${month}-09`,
        state: inv.state,
        statementTotal: inv.installments,
        statementInstallments: inv.installments,
        statementInstallmentIds: inv.ids,
        statementRecurrences: 0,
        forecast: { total: 0 },
      },
    };
  }),
}));

const { getCreditCardCommitment } = await import('./credit-card-commitment.js');
const { calculateCreditCardInvoice, statementInstallmentIds } = await import('./transactions.service.js');

const HH = '00000000-0000-4000-8000-0000000000f0';
const CARD = '00000000-0000-4000-8000-0000000000c1';
const latestInstallmentOn = (day: string | null) =>
  db.transaction.findFirst.mockResolvedValue(day ? { date: new Date(`${day}T00:00:00Z`) } : null);
const askedMonths = () => vi.mocked(calculateCreditCardInvoice).mock.calls.map((c) => c[1]);

beforeEach(() => {
  vi.clearAllMocks();
  invoices.clear();
  // Nov/2026 closed and not paid yet, then the parcels run out in Feb/2027.
  invoices.set('2026-11', { state: 'closed', installments: 300, ids: ['sofa', 'mesa'] });
  invoices.set('2026-12', { state: 'open', installments: 300, ids: ['sofa', 'mesa'] });
  invoices.set('2027-01', { state: 'open', installments: 200, ids: ['sofa'] });
  invoices.set('2027-02', { state: 'open', installments: 200, ids: ['sofa'] });
  latestInstallmentOn('2027-01-20');
});

describe('statementInstallmentIds', () => {
  it('lists each installment purchase of the statement once, from its expense rows only', () => {
    const row = (installmentId: string | null, over: Record<string, unknown> = {}) => ({ installmentId, type: 'EXPENSE', categoryName: 'HOUSING', ...over });
    expect(statementInstallmentIds([
      row('sofa'), row('sofa'), row('mesa'), row(null),
      row('estorno', { type: 'INCOME', categoryName: 'OTHER_INCOME' }),
      row('sem-categoria', { categoryName: null }),
    ])).toEqual(['mesa', 'sofa']);
  });
});

describe('commitment: installments still owed', () => {
  it('adds the installments of every unpaid invoice from this month on, also beyond the months asked for', async () => {
    const result = await getCreditCardCommitment(CARD, HH, { months: 2 });
    expect(result.months.map((m) => m.month)).toEqual(['2026-11', '2026-12']);
    expect(result.installments).toEqual({ outstanding: 1000, activeCount: 2, lastMonth: '2027-02' });
  });

  it('stops two months after the latest installment row and computes each invoice once', async () => {
    await getCreditCardCommitment(CARD, HH, { months: 2 });
    expect(askedMonths()).toEqual(['2026-11', '2026-12', '2027-01', '2027-02', '2027-03']);
    expect(db.transaction.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { accountId: CARD, householdId: HH, installmentId: { not: null } },
    }));
  });

  it('leaves out a paid invoice', async () => {
    invoices.set('2026-11', { state: 'paid', installments: 300, ids: ['sofa', 'mesa'] });
    expect((await getCreditCardCommitment(CARD, HH, { months: 1 })).installments).toEqual({ outstanding: 700, activeCount: 2, lastMonth: '2027-02' });
  });

  it('walks from this month even when the months asked for start later', async () => {
    const result = await getCreditCardCommitment(CARD, HH, { months: 1, from: '2027-01' });
    expect(result.months.map((m) => m.month)).toEqual(['2027-01']);
    expect(result.installments.outstanding).toBe(1000);
  });

  it('is zero, with no month, for a card without installments, and walks nothing beyond the months asked for', async () => {
    latestInstallmentOn(null);
    const result = await getCreditCardCommitment(CARD, HH, { months: 2 });
    expect(result.installments).toEqual({ outstanding: 0, activeCount: 0, lastMonth: null });
    expect(askedMonths()).toEqual(['2026-11', '2026-12']);
  });

  it('agrees with the installments of the months shown when they cover every unpaid invoice (one sum)', async () => {
    const result = await getCreditCardCommitment(CARD, HH, { months: 6 });
    const shown = result.months.filter((m) => m.state !== 'paid').reduce((cents, m) => cents + Math.round(m.postedInstallments * 100), 0);
    expect(result.installments.outstanding * 100).toBe(shown);
  });
});
