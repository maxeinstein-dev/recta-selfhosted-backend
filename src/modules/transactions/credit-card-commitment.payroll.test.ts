import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  transaction: { findMany: vi.fn() },
  recurringTransaction: { findMany: vi.fn() },
  category: { findMany: vi.fn() },
  employment: { findMany: vi.fn() },
}));

vi.mock('../../shared/db/prisma.js', () => ({ prisma: db }));
vi.mock('./transactions.service.js', () => ({ calculateCreditCardInvoice: vi.fn(), utcToday: () => new Date(Date.UTC(2026, 10, 10)) }));

import { computeMonthlyPayroll } from '../payroll/payroll-calc.js';
import { computeThirteenth } from '../payroll/payroll-thirteenth.js';
import { expectedIncomeByMonth } from './credit-card-commitment.js';

// Invented data only.
const utc = (day: string) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))));
const dec = (n: number) => ({ toNumber: () => n });
const HH = '00000000-0000-4000-8000-0000000000f0';
const REC = '00000000-0000-4000-8000-0000000000a1';
const MONTHS = ['2026-11', '2026-12', '2027-01', '2027-02'];

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

const employment = (over: Record<string, unknown> = {}) => ({
  id: 'emp-1',
  householdId: HH,
  regime: 'CLT',
  admissionDate: utc('2025-01-10'),
  endDate: null,
  dependents: 0,
  payDay: 5,
  accountId: null,
  recurringTransactionId: REC,
  bracketMethod: 'DEDUCTION',
  rounding: 'TRUNCATE',
  thirteenthFirstMonth: 6,
  thirteenthFirstDay: 30,
  thirteenthSecondMonth: 12,
  thirteenthSecondDay: 20,
  isActive: true,
  createdAt: utc('2025-01-10'),
  salaries: [{ id: 's1', amount: dec(4000), startDate: utc('2025-01-10') }],
  items: [],
  vacations: [] as unknown[],
  fgtsBalances: [],
  fgtsWithdrawals: [],
  fgtsModes: [],
  recurringTransaction: { id: REC, accountId: 'acc', isActive: true },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.recurringTransaction.findMany.mockResolvedValue([recurrence()]);
  db.category.findMany.mockResolvedValue([]);
  db.transaction.findMany.mockResolvedValue([]);
  db.employment.findMany.mockResolvedValue([]);
});

describe('expected income of the card commitment', () => {
  it('without a linked employment it is the recurrence amount, month by month, as before', async () => {
    const result = await expectedIncomeByMonth(HH, MONTHS);
    expect([...result.entries()]).toEqual(MONTHS.map((m) => [m, 300000]));
  });

  it('with one, the salary is the calculated net paid in the month and the 13th and vacation add to their month', async () => {
    const vacation = { id: 'v1', startDate: null, month: '2027-01', days: null, sellDays: 0, items: [] };
    db.employment.findMany.mockResolvedValue([employment({ vacations: [vacation] })]);
    const result = await expectedIncomeByMonth(HH, MONTHS);

    const net = (paymentDate: string, workedDays: number) => computeMonthlyPayroll({ date: paymentDate, grossCents: 400000, workedDays }).netCents;
    const t = computeThirteenth({ year: 2026, grossCents: 400000, avos: 12 });
    // November pays October's competence; December pays November's plus the 2nd installment of the 13th plus the
    // vacation (paid Dec 30, for the January vacation); January pays December's; February pays January's (all vacation)
    expect(result.get('2026-11')).toBe(net('2026-11-05', 30));
    const december = result.get('2026-12')!;
    expect(december).toBeGreaterThan(net('2026-12-05', 30) + t.second.netCents);
    expect(result.get('2027-01')).toBe(net('2027-01-05', 30));
    expect(result.get('2027-02')).toBe(net('2027-02-05', 0));
  });

  it('the 13th of the month counts even when its date already passed (it is the income of the month)', async () => {
    db.employment.findMany.mockResolvedValue([employment()]);
    const june = await expectedIncomeByMonth(HH, ['2026-06']);
    const t = computeThirteenth({ year: 2026, grossCents: 400000, avos: 12 });
    expect(june.get('2026-06')).toBeGreaterThanOrEqual(t.first.amountCents);
  });

  it('a linked employment on an inactive recurrence adds no 13th', async () => {
    db.employment.findMany.mockResolvedValue([employment({ recurringTransaction: { id: REC, accountId: 'acc', isActive: false } })]);
    db.recurringTransaction.findMany.mockResolvedValue([]);
    const result = await expectedIncomeByMonth(HH, MONTHS);
    expect([...result.values()]).toEqual([0, 0, 0, 0]);
  });
});
