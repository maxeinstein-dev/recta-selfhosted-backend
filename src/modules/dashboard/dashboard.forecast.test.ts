import { beforeEach, describe, expect, it, vi } from 'vitest';

// The dashboard forecast of next month adds each recurrence by its FORECAST STRATEGY amount, not the stored one.
// Invented data only.
const HH = 'hh-1';
const store = vi.hoisted(() => ({ rec: [] as Array<Record<string, unknown>>, confirmed: [] as Array<Record<string, unknown>>, historyCalls: 0 }));
const dec = (n: number) => ({ toNumber: () => n });

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    transaction: {
      findMany: vi.fn(async (args: { where: { paid?: boolean; recurringTransactionId?: { in: string[] } } }) => {
        if (args.where.paid === true) {
          store.historyCalls += 1;
          return store.confirmed.filter((t) => args.where.recurringTransactionId!.in.includes(t.recurringTransactionId as string));
        }
        return [];
      }),
    },
    account: { findMany: vi.fn(async () => []) },
    budget: { findMany: vi.fn(async () => []) },
    recurringTransaction: { findMany: vi.fn(async () => store.rec) },
    category: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
  },
}));

const { getDashboardOverview } = await import('./dashboard.service.js');

function rec(over: Record<string, unknown>) {
  return {
    householdId: HH, accountId: 'acc', account: { type: 'CHECKING' }, frequency: 'MONTHLY', isActive: true, categoryName: 'SALARY',
    followLastAmount: false, forecastStrategy: 'LAST', forecastWindow: null, dailyRate: null, safetyBusinessDays: 0,
    nonWorkingDays: [], optionalHolidays: [], competenceOffsetMonths: null, ...over, amount: dec(over.amount as number),
  };
}

beforeEach(() => {
  store.rec.length = 0;
  store.confirmed.length = 0;
  store.historyCalls = 0;
});

describe('dashboard forecast by strategy', () => {
  it('per business day: 36,00 x 19 days of november/2026, not the stored 100', async () => {
    store.rec.push(rec({ id: 'r1', amount: 100, forecastStrategy: 'PER_BUSINESS_DAY', dailyRate: dec(36) }));
    const o = await getDashboardOverview({ householdId: HH, month: '2026-10' });
    expect(o.forecast.predictedIncome).toBe(684);
  });

  it('december: the month asked for moves the forecast (22 days = 792,00); a LAST recurrence is still its amount', async () => {
    store.rec.push(rec({ id: 'r1', amount: 100, forecastStrategy: 'PER_BUSINESS_DAY', dailyRate: dec(36) }));
    store.rec.push(rec({ id: 'r2', amount: 50, categoryName: 'UTILITIES' }));
    const o = await getDashboardOverview({ householdId: HH, month: '2026-11' });
    expect(o.forecast.predictedIncome).toBe(792);
    expect(o.forecast.predictedExpense).toBe(50);
  });

  it('conservative: the smallest of the confirmed incomes, the largest of the confirmed expenses, in one history query', async () => {
    store.rec.push(rec({ id: 'inc', amount: 900, forecastStrategy: 'CONSERVATIVE' }));
    store.rec.push(rec({ id: 'exp', amount: 10, categoryName: 'UTILITIES', forecastStrategy: 'CONSERVATIVE' }));
    const row = (recurringTransactionId: string, amount: number, date: string) => ({ recurringTransactionId, amount: dec(amount), date: new Date(`${date}T00:00:00.000Z`), competenceMonth: null });
    store.confirmed.push(row('inc', 700, '2026-09-05'), row('inc', 650, '2026-08-05'), row('exp', 80, '2026-09-05'), row('exp', 95, '2026-08-05'));
    const o = await getDashboardOverview({ householdId: HH, month: '2026-10' });
    expect(o.forecast.predictedIncome).toBe(650);
    expect(o.forecast.predictedExpense).toBe(95);
    expect(store.historyCalls).toBe(1);
  });
});
