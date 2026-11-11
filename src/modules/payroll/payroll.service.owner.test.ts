import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  person: { findFirst: vi.fn() },
  employment: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  employmentItem: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  account: { findFirst: vi.fn() },
  recurringTransaction: { findFirst: vi.fn() },
}));
const income = vi.hoisted(() => ({ isIncomeCategory: vi.fn() }));

vi.mock('../../shared/db/prisma.js', () => ({ prisma: db }));
vi.mock('../recurring-transactions/recurring-forecast.js', () => income);

import { toEmploymentData, type EmploymentRow } from './payroll.links.js';
import { createEmployment, getHouseholdEvents, items, listEmployments, updateEmployment } from './payroll.service.js';
import { createEmploymentSchema } from './payroll.schema.js';

// Invented data only.
const HH = '00000000-0000-4000-8000-0000000000f0';
const EMP = '00000000-0000-4000-8000-0000000000e1';
const ANA = '00000000-0000-4000-8000-0000000000b1';
const REC = '00000000-0000-4000-8000-0000000000a1';
const ACC = '00000000-0000-4000-8000-000000000001';
const dec = (n: number) => ({ toNumber: () => n });
const utc = (d: string) => new Date(`${d}T00:00:00.000Z`);
const error = (statusCode: number) => expect.objectContaining({ statusCode });

const employmentRow = (over: Record<string, unknown> = {}) => ({
  id: EMP,
  householdId: HH,
  personId: ANA,
  regime: 'CLT',
  employer: 'Acme',
  admissionDate: utc('2025-01-10'),
  endDate: null,
  dependents: 0,
  payDay: 5,
  accountId: null,
  recurringTransactionId: null,
  bracketMethod: 'DEDUCTION',
  rounding: 'TRUNCATE',
  thirteenthFirstMonth: 6,
  thirteenthFirstDay: 30,
  thirteenthSecondMonth: 12,
  thirteenthSecondDay: 20,
  holidayUf: null,
  holidayCity: null,
  optionalHolidaysOff: false,
  isActive: true,
  createdAt: utc('2025-01-10'),
  updatedAt: utc('2025-01-10'),
  salaries: [],
  items: [],
  vacations: [],
  fgtsBalances: [],
  fgtsWithdrawals: [],
  fgtsModes: [],
  ...over,
});

const itemRow = (over: Record<string, unknown> = {}) => ({
  id: 'item-1',
  employmentId: EMP,
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
  values: [{ id: 'v1', amount: dec(12.5), startDate: utc('2026-01-01') }],
  ...over,
});

const createInput = (over: Record<string, unknown> = {}) =>
  createEmploymentSchema.parse({ householdId: HH, personId: ANA, employer: 'Acme', admissionDate: '2025-01-10', ...over });

beforeEach(() => {
  vi.resetAllMocks();
  db.person.findFirst.mockResolvedValue({ id: ANA });
  db.employment.findFirst.mockResolvedValue({ id: EMP });
  db.employment.create.mockResolvedValue(employmentRow());
  db.account.findFirst.mockResolvedValue({ type: 'CHECKING' });
  db.recurringTransaction.findFirst.mockResolvedValue({ categoryName: 'SALARY' });
  income.isIncomeCategory.mockResolvedValue(true);
});

