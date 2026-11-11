import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  account: { findMany: vi.fn() },
  transaction: { findMany: vi.fn() },
  recurringTransaction: { findMany: vi.fn() },
  category: { findMany: vi.fn() },
  employment: { findMany: vi.fn() },
}));

vi.mock('../../shared/db/prisma.js', () => ({ prisma: db }));
vi.mock('../transactions/transactions.service.js', () => ({
  calculateCreditCardInvoice: vi.fn(),
  utcToday: () => new Date(Date.UTC(2026, 10, 10)),
}));

import { loadCashFlow } from './cash-flow.loader.js';

// Invented data only. Today is 2026-11-10; the period is 90 days (to 2027-02-08).
const TODAY = new Date(Date.UTC(2026, 10, 10));
const utc = (day: string) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))));
const dec = (n: number) => ({ toNumber: () => n });

const HH = '00000000-0000-4000-8000-0000000000f0';
const CHK = '00000000-0000-4000-8000-000000000001';
const SAV = '00000000-0000-4000-8000-000000000002';
const REC = '00000000-0000-4000-8000-0000000000a1';
const REC_MEAL = '00000000-0000-4000-8000-0000000000a2';
const EMP = '00000000-0000-4000-8000-0000000000e1';

const account = (id: string) => ({ id, householdId: HH, name: id === CHK ? 'Checking' : 'Savings', type: 'CHECKING', balance: dec(1000), currency: 'BRL', isActive: true, linkedAccountId: null });

const recurrence = (over: Record<string, unknown> = {}) => ({
  id: REC,
  householdId: HH,
  accountId: CHK,
  categoryName: 'SALARY',
  amount: dec(3000),
  description: 'Salary',
  frequency: 'MONTHLY',
  startDate: utc('2025-01-05'),
  endDate: null,
  nextRunAt: utc('2026-12-05'),
  isActive: true,
  followLastAmount: false,
  competenceOffsetMonths: null,
  forecastStrategy: 'FIXED',
  forecastWindow: null,
  dailyRate: null,
  safetyBusinessDays: 0,
  nonWorkingDays: [],
  optionalHolidays: [],
  ...over,
});

const mealItem = (over: Record<string, unknown> = {}) => ({
  id: 'item-meal',
  name: 'Meal voucher',
  kind: 'EARNING',
  inInssBase: false,
  inIrrfBase: false,
  inFgtsBase: false,
  calcMode: 'PER_BUSINESS_DAY',
  marginDays: 0,
  payDay: 25,
  referenceMonthOffset: 1,
  accountId: null,
  isAvailableCash: true,
  recurringTransactionId: null,
  recurringTransaction: null,
  values: [{ id: 'v1', amount: dec(12.5), startDate: utc('2026-01-01') }],
  ...over,
});

const employment = (over: Record<string, unknown> = {}) => ({
  id: EMP,
  householdId: HH,
  regime: 'CLT',
  employer: 'Acme',
  admissionDate: utc('2025-01-10'),
  endDate: null,
  dependents: 0,
  payDay: 5,
  accountId: CHK,
  recurringTransactionId: null,
  recurringTransaction: null,
  bracketMethod: 'DEDUCTION',
  rounding: 'TRUNCATE',
  thirteenthFirstMonth: 6,
  thirteenthFirstDay: 30,
  thirteenthSecondMonth: 12,
  thirteenthSecondDay: 20,
  holidayUf: 'SE',
  holidayCity: 'Aracaju',
  optionalHolidaysOff: true,
  isActive: true,
  createdAt: utc('2025-01-10'),
  salaries: [{ id: 's1', amount: dec(4000), startDate: utc('2025-01-10') }],
  items: [mealItem()],
  vacations: [] as unknown[],
  fgtsBalances: [] as unknown[],
  fgtsWithdrawals: [] as unknown[],
  fgtsModes: [] as unknown[],
  ...over,
});

function setup(s: { recurrences?: unknown[]; employments?: Array<Record<string, unknown>> } = {}) {
  db.account.findMany.mockResolvedValue([account(CHK), account(SAV)]);
  db.recurringTransaction.findMany.mockResolvedValue(s.recurrences ?? []);
  db.category.findMany.mockResolvedValue([]);
  db.transaction.findMany.mockResolvedValue([]);
  const rows = s.employments ?? [];
  db.employment.findMany.mockResolvedValue(rows);
}

