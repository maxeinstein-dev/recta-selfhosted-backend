import { describe, expect, it, vi } from 'vitest';
import { loadInvoiceForecast } from './credit-card-invoice-forecast.js';

// The card statement forecast projects each recurrence with its FORECAST STRATEGY amount, not the stored one
// (the reference month of the occurrence decides the business days). Fake client, invented data only.
type Row = Record<string, any>;
const dec = (n: number) => ({ toNumber: () => n });
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const HH = 'hh-1';
const CARD = 'card-1';
const base = { householdId: HH, accountId: CARD, frequency: 'MONTHLY', isActive: true, endDate: null, startDate: day('2026-01-05'), nextRunAt: day('2026-11-05'), categoryName: 'GROCERIES', competenceOffsetMonths: null };

function rec(over: Row): Row {
  return {
    ...base, followLastAmount: false, forecastStrategy: 'LAST', forecastWindow: null, dailyRate: null, safetyBusinessDays: 0,
    nonWorkingDays: [], optionalHolidays: [], ...over, amount: dec(over.amount),
  };
}

function client(rows: Row[], confirmed: Row[] = []) {
  const calls = { history: 0, categories: 0 };
  return {
    calls,
    db: {
      recurringTransaction: { findMany: vi.fn(async () => rows) },
      category: { findMany: vi.fn(async () => { calls.categories += 1; return []; }) },
      transaction: {
        findMany: vi.fn(async (args: { where: Row }) => {
          if (args.where.paid === true) {
            calls.history += 1;
            return confirmed.filter((t) => args.where.recurringTransactionId.in.includes(t.recurringTransactionId));
          }
          return []; // nothing generated yet in the window
        }),
      },
    } as never,
  };
}

const DATES = { windowStart: '2026-10-11', windowEnd: '2026-11-10', closingDate: '2026-11-11', dueDate: '2026-11-20' };
const params = { householdId: HH, accountId: CARD, dates: DATES, today: '2026-10-20', statementTotalCents: 0 };
const paid = (recurringTransactionId: string, amount: number, date: string) => ({ recurringTransactionId, amount: dec(amount), date: day(date), competenceMonth: null });

describe('loadInvoiceForecast uses the strategy of each recurrence', () => {
  it('one recurrence of each strategy: the registered amount is 100 for all, the projection is not', async () => {
    const rows = [
      rec({ id: 'last', description: 'Ultimo', amount: 100, followLastAmount: true }),
      rec({ id: 'fixed', description: 'Fixo', amount: 120, forecastStrategy: 'FIXED', followLastAmount: true }),
      rec({ id: 'cons', description: 'Conservador', amount: 100, forecastStrategy: 'CONSERVATIVE' }),
      rec({ id: 'day', description: 'Por dia', amount: 100, forecastStrategy: 'PER_BUSINESS_DAY', dailyRate: dec(36), followLastAmount: true }),
    ];
    const history = [paid('cons', 90, '2026-10-05'), paid('cons', 130, '2026-09-05'), paid('cons', 110, '2026-08-05'), paid('cons', 999, '2026-07-05')];
    const { db, calls } = client(rows, history);
    const forecast = await loadInvoiceForecast(db, params);
    const byId = Object.fromEntries(forecast.items.map((i) => [i.recurringTransactionId, i]));
    expect(byId.last).toMatchObject({ amount: 100, followsLastAmount: true });
    expect(byId.fixed).toMatchObject({ amount: 120, followsLastAmount: false });
    // expense: the LARGEST of the last 3 confirmed (the 999 is outside the window)
    expect(byId.cons).toMatchObject({ amount: 130, followsLastAmount: false });
    // november/2026 has 19 business days: 36,00 x 19
    expect(byId.day).toMatchObject({ amount: 684, followsLastAmount: false });
    expect(forecast.total).toBe(100 + 120 + 130 + 684);
    // one history query for the whole card (no query per recurrence)
    expect(calls.history).toBe(1);
  });

  it('the reference month of the occurrence decides the days (offset 1: dated in november, counts for december = 22 days)', async () => {
    const { db } = client([rec({ id: 'day', description: 'Por dia', amount: 100, forecastStrategy: 'PER_BUSINESS_DAY', dailyRate: dec(36), competenceOffsetMonths: 1 })]);
    const forecast = await loadInvoiceForecast(db, params);
    expect(forecast.items).toHaveLength(1);
    expect(forecast.items[0]).toMatchObject({ date: '2026-11-05', amount: 792 });
  });

  it('an income recurrence lowers the invoice by its strategy amount; conservative income takes the smallest', async () => {
    const { db } = client(
      [rec({ id: 'inc', description: 'Estorno', amount: 500, categoryName: 'SALARY', forecastStrategy: 'CONSERVATIVE' })],
      [paid('inc', 300, '2026-10-05'), paid('inc', 200, '2026-09-05')],
    );
    const forecast = await loadInvoiceForecast(db, params);
    expect(forecast.items[0]!.amount).toBe(-200);
    expect(forecast.total).toBe(-200);
  });

  it('an older row without the strategy column behaves as the last value', async () => {
    const row = rec({ id: 'old', description: 'Antigo', amount: 100, followLastAmount: true });
    delete row.forecastStrategy;
    const { db } = client([row]);
    const forecast = await loadInvoiceForecast(db, params);
    expect(forecast.items[0]).toMatchObject({ amount: 100, followsLastAmount: true });
  });
});