describe('employment owner and calendar', () => {
  it('a person of another household is a 404 and nothing is created', async () => {
    db.person.findFirst.mockResolvedValue(null);
    await expect(createEmployment(createInput())).rejects.toEqual(error(404));
    expect(db.person.findFirst).toHaveBeenCalledWith({ where: { id: ANA, householdId: HH }, select: { id: true } });
    expect(db.employment.create).not.toHaveBeenCalled();
  });

  it('stores the owner and the calendar, and serializes them (uf, city, optionalHolidaysOff, personId)', async () => {
    db.employment.create.mockResolvedValue(employmentRow({ holidayUf: 'SE', holidayCity: 'Aracaju', optionalHolidaysOff: true }));
    const out = await createEmployment(createInput({ uf: 'se', city: ' Aracaju ', optionalHolidaysOff: true }));
    expect(db.employment.create.mock.calls[0]![0].data).toMatchObject({ personId: ANA, holidayUf: 'SE', holidayCity: 'Aracaju', optionalHolidaysOff: true });
    expect(out).toMatchObject({ personId: ANA, uf: 'SE', city: 'Aracaju', optionalHolidaysOff: true });
  });

  it('without uf and city the calendar stays empty', async () => {
    await createEmployment(createInput());
    expect(db.employment.create.mock.calls[0]![0].data).toMatchObject({ holidayUf: null, holidayCity: null, optionalHolidaysOff: false });
  });

  it('a city without a uf is refused', async () => {
    await expect(createEmployment({ ...createInput(), city: 'Aracaju' })).rejects.toEqual(error(400));
    expect(db.employment.create).not.toHaveBeenCalled();
  });

  it('update: moving to a person of another household is a 404; clearing the uf while a city stays is a 400', async () => {
    db.employment.findFirst.mockResolvedValue(employmentRow({ holidayUf: 'SE', holidayCity: 'Aracaju' }));
    db.person.findFirst.mockResolvedValue(null);
    await expect(updateEmployment(HH, EMP, { personId: ANA })).rejects.toEqual(error(404));
    db.person.findFirst.mockResolvedValue({ id: ANA });
    await expect(updateEmployment(HH, EMP, { uf: null })).rejects.toEqual(error(400));
    db.employment.update.mockResolvedValue(employmentRow({ holidayUf: null, holidayCity: null }));
    await updateEmployment(HH, EMP, { uf: null, city: null });
    expect(db.employment.update.mock.calls[0]![0].data).toMatchObject({ holidayUf: null, holidayCity: null });
  });

  it('list and household events filter by person, and a foreign person is a 404', async () => {
    db.employment.findMany.mockResolvedValue([]);
    await listEmployments(HH, { personId: ANA });
    expect(db.employment.findMany.mock.calls[0]![0].where).toMatchObject({ householdId: HH, personId: ANA });
    await getHouseholdEvents(HH, { personId: ANA }, '2026-11-10');
    expect(db.employment.findMany.mock.calls[1]![0].where).toMatchObject({ householdId: HH, personId: ANA, isActive: true });
    await listEmployments(HH);
    expect(db.employment.findMany.mock.calls[2]![0].where).toEqual({ householdId: HH });
    await getHouseholdEvents(HH, {}, '2026-11-10');
    expect(db.employment.findMany.mock.calls[3]![0].where).toEqual({ householdId: HH, isActive: true, regime: 'CLT' });

    db.person.findFirst.mockResolvedValue(null);
    await expect(getHouseholdEvents(HH, { personId: ANA })).rejects.toEqual(error(404));
    await expect(listEmployments(HH, { personId: ANA })).rejects.toEqual(error(404));
  });

  it('the household events carry the benefits of each employment, in reais', async () => {
    db.employment.findMany.mockResolvedValue([
      employmentRow({
        salaries: [{ id: 's', amount: dec(3000), startDate: utc('2025-01-10') }],
        items: [itemRow({ recurringTransaction: null })],
        holidayUf: 'SE',
        holidayCity: 'Aracaju',
        optionalHolidaysOff: true,
      }),
    ]);
    const out = (await getHouseholdEvents(HH, { from: '2026-11-01', to: '2026-11-30' }, '2026-11-10')) as { employments: Array<{ benefits: Array<Record<string, unknown>> }> };
    expect(out.employments[0]!.benefits).toEqual([
      expect.objectContaining({ itemId: 'item-1', referenceMonth: '2026-12', paymentDate: '2026-11-25', ratePerDay: 12.5, countedDays: 22, amount: 275, estimated: true, isAvailableCash: true }),
    ]);
  });
});