const run = (over: { accountId?: string } = {}) => loadCashFlow({ householdId: HH, days: 90, today: TODAY, ...over });
const flat = (out: Awaited<ReturnType<typeof run>>) => out.days.flatMap((d) => d.events);
const cents = (n: number) => Math.round(n * 100);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('benefit paid per business day without a recurrence: its own payroll event', () => {
  it('one event per payment date, estimated, on the account of the employment, valued by days x rate', async () => {
    setup({ employments: [employment()] });
    const events = flat(await run()).filter((e) => e.source === 'payroll');
    expect(events.map((e) => [e.date, e.amount, e.certainty, e.accountId, e.description, e.sourceId])).toEqual([
      ['2026-11-25', 22 * 12.5, 'estimated', CHK, 'Meal voucher', EMP], // December 2026: 23 weekdays, 25 December off (8 December is not confirmed)
      ['2026-12-25', 20 * 12.5, 'estimated', CHK, 'Meal voucher', EMP], // January 2027: 21 weekdays, 1 January off
      ['2027-01-25', 18 * 12.5, 'estimated', CHK, 'Meal voucher', EMP], // February 2027: 20 weekdays, carnival (optional, counted as off) 8 and 9
    ]);
  });

  it('a benefit with its own account lands there; without any account it has nowhere to land', async () => {
    setup({ employments: [employment({ items: [mealItem({ accountId: SAV })] })] });
    expect(flat(await run()).filter((e) => e.source === 'payroll').map((e) => e.accountId)).toEqual([SAV, SAV, SAV]);
    setup({ employments: [employment({ accountId: null })] });
    expect(flat(await run()).filter((e) => e.source === 'payroll')).toEqual([]);
    setup({ employments: [employment({ items: [mealItem({ accountId: SAV })] })] });
    expect(flat(await run({ accountId: CHK })).filter((e) => e.source === 'payroll')).toEqual([]); // not in the projection
  });

  it('a benefit that is not available money stays out of the cash flow', async () => {
    setup({ employments: [employment({ items: [mealItem({ isAvailableCash: false })] })] });
    expect(flat(await run()).filter((e) => e.source === 'payroll')).toEqual([]);
  });

  it('an employment with only a benefit adds no 13th, vacation or FGTS event (those need the salary recurrence)', async () => {
    setup({ employments: [employment({ fgtsModes: [{ id: 'm', mode: 'BIRTHDAY', birthdayMonth: 1, expectedAmount: dec(800), startDate: utc('2025-01-10') }] })] });
    const descriptions = flat(await run()).map((e) => e.description);
    expect(descriptions).not.toContain('Saque-aniversário FGTS');
    expect(descriptions.filter((d) => d.startsWith('13º'))).toEqual([]);
  });

  it('the price changes in the middle of the year: months before keep the old value', async () => {
    const values = [
      { id: 'v1', amount: dec(12.5), startDate: utc('2026-01-01') },
      { id: 'v2', amount: dec(13), startDate: utc('2027-01-01') },
    ];
    setup({ employments: [employment({ items: [mealItem({ values })] })] });
    const events = flat(await run()).filter((e) => e.source === 'payroll');
    // references December (12.50) and January (13.00) and February (13.00)
    expect(events.map((e) => e.amount)).toEqual([22 * 12.5, 20 * 13, 18 * 13]);
  });
});

describe('benefit linked to a recurrence: the occurrence takes the calculated value', () => {
  const meal = recurrence({ id: REC_MEAL, description: 'Meal', amount: dec(700), nextRunAt: utc('2026-11-25'), startDate: utc('2025-01-25') });
  const linked = () => employment({ items: [mealItem({ recurringTransactionId: REC_MEAL, recurringTransaction: { id: REC_MEAL, isActive: true } })] });

  it('replaces the recurrence amount and adds no extra event', async () => {
    setup({ recurrences: [meal], employments: [linked()] });
    const events = flat(await run());
    expect(events.filter((e) => e.source === 'payroll')).toEqual([]);
    const rec = events.filter((e) => e.source === 'recurrence');
    expect(rec.map((e) => [e.date, e.amount, e.certainty, e.sourceId])).toEqual([
      ['2026-11-25', 22 * 12.5, 'estimated', REC_MEAL],
      ['2026-12-25', 20 * 12.5, 'estimated', REC_MEAL],
      ['2027-01-25', 18 * 12.5, 'estimated', REC_MEAL],
    ]);
    expect(rec[0]!.amount).not.toBe(700);
  });

  it('the recurrence of another (unlinked) item keeps its own amount', async () => {
    setup({ recurrences: [meal], employments: [employment()] });
    const rec = flat(await run()).filter((e) => e.source === 'recurrence');
    expect(rec.map((e) => e.amount)).toEqual([700, 700, 700]);
  });
});
