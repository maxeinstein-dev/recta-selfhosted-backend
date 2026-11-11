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

import { computeMonthlyPayroll } from '../payroll/payroll-calc.js';
import { computeThirteenth } from '../payroll/payroll-thirteenth.js';
import { loadCashFlow } from './cash-flow.loader.js';

// Invented data only. Today is 2026-11-10; the period is 90 days (to 2027-02-08).
const TODAY = new Date(Date.UTC(2026, 10, 10));
const utc = (day: string) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))));
const dec = (n: number) => ({ toNumber: () => n });

const HH = '00000000-0000-4000-8000-0000000000f0';
const CHK = '00000000-0000-4000-8000-000000000001';
const SAV = '00000000-0000-4000-8000-000000000002';
const REC = '00000000-0000-4000-8000-0000000000a1';
const REC2 = '00000000-0000-4000-8000-0000000000a2';
const EMP = '00000000-0000-4000-8000-0000000000e1';
const EMP2 = '00000000-0000-4000-8000-0000000000e2';

const account = (id: string) => ({
  id,
  householdId: HH,
  name: id === CHK ? 'Checking' : 'Savings',
  type: 'CHECKING',
  balance: dec(1000),
  currency: 'BRL',
  isActive: true,
  linkedAccountId: null,
});

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

const employment = (over: Record<string, unknown> = {}) => ({
  id: EMP,
  householdId: HH,
  regime: 'CLT',
  employer: 'Acme',
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
  items: [] as unknown[],
  vacations: [] as unknown[],
  fgtsBalances: [] as unknown[],
  fgtsWithdrawals: [] as unknown[],
  fgtsModes: [] as unknown[],
  recurringTransaction: { id: REC, accountId: CHK, isActive: true },
  ...over,
});

function setup(s: { recurrences?: unknown[]; employments?: unknown[]; accounts?: unknown[] } = {}) {
  db.account.findMany.mockResolvedValue(s.accounts ?? [account(CHK), account(SAV)]);
  db.recurringTransaction.findMany.mockResolvedValue(s.recurrences ?? [recurrence()]);
  db.category.findMany.mockResolvedValue([]);
  db.employment.findMany.mockResolvedValue(s.employments ?? []);
  db.transaction.findMany.mockResolvedValue([]);
}

const run = (over: { accountId?: string } = {}) => loadCashFlow({ householdId: HH, days: 90, today: TODAY, accountId: over.accountId });
const flat = (out: Awaited<ReturnType<typeof run>>) => out.days.flatMap((d) => d.events);
const cents = (n: number) => Math.round(n * 100);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cash flow without a linked employment is the same as before', () => {
  it('no employment at all', async () => {
    setup();
    const out = await run();
    const events = flat(out);
    expect(events.every((e) => e.source === 'recurrence')).toBe(true);
    // the recurrence amount (3000) on the dates of the walk, untouched
    expect(events.map((e) => [e.date, e.amount])).toEqual([
      ['2026-12-05', 3000],
      ['2027-01-05', 3000],
      ['2027-02-05', 3000],
    ]);
  });

  it('an employment linked to ANOTHER recurrence, or to an inactive one, changes nothing for this one', async () => {
    setup();
    const baseline = JSON.stringify(await run());
    setup({ employments: [employment({ recurringTransactionId: REC2, recurringTransaction: { id: REC2, accountId: CHK, isActive: true } })] });
    const other = await run();
    // the other recurrence is not in the list: nothing is replaced, but its 13th etc. do enter (it is linked and active)
    expect(flat(other).filter((e) => e.source === 'recurrence')).toEqual(JSON.parse(baseline).days.flatMap((d: { events: unknown[] }) => d.events));
    setup({ employments: [employment({ recurringTransaction: { id: REC, accountId: CHK, isActive: false } })] });
    const inactive = flat(await run());
    expect(inactive.filter((e) => e.source === 'payroll')).toEqual([]);
  });
});