describe('items: calculation mode', () => {
  const create = (body: Record<string, unknown>) =>
    items.create(HH, EMP, { name: 'Meal voucher', kind: 'EARNING', inInssBase: false, inIrrfBase: false, inFgtsBase: false, calcMode: 'FIXED_MONTHLY', ...body });
  beforeEach(() => {
    db.employmentItem.create.mockResolvedValue(itemRow());
    db.employmentItem.findFirst.mockResolvedValue(null);
  });

  it('a fixed monthly item (the default) is created as before, with the per-day fields reset', async () => {
    db.employmentItem.create.mockResolvedValue(itemRow({ calcMode: 'FIXED_MONTHLY', payDay: null, referenceMonthOffset: 0 }));
    await create({});
    expect(db.employmentItem.create.mock.calls[0]![0].data).toMatchObject({
      calcMode: 'FIXED_MONTHLY',
      marginDays: 0,
      payDay: null,
      referenceMonthOffset: 0,
      accountId: null,
      isAvailableCash: true,
      recurringTransactionId: null,
    });
  });

  it('a fixed item refuses the fields that only make sense per business day', async () => {
    for (const bad of [{ payDay: 25 }, { marginDays: 1 }, { referenceMonthOffset: 1 }, { isAvailableCash: false }, { accountId: ACC }, { recurringTransactionId: REC }]) {
      await expect(create(bad)).rejects.toEqual(error(400));
    }
    expect(db.employmentItem.create).not.toHaveBeenCalled();
  });

  it('a per-business-day item needs a pay day, an earning, and no base', async () => {
    await expect(create({ calcMode: 'PER_BUSINESS_DAY' })).rejects.toEqual(error(400));
    await expect(create({ calcMode: 'PER_BUSINESS_DAY', payDay: 25, kind: 'DEDUCTION' })).rejects.toEqual(error(400));
    for (const flag of ['inInssBase', 'inIrrfBase', 'inFgtsBase']) {
      await expect(create({ calcMode: 'PER_BUSINESS_DAY', payDay: 25, [flag]: true })).rejects.toEqual(error(400));
    }
    expect(db.employmentItem.create).not.toHaveBeenCalled();
    await create({ calcMode: 'PER_BUSINESS_DAY', payDay: 25, referenceMonthOffset: 1, marginDays: 2 });
    expect(db.employmentItem.create.mock.calls[0]![0].data).toMatchObject({ calcMode: 'PER_BUSINESS_DAY', payDay: 25, referenceMonthOffset: 1, marginDays: 2, isAvailableCash: true });
  });

  it('a benefit that is not available money cannot feed a recurrence', async () => {
    await expect(create({ calcMode: 'PER_BUSINESS_DAY', payDay: 25, isAvailableCash: false, recurringTransactionId: REC })).rejects.toEqual(error(400));
    await create({ calcMode: 'PER_BUSINESS_DAY', payDay: 25, isAvailableCash: false });
    expect(db.employmentItem.create).toHaveBeenCalledTimes(1);
  });

  it('the linked recurrence has to be an income of the household, not the salary recurrence of an employment, not taken by another benefit', async () => {
    const body = { calcMode: 'PER_BUSINESS_DAY', payDay: 25, recurringTransactionId: REC };
    db.recurringTransaction.findFirst.mockResolvedValue(null);
    await expect(create(body)).rejects.toEqual(error(404));
    db.recurringTransaction.findFirst.mockResolvedValue({ categoryName: 'FOOD' });
    income.isIncomeCategory.mockResolvedValue(false);
    await expect(create(body)).rejects.toEqual(error(400));
    income.isIncomeCategory.mockResolvedValue(true);
    // already fed by another benefit
    db.employmentItem.findFirst.mockResolvedValue({ id: 'other' });
    await expect(create(body)).rejects.toEqual(error(409));
    // feeding the salary of an employment (the second employment lookup of the call)
    db.employmentItem.findFirst.mockResolvedValue(null);
    db.employment.findFirst.mockResolvedValueOnce({ id: EMP }).mockResolvedValueOnce({ id: 'salary-owner' });
    await expect(create(body)).rejects.toEqual(error(409));
    expect(db.employmentItem.create).not.toHaveBeenCalled();
    db.employment.findFirst.mockReset();
    db.employment.findFirst.mockResolvedValueOnce({ id: EMP }).mockResolvedValue(null);
    await create(body);
    expect(db.employmentItem.create.mock.calls[0]![0].data).toMatchObject({ recurringTransactionId: REC });
  });

  it('the destination account must belong to the household and cannot be a card', async () => {
    const body = { calcMode: 'PER_BUSINESS_DAY', payDay: 25, accountId: ACC };
    db.account.findFirst.mockResolvedValue(null);
    await expect(create(body)).rejects.toEqual(error(404));
    db.account.findFirst.mockResolvedValue({ type: 'CREDIT' });
    await expect(create(body)).rejects.toEqual(error(400));
  });

  it('update: switching back to fixed monthly clears the per-day fields; a rename touches nothing else', async () => {
    db.employmentItem.findFirst.mockResolvedValue(itemRow({ marginDays: 3 }));
    db.employmentItem.update.mockResolvedValue(itemRow());
    await items.update(HH, EMP, 'item-1', { calcMode: 'FIXED_MONTHLY' });
    expect(db.employmentItem.update.mock.calls[0]![0].data).toMatchObject({
      calcMode: 'FIXED_MONTHLY',
      marginDays: 0,
      payDay: null,
      referenceMonthOffset: 0,
      accountId: null,
      isAvailableCash: true,
      recurringTransactionId: null,
    });
    await items.update(HH, EMP, 'item-1', { name: 'Renamed' });
    expect(db.employmentItem.update.mock.calls[1]![0].data).toEqual({ name: 'Renamed' });
  });

  it('update: the merged item is validated (a base flag on a per-day item is refused; the margin can change alone)', async () => {
    db.employmentItem.findFirst.mockResolvedValue(itemRow());
    db.employmentItem.update.mockResolvedValue(itemRow({ marginDays: 2 }));
    await expect(items.update(HH, EMP, 'item-1', { inInssBase: true })).rejects.toEqual(error(400));
    await items.update(HH, EMP, 'item-1', { marginDays: 2 });
    expect(db.employmentItem.update.mock.calls[0]![0].data).toMatchObject({ calcMode: 'PER_BUSINESS_DAY', marginDays: 2, payDay: 25 });
  });

  it('serializes the new fields of an item', async () => {
    db.employmentItem.create.mockResolvedValue(itemRow({ accountId: ACC, isAvailableCash: false }));
    expect(await create({ calcMode: 'PER_BUSINESS_DAY', payDay: 25, accountId: ACC, isAvailableCash: false })).toMatchObject({
      calcMode: 'PER_BUSINESS_DAY',
      marginDays: 0,
      payDay: 25,
      referenceMonthOffset: 1,
      accountId: ACC,
      isAvailableCash: false,
      recurringTransactionId: null,
      values: [{ id: 'v1', amount: 12.5, startDate: '2026-01-01' }],
    });
  });
});

