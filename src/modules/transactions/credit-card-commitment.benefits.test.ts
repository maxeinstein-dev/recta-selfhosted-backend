import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  transaction: { findMany: vi.fn() },
  recurringTransaction: { findMany: vi.fn() },
  category: { findMany: vi.fn() },
  employment: { findMany: vi.fn() },
  person: { findFirst: vi.fn() },
}));

vi.mock('../../shared/db/prisma.js', () => ({ prisma: db }));
vi.mock('./transactions.service.js', () => ({ calculateCreditCardInvoice: vi.fn(), utcToday: () => new Date(Date.UTC(2026, 10, 10)) }));

import { expectedIncomeByMonth, getCreditCardCommitment } from './credit-card-commitment.js';

// Invented data only. Payment months Nov/2026 .. Feb/2027 pay the benefit of Dec, Jan, Feb and Mar (offset 1).
// Counted days with the Sergipe/Aracaju calendar and optional days off: Dec 2026 = 22, Jan 2027 = 20, Feb 2027 = 18
// (carnival 8 and 9), Mar 2027 = 21 (Good Friday and 17 March).
const utc = (day: string) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))));
const dec = (n: number) => ({ toNumber: () => n });
const HH = '00000000-0000-4000-8000-0000000000f0';
const REC = '00000000-0000-4000-8000-0000000000a1';
const REC_MEAL = '00000000-0000-4000-8000-0000000000a2';
const ANA = '00000000-0000-4000-8000-0000000000b1';
const BIA = '00000000-0000-4000-8000-0000000000b2';
const MONTHS = ['2026-11', '2026-12', '2027-01', '2027-02'];
const DAYS = [22, 20, 18, 21];
const RATE = 1250; // cents

const recurrence = (over: Record<string, unknown> = {}) => ({
  id: REC,
  householdId: HH,
  accountId: 'acc',
  categoryName: 'SALARY',
  amount: dec(3000),
  description: 'Salary',
  frequency: 'MONTHLY',
  startDate: utc('2025-01-05'),
  endDate: null,
  nextRunAt: utc('2026-11-05'),
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

const meal = (over: Record<string, unknown> = {}) => ({
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
  id: 'emp-1',
  householdId: HH,
  personId: ANA,
  regime: 'CLT',
  admissionDate: utc('2025-01-10'),
  endDate: null,
  dependents: 0,
  payDay: 5,
  accountId: null,
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
  items: [meal()],
  vacations: [] as unknown[],
  fgtsBalances: [],
  fgtsWithdrawals: [],
  fgtsModes: [],
  ...over,
});

function setup(employments: Array<Record<string, unknown>>, recurrences: unknown[] = []) {
  db.recurringTransaction.findMany.mockResolvedValue(recurrences);
  db.category.findMany.mockResolvedValue([]);
  db.transaction.findMany.mockResolvedValue([]);
  db.employment.findMany.mockImplementation(async (args: { where: { personId?: string } }) => employments.filter((r) => !args.where.personId || r.personId === args.where.personId));
  db.person.findFirst.mockResolvedValue({ id: ANA });
}
const values = (m: Map<string, number>) => MONTHS.map((k) => m.get(k));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('expected income with benefits paid per business day', () => {
  it('a benefit without a recurrence adds its value in the month it is paid', async () => {
    setup([employment()]);
    expect(values(await expectedIncomeByMonth(HH, MONTHS))).toEqual(DAYS.map((d) => d * RATE));
  });

  it('a benefit that is not available money is never income', async () => {
    setup([employment({ items: [meal({ isAvailableCash: false })] })]);
    expect(values(await expectedIncomeByMonth(HH, MONTHS))).toEqual([0, 0, 0, 0]);
  });

  it('a benefit linked to a recurrence replaces the recurrence amount and is not counted twice', async () => {
    const side = recurrence({ id: REC_MEAL, description: 'Meal', amount: dec(700) });
    setup([employment({ items: [meal({ recurringTransactionId: REC_MEAL, recurringTransaction: { id: REC_MEAL, isActive: true } })] })], [side]);
    expect(values(await expectedIncomeByMonth(HH, MONTHS))).toEqual(DAYS.map((d) => d * RATE));
  });

  it('a recurrence that no benefit feeds keeps its amount (nothing changes for it)', async () => {
    setup([employment()], [recurrence({ id: REC_MEAL, amount: dec(700) })]);
    expect(values(await expectedIncomeByMonth(HH, MONTHS))).toEqual(DAYS.map((d) => 70000 + d * RATE));
  });

  it('without any employment the result is the recurrences alone, as before', async () => {
    setup([], [recurrence()]);
    expect(values(await expectedIncomeByMonth(HH, MONTHS))).toEqual([300000, 300000, 300000, 300000]);
  });
});

describe('expected income filtered by person', () => {
  const ana = () => employment();
  const bia = () => employment({ id: 'emp-2', personId: BIA, items: [meal({ id: 'item-bia', values: [{ id: 'v2', amount: dec(20), startDate: utc('2026-01-01') }] })] });

  it('without the filter both people add up', async () => {
    setup([ana(), bia()]);
    expect(values(await expectedIncomeByMonth(HH, MONTHS))).toEqual(DAYS.map((d) => d * RATE + d * 2000));
  });

  it('with the filter only the person employments count, and recurrences no employment feeds are left out', async () => {
    setup([ana(), bia()], [recurrence({ id: REC_MEAL, amount: dec(700) })]);
    expect(values(await expectedIncomeByMonth(HH, MONTHS, { personId: ANA }))).toEqual(DAYS.map((d) => d * RATE));
    expect(values(await expectedIncomeByMonth(HH, MONTHS, { personId: BIA }))).toEqual(DAYS.map((d) => d * 2000));
  });

  it('the salary of the person counts with the filter and the other one does not', async () => {
    const anaJob = employment({ recurringTransactionId: REC, recurringTransaction: { id: REC, accountId: 'acc', isActive: true }, items: [] });
    const biaJob = employment({ id: 'emp-2', personId: BIA, items: [] });
    setup([anaJob, biaJob], [recurrence()]);
    const withAna = await expectedIncomeByMonth(HH, ['2026-11'], { personId: ANA });
    const withBia = await expectedIncomeByMonth(HH, ['2026-11'], { personId: BIA });
    expect(withAna.get('2026-11')).toBeGreaterThan(0);
    expect(withBia.get('2026-11')).toBe(0);
  });
});

describe('commitment of a card filtered by a person of another household', () => {
  it('answers 404 before reading any invoice', async () => {
    setup([employment()]);
    db.person.findFirst.mockResolvedValue(null);
    await expect(getCreditCardCommitment('card', HH, { personId: ANA })).rejects.toMatchObject({ statusCode: 404 });
    expect(db.employment.findMany).not.toHaveBeenCalled();
  });
});