describe('cash flow with a linked employment', () => {
  it('the salary occurrence takes the calculated net of the competence month, with certainty expected', async () => {
    setup({ employments: [employment()] });
    const out = await run();
    const salary = flat(out).filter((e) => e.source === 'recurrence');
    const expectedNet = computeMonthlyPayroll({ date: '2026-12-05', grossCents: 400000, workedDays: 30 }).netCents;
    expect(salary[0]).toMatchObject({ date: '2026-12-05', sourceId: REC, certainty: 'expected' });
    expect(cents(salary[0]!.amount)).toBe(expectedNet);
    expect(salary[0]!.amount).not.toBe(3000);
  });

  it('adds the second 13th installment (the first, in June, is past) as its own event, with the id of the employment', async () => {
    setup({ employments: [employment()] });
    const events = flat(await run()).filter((e) => e.source === 'payroll');
    const t = computeThirteenth({ year: 2026, grossCents: 400000, avos: 12 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ date: '2026-12-20', description: '13º salário (2ª parcela)', sourceId: EMP, accountId: CHK, certainty: 'expected', overdue: false });
    expect(cents(events[0]!.amount)).toBe(t.second.netCents);
  });

  it('a marked vacation (only the month = estimated) pays before it and lowers the salary of the month after', async () => {
    const vacation = { id: 'v1', startDate: null, month: '2027-01', days: null, sellDays: 0, items: [] };
    setup({ employments: [employment({ vacations: [vacation] })] });
    const events = flat(await run());
    const vac = events.find((e) => e.description === 'Férias')!;
    expect(vac).toMatchObject({ source: 'payroll', date: '2026-12-30', certainty: 'estimated', sourceId: EMP });
    expect(vac.amount).toBeGreaterThan(0);
    const feb = events.find((e) => e.source === 'recurrence' && e.date === '2027-02-05')!;
    expect(feb.amount).toBe(0); // 30 days of January are vacation: nothing earned in that competence
    const jan = events.find((e) => e.source === 'recurrence' && e.date === '2027-01-05')!;
    expect(jan.amount).toBeGreaterThan(3000);
  });

  it('the money lands on the account of the employment, and only when that account is in the projection', async () => {
    setup({ employments: [employment({ accountId: SAV })] });
    const both = flat(await run()).filter((e) => e.source === 'payroll');
    expect(both.map((e) => e.accountId)).toEqual([SAV]);
    const onlyChecking = flat(await run({ accountId: CHK })).filter((e) => e.source === 'payroll');
    expect(onlyChecking).toEqual([]);
  });

  it('several employments add up: each event carries its own id', async () => {
    const second = employment({
      id: EMP2,
      recurringTransactionId: REC2,
      recurringTransaction: { id: REC2, accountId: CHK, isActive: true },
      salaries: [{ id: 's2', amount: dec(2500), startDate: utc('2025-01-10') }],
    });
    setup({ recurrences: [recurrence(), recurrence({ id: REC2, description: 'Second job' })], employments: [employment(), second] });
    const payroll = flat(await run()).filter((e) => e.source === 'payroll');
    expect(payroll.map((e) => e.sourceId).sort()).toEqual([EMP, EMP2].sort());
    const amounts = Object.fromEntries(payroll.map((e) => [e.sourceId, e.amount]));
    expect(amounts[EMP]).toBeGreaterThan(amounts[EMP2]!);
  });

  it('the FGTS birthday withdrawal enters on day 1 of the month, estimated, from the informed amount', async () => {
    const mode = { id: 'm1', mode: 'BIRTHDAY', birthdayMonth: 1, expectedAmount: dec(800), startDate: utc('2025-01-10') };
    setup({ employments: [employment({ fgtsModes: [mode] })] });
    const events = flat(await run()).filter((e) => e.description === 'Saque-aniversário FGTS');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: 'payroll', date: '2027-01-01', amount: 800, certainty: 'estimated', sourceId: EMP });
  });

  it('starting balance plus the sum of the events is the ending balance, and nothing is written', async () => {
    const vacation = { id: 'v1', startDate: utc('2027-01-11'), month: null, days: null, sellDays: 0, items: [] };
    setup({ employments: [employment({ vacations: [vacation] })] });
    const out = await run();
    const sum = flat(out).reduce((s, e) => s + cents(e.amount), 0);
    expect(cents(out.startingBalance) + sum).toBe(cents(out.summary.endingBalance));
    // the mock has only reads: a write would have thrown. Make it explicit:
    for (const model of Object.values(db)) expect(Object.keys(model)).toEqual(['findMany']);
  });

  it('an employment that ended no longer pays the salary or extras after its end date', async () => {
    setup({ employments: [employment({ endDate: utc('2026-11-30') })] });
    const events = flat(await run());
    expect(events.filter((e) => e.source === 'payroll')).toEqual([]);
    // competence November was worked until the 30th; December onwards has no salary, so the recurrence amount stays
    expect(events.find((e) => e.source === 'recurrence' && e.date === '2026-12-05')!.amount).not.toBe(3000);
    expect(events.find((e) => e.source === 'recurrence' && e.date === '2027-01-05')!.amount).toBe(3000);
  });
});