describe('toEmploymentData: items, benefits and calendar', () => {
  const row = employmentRow({
    holidayUf: 'SE',
    holidayCity: 'Aracaju',
    optionalHolidaysOff: true,
    accountId: ACC,
    items: [
      itemRow({ id: 'fixed', name: 'Allowance', calcMode: 'FIXED_MONTHLY', payDay: null, referenceMonthOffset: 0, recurringTransaction: null }),
      itemRow({ id: 'daily', recurringTransactionId: REC, recurringTransaction: { id: REC, isActive: true }, marginDays: 1, accountId: null }),
    ],
  }) as unknown as EmploymentRow;

  it('the payslip items are only the fixed ones; the per-day ones become benefits', () => {
    const d = toEmploymentData(row);
    expect(d.items.map((i) => i.id)).toEqual(['fixed']);
    expect(d.benefits).toEqual([
      {
        id: 'daily',
        name: 'Meal voucher',
        values: [{ startDate: '2026-01-01', amountCents: 1250 }],
        payDay: 25,
        referenceMonthOffset: 1,
        accountId: null,
        isAvailableCash: true,
        recurringTransactionId: REC,
        recurrenceActive: true,
        marginDays: 1,
      },
    ]);
    expect(d).toMatchObject({ personId: ANA, accountId: ACC, calendar: { uf: 'SE', city: 'Aracaju', optionalOff: true } });
  });

  it('a row without uf has no calendar; rows from before the new columns (undefined) still map', () => {
    expect(toEmploymentData({ ...row, holidayUf: null } as unknown as EmploymentRow).calendar).toBeNull();
    const old = toEmploymentData({ ...row, personId: undefined, holidayUf: undefined, items: [{ ...(row.items[0] as object), calcMode: undefined }] } as unknown as EmploymentRow);
    expect(old.calendar).toBeNull();
    expect(old.personId).toBeNull();
    expect(old.items).toHaveLength(1);
    expect(old.benefits).toEqual([]);
  });
});
