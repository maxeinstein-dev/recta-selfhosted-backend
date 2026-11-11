/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Employment (CLT) service: CRUD of the employment and its sub-resources, the bruto/líquido simulation and the forecast
 * events. Amounts come in and go out in reais (2 decimals); the calculation runs in whole cents.
 * Every lookup is scoped by the household, so a foreign id is a plain 404.
 */
import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import { conflictOnUnique } from '../people/people.common.js';
import { fromCents, toCents } from '../people/money.js';
import { dayString } from '../recurring-transactions/recurring-dates.js';
import { isIncomeCategory } from '../recurring-transactions/recurring-forecast.js';
import { computeMonthlyPayroll, findGrossForNet, type PayrollItem, type PayrollMethod } from './payroll-calc.js';
import { addDays } from './payroll-dates.js';
import { buildPayrollEvents } from './payroll-events.js';
import { normalizeUf } from './payroll-holidays.js';
import { employmentInclude, toEmploymentData, type EmploymentRow } from './payroll.links.js';
import type {
  CreateEmploymentInput,
  UpdateEmploymentInput,
  VacationInput,
  VacationUpdateInput,
} from './payroll.schema.js';

export const todayString = (now: Date = new Date()): string => dayString(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));

const date = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const reais = (d: { toNumber(): number }): number => d.toNumber();

/**
 * Cents to reais for a whole object tree: a key `fooCents` becomes `foo` (or `fooAmount` when the object already has a
 * `foo`), the value divided by 100. Everything else is copied.
 */
export function moneyDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(moneyDeep);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(src)) {
      if (key.endsWith('Cents') && typeof v === 'number') {
        const base = key.slice(0, -5);
        out[base in src ? `${base}Amount` : base] = fromCents(v);
      } else out[key] = moneyDeep(v);
    }
    return out;
  }
  return value;
}

// Serialization -------------------------------------------------------------

function serializeVacation(v: EmploymentRow['vacations'][number]) {
  return {
    id: v.id,
    startDate: v.startDate ? dayString(v.startDate) : null,
    month: v.month,
    days: v.days,
    sellDays: v.sellDays,
    note: v.note,
    estimated: v.startDate === null,
    items: v.items.map((i) => ({
      id: i.id,
      label: i.label,
      amount: reais(i.amount),
      kind: i.kind,
      inInssBase: i.inInssBase,
      inIrrfBase: i.inIrrfBase,
      inFgtsBase: i.inFgtsBase,
    })),
  };
}

const serializeSalary = (s: { id: string; amount: any; startDate: Date }) => ({ id: s.id, amount: reais(s.amount), startDate: dayString(s.startDate) });
const serializeValue = (v: { id: string; amount: any; startDate: Date }) => ({ id: v.id, amount: reais(v.amount), startDate: dayString(v.startDate) });
const serializeBalance = (b: { id: string; amount: any; asOfDate: Date }) => ({ id: b.id, amount: reais(b.amount), asOfDate: dayString(b.asOfDate) });
const serializeWithdrawal = (w: { id: string; amount: any; date: Date; kind: string; note: string | null }) => ({
  id: w.id,
  amount: reais(w.amount),
  date: dayString(w.date),
  kind: w.kind,
  note: w.note,
});
const serializeMode = (m: { id: string; mode: string; birthdayMonth: number | null; expectedAmount: any; startDate: Date }) => ({
  id: m.id,
  mode: m.mode,
  birthdayMonth: m.birthdayMonth,
  expectedAmount: m.expectedAmount ? reais(m.expectedAmount) : null,
  startDate: dayString(m.startDate),
});
type ItemRow = Omit<EmploymentRow['items'][number], 'recurringTransaction'>;
const serializeItem = (i: ItemRow) => ({
  id: i.id,
  name: i.name,
  kind: i.kind,
  inInssBase: i.inInssBase,
  inIrrfBase: i.inIrrfBase,
  inFgtsBase: i.inFgtsBase,
  calcMode: i.calcMode,
  marginDays: i.marginDays,
  payDay: i.payDay,
  referenceMonthOffset: i.referenceMonthOffset,
  accountId: i.accountId,
  isAvailableCash: i.isAvailableCash,
  recurringTransactionId: i.recurringTransactionId,
  values: i.values.map(serializeValue),
});

export function serializeEmployment(row: EmploymentRow) {
  return {
    id: row.id,
    householdId: row.householdId,
    personId: row.personId,
    regime: row.regime,
    employer: row.employer,
    admissionDate: dayString(row.admissionDate),
    endDate: row.endDate ? dayString(row.endDate) : null,
    dependents: row.dependents,
    payDay: row.payDay,
    accountId: row.accountId,
    recurringTransactionId: row.recurringTransactionId,
    bracketMethod: row.bracketMethod,
    rounding: row.rounding,
    thirteenthFirstMonth: row.thirteenthFirstMonth,
    thirteenthFirstDay: row.thirteenthFirstDay,
    thirteenthSecondMonth: row.thirteenthSecondMonth,
    thirteenthSecondDay: row.thirteenthSecondDay,
    uf: row.holidayUf,
    city: row.holidayCity,
    optionalHolidaysOff: row.optionalHolidaysOff,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    salaries: row.salaries.map(serializeSalary),
    items: row.items.map(serializeItem),
    vacations: row.vacations.map(serializeVacation),
    fgtsBalances: row.fgtsBalances.map(serializeBalance),
    fgtsWithdrawals: row.fgtsWithdrawals.map(serializeWithdrawal),
    fgtsModes: row.fgtsModes.map(serializeMode),
  };
}

// Employment ------------------------------------------------------------------

const full = { include: employmentInclude } as const;

export async function findEmploymentHousehold(id: string): Promise<string | null> {
  const row = await prisma.employment.findUnique({ where: { id }, select: { householdId: true } });
  return row?.householdId ?? null;
}

async function requireEmployment(householdId: string, id: string): Promise<{ id: string }> {
  const row = await prisma.employment.findFirst({ where: { id, householdId }, select: { id: true } });
  if (!row) throw new NotFoundError('Employment');
  return row;
}

/** A person of the household: another household's person (or none) is a plain 404. */
export async function requirePerson(householdId: string, personId: string): Promise<void> {
  const person = await prisma.person.findFirst({ where: { id: personId, householdId }, select: { id: true } });
  if (!person) throw new NotFoundError('Person');
}

async function validateLinks(householdId: string, accountId: string | null | undefined, recurringId: string | null | undefined): Promise<void> {
  if (accountId) {
    const account = await prisma.account.findFirst({ where: { id: accountId, householdId }, select: { type: true } });
    if (!account) throw new NotFoundError('Account');
    if (account.type === 'CREDIT') throw new BadRequestError('The account that receives the salary cannot be a credit card');
  }
  if (recurringId) {
    const rec = await prisma.recurringTransaction.findFirst({ where: { id: recurringId, householdId }, select: { categoryName: true } });
    if (!rec) throw new NotFoundError('Recurring transaction');
    if (!(await isIncomeCategory(prisma, householdId, rec.categoryName))) {
      throw new BadRequestError('The linked recurrence must be an income recurrence');
    }
    // One recurrence feeds one thing: a salary or one benefit, never both
    const used = await prisma.employmentItem.findFirst({ where: { recurringTransactionId: recurringId }, select: { id: true } });
    if (used) throw new ConflictError('That recurrence already feeds a benefit');
  }
}

/** UF is two letters; the city only makes sense with a UF. Returns the normalized pair. */
function normalizeCalendar(uf: string | null | undefined, city: string | null | undefined): { uf: string | null; city: string | null } {
  const u = normalizeUf(uf);
  const c = city?.trim() ? city.trim() : null;
  if (u && !/^[A-Z]{2}$/.test(u)) throw new BadRequestError('uf must be two letters');
  if (c && !u) throw new BadRequestError('The city needs a uf');
  return { uf: u, city: c };
}

function checkShape(s: { admissionDate: string; endDate: string | null; first: [number, number]; second: [number, number] }): void {
  if (s.endDate && s.endDate < s.admissionDate) throw new BadRequestError('endDate cannot be before the admission');
  if (s.first[0] * 100 + s.first[1] > s.second[0] * 100 + s.second[1]) throw new BadRequestError('The first 13th installment cannot come after the second');
}

export async function listEmployments(householdId: string, filter: { personId?: string } = {}) {
  if (filter.personId) await requirePerson(householdId, filter.personId);
  const rows = await prisma.employment.findMany({ where: { householdId, ...(filter.personId ? { personId: filter.personId } : {}) }, orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }], ...full });
  return rows.map(serializeEmployment);
}

export async function getEmployment(householdId: string, id: string) {
  const row = await prisma.employment.findFirst({ where: { id, householdId }, ...full });
  if (!row) throw new NotFoundError('Employment');
  return serializeEmployment(row);
}

export async function createEmployment(input: CreateEmploymentInput) {
  checkShape({
    admissionDate: input.admissionDate,
    endDate: input.endDate ?? null,
    first: [input.thirteenthFirstMonth, input.thirteenthFirstDay],
    second: [input.thirteenthSecondMonth, input.thirteenthSecondDay],
  });
  await requirePerson(input.householdId, input.personId);
  const calendar = normalizeCalendar(input.uf, input.city);
  await validateLinks(input.householdId, input.accountId, input.recurringTransactionId);
  const row = await conflictOnUnique('That recurrence already feeds another employment', 'The account or recurrence was removed meanwhile', () =>
    prisma.employment.create({
      data: {
        householdId: input.householdId,
        personId: input.personId,
        holidayUf: calendar.uf,
        holidayCity: calendar.city,
        optionalHolidaysOff: input.optionalHolidaysOff,
        regime: input.regime,
        employer: input.employer,
        admissionDate: date(input.admissionDate),
        endDate: input.endDate ? date(input.endDate) : null,
        dependents: input.dependents,
        payDay: input.payDay,
        accountId: input.accountId ?? null,
        recurringTransactionId: input.recurringTransactionId ?? null,
        bracketMethod: input.bracketMethod,
        rounding: input.rounding,
        thirteenthFirstMonth: input.thirteenthFirstMonth,
        thirteenthFirstDay: input.thirteenthFirstDay,
        thirteenthSecondMonth: input.thirteenthSecondMonth,
        thirteenthSecondDay: input.thirteenthSecondDay,
        isActive: input.isActive,
      },
      ...full,
    }),
  );
  return serializeEmployment(row);
}

export async function updateEmployment(householdId: string, id: string, input: UpdateEmploymentInput) {
  const current = await prisma.employment.findFirst({ where: { id, householdId } });
  if (!current) throw new NotFoundError('Employment');
  const admissionDate = input.admissionDate ?? dayString(current.admissionDate);
  const endDate = input.endDate !== undefined ? input.endDate : current.endDate ? dayString(current.endDate) : null;
  checkShape({
    admissionDate,
    endDate,
    first: [input.thirteenthFirstMonth ?? current.thirteenthFirstMonth, input.thirteenthFirstDay ?? current.thirteenthFirstDay],
    second: [input.thirteenthSecondMonth ?? current.thirteenthSecondMonth, input.thirteenthSecondDay ?? current.thirteenthSecondDay],
  });
  if (input.personId) await requirePerson(householdId, input.personId);
  const calendar =
    input.uf !== undefined || input.city !== undefined
      ? normalizeCalendar(input.uf !== undefined ? input.uf : current.holidayUf, input.city !== undefined ? input.city : current.holidayCity)
      : null;
  await validateLinks(householdId, input.accountId, input.recurringTransactionId);
  const row = await conflictOnUnique('That recurrence already feeds another employment', 'The account or recurrence was removed meanwhile', () =>
    prisma.employment.update({
      where: { id },
      data: {
        ...(input.personId !== undefined && { personId: input.personId }),
        ...(calendar && { holidayUf: calendar.uf, holidayCity: calendar.city }),
        ...(input.optionalHolidaysOff !== undefined && { optionalHolidaysOff: input.optionalHolidaysOff }),
        ...(input.employer !== undefined && { employer: input.employer }),
        ...(input.admissionDate !== undefined && { admissionDate: date(input.admissionDate) }),
        ...(input.endDate !== undefined && { endDate: input.endDate ? date(input.endDate) : null }),
        ...(input.dependents !== undefined && { dependents: input.dependents }),
        ...(input.payDay !== undefined && { payDay: input.payDay }),
        ...(input.accountId !== undefined && { accountId: input.accountId }),
        ...(input.recurringTransactionId !== undefined && { recurringTransactionId: input.recurringTransactionId }),
        ...(input.bracketMethod !== undefined && { bracketMethod: input.bracketMethod }),
        ...(input.rounding !== undefined && { rounding: input.rounding }),
        ...(input.thirteenthFirstMonth !== undefined && { thirteenthFirstMonth: input.thirteenthFirstMonth }),
        ...(input.thirteenthFirstDay !== undefined && { thirteenthFirstDay: input.thirteenthFirstDay }),
        ...(input.thirteenthSecondMonth !== undefined && { thirteenthSecondMonth: input.thirteenthSecondMonth }),
        ...(input.thirteenthSecondDay !== undefined && { thirteenthSecondDay: input.thirteenthSecondDay }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
      },
      ...full,
    }),
  );
  return serializeEmployment(row);
}

export async function deleteEmployment(householdId: string, id: string): Promise<void> {
  const { count } = await prisma.employment.deleteMany({ where: { id, householdId } });
  if (count === 0) throw new NotFoundError('Employment');
}

// Sub-resources ---------------------------------------------------------------

interface Delegate {
  findMany(args: any): Promise<any[]>;
  findFirst(args: any): Promise<any | null>;
  create(args: any): Promise<any>;
  update(args: any): Promise<any>;
  delete(args: any): Promise<any>;
}

export interface SubService {
  list(householdId: string, employmentId: string): Promise<unknown[]>;
  create(householdId: string, employmentId: string, body: any): Promise<unknown>;
  update(householdId: string, employmentId: string, subId: string, body: any): Promise<unknown>;
  remove(householdId: string, employmentId: string, subId: string): Promise<void>;
}

/** Sub-resource with the employment as direct parent: every query is scoped by the employment AND its household. */
function simpleSub(delegate: Delegate, cfg: { label: string; order: object; conflict: string; toCreate: (b: any) => object; toUpdate: (b: any) => object; out: (r: any) => unknown }): SubService {
  const scope = (householdId: string, employmentId: string) => ({ employmentId, employment: { householdId } });
  const find = async (householdId: string, employmentId: string, subId: string) => {
    const row = await delegate.findFirst({ where: { id: subId, ...scope(householdId, employmentId) } });
    if (!row) throw new NotFoundError(cfg.label);
    return row;
  };
  return {
    async list(householdId, employmentId) {
      await requireEmployment(householdId, employmentId);
      return (await delegate.findMany({ where: scope(householdId, employmentId), orderBy: cfg.order })).map(cfg.out);
    },
    async create(householdId, employmentId, body) {
      await requireEmployment(householdId, employmentId);
      return cfg.out(await conflictOnUnique(cfg.conflict, 'The employment was removed meanwhile', () => delegate.create({ data: { employmentId, ...cfg.toCreate(body) } })));
    },
    async update(householdId, employmentId, subId, body) {
      await find(householdId, employmentId, subId);
      return cfg.out(await conflictOnUnique(cfg.conflict, () => delegate.update({ where: { id: subId }, data: cfg.toUpdate(body) })));
    },
    async remove(householdId, employmentId, subId) {
      await find(householdId, employmentId, subId);
      await delegate.delete({ where: { id: subId } });
    },
  };
}

const c = (v: number) => toCents(v) / 100;
const pick = (v: Record<string, unknown>, map: Record<string, (x: any) => unknown>) =>
  Object.fromEntries(Object.entries(map).filter(([k]) => v[k] !== undefined).map(([k, f]) => [k, f(v[k])]));
const asDate = (x: string) => date(x);
const same = (x: unknown) => x;

export const salaries = simpleSub(prisma.employmentSalary as unknown as Delegate, {
  label: 'Salary entry',
  order: { startDate: 'asc' },
  conflict: 'There is already a salary starting that day',
  toCreate: (b) => ({ amount: c(b.amount), startDate: date(b.startDate) }),
  toUpdate: (b) => pick(b, { amount: c, startDate: asDate }),
  out: serializeSalary,
});

export const fgtsBalances = simpleSub(prisma.employmentFgtsBalance as unknown as Delegate, {
  label: 'FGTS balance',
  order: { asOfDate: 'asc' },
  conflict: 'There is already a balance informed for that date',
  toCreate: (b) => ({ amount: c(b.amount), asOfDate: date(b.asOfDate) }),
  toUpdate: (b) => pick(b, { amount: c, asOfDate: asDate }),
  out: serializeBalance,
});

export const fgtsWithdrawals = simpleSub(prisma.employmentFgtsWithdrawal as unknown as Delegate, {
  label: 'FGTS withdrawal',
  order: { date: 'asc' },
  conflict: 'Conflict',
  toCreate: (b) => ({ amount: c(b.amount), date: date(b.date), kind: b.kind, note: b.note ?? null }),
  toUpdate: (b) => pick(b, { amount: c, date: asDate, kind: same, note: same }),
  out: serializeWithdrawal,
});

export const fgtsModes: SubService = (() => {
  const base = simpleSub(prisma.employmentFgtsMode as unknown as Delegate, {
    label: 'FGTS mode',
    order: { startDate: 'asc' },
    conflict: 'There is already a mode starting that day',
    toCreate: (b) => ({ mode: b.mode, birthdayMonth: b.mode === 'BIRTHDAY' ? b.birthdayMonth : null, expectedAmount: b.mode === 'BIRTHDAY' && b.expectedAmount != null ? c(b.expectedAmount) : null, startDate: date(b.startDate) }),
    toUpdate: (b) => pick(b, { mode: same, birthdayMonth: same, expectedAmount: (x) => (x == null ? null : c(x)), startDate: asDate }),
    out: serializeMode,
  });
  return {
    ...base,
    // The merged record must still satisfy the mode rules (the table also has a CHECK)
    async update(householdId, employmentId, subId, body) {
      const current = await prisma.employmentFgtsMode.findFirst({ where: { id: subId, employmentId, employment: { householdId } } });
      if (!current) throw new NotFoundError('FGTS mode');
      const mode = body.mode ?? current.mode;
      const month = body.birthdayMonth !== undefined ? body.birthdayMonth : current.birthdayMonth;
      if (mode === 'BIRTHDAY' && !month) throw new BadRequestError('The birthday mode needs birthdayMonth');
      if (mode === 'TERMINATION' && (body.birthdayMonth || body.expectedAmount)) throw new BadRequestError('The termination mode has no birthday month or expected amount');
      const patch = { ...body };
      if (mode === 'TERMINATION') Object.assign(patch, { birthdayMonth: null, expectedAmount: null });
      return base.update(householdId, employmentId, subId, patch);
    },
  };
})();

// Vacations (items are replaced as a whole) ------------------------------------

const vacationItems = (items: NonNullable<VacationInput['items']>) =>
  items.map((i) => ({ label: i.label, amount: c(i.amount), kind: i.kind, inInssBase: i.inInssBase, inIrrfBase: i.inIrrfBase, inFgtsBase: i.inFgtsBase }));

export const vacations: SubService = {
  async list(householdId, employmentId) {
    await requireEmployment(householdId, employmentId);
    const rows = await prisma.employmentVacation.findMany({ where: { employmentId, employment: { householdId } }, orderBy: [{ startDate: 'asc' }, { month: 'asc' }], include: { items: true } });
    return rows.map(serializeVacation);
  },
  async create(householdId, employmentId, body: VacationInput) {
    await requireEmployment(householdId, employmentId);
    const row = await prisma.employmentVacation.create({
      data: {
        employmentId,
        startDate: body.startDate ? date(body.startDate) : null,
        month: body.startDate ? null : (body.month ?? null),
        days: body.days ?? null,
        sellDays: body.sellDays,
        note: body.note ?? null,
        items: { create: vacationItems(body.items ?? []) },
      },
      include: { items: true },
    });
    return serializeVacation(row);
  },
  async update(householdId, employmentId, subId, body: VacationUpdateInput) {
    const current = await prisma.employmentVacation.findFirst({ where: { id: subId, employmentId, employment: { householdId } } });
    if (!current) throw new NotFoundError('Vacation');
    const startDate = body.startDate !== undefined ? body.startDate : current.startDate ? dayString(current.startDate) : null;
    const month = body.month !== undefined ? body.month : current.month;
    // Exactly one of them: setting one clears the other unless the caller sends both explicitly
    const finalStart = body.startDate === undefined && body.month ? null : startDate;
    const finalMonth = body.month === undefined && body.startDate ? null : month;
    if ((finalStart ? 1 : 0) + (finalMonth ? 1 : 0) !== 1) throw new BadRequestError('Inform the start date or only the month, not both');
    const days = body.days !== undefined ? body.days : current.days;
    const sellDays = body.sellDays ?? current.sellDays;
    if ((days ?? 0) + sellDays > 30) throw new BadRequestError('days plus sold days cannot exceed 30');
    const row = await prisma.$transaction(async (tx) => {
      if (body.items) await tx.employmentVacationItem.deleteMany({ where: { vacationId: subId } });
      return tx.employmentVacation.update({
        where: { id: subId },
        data: {
          startDate: finalStart ? date(finalStart) : null,
          month: finalStart ? null : finalMonth,
          days,
          sellDays,
          ...(body.note !== undefined && { note: body.note }),
          ...(body.items && { items: { create: vacationItems(body.items) } }),
        },
        include: { items: true },
      });
    });
    return serializeVacation(row);
  },
  async remove(householdId, employmentId, subId) {
    const { count } = await prisma.employmentVacation.deleteMany({ where: { id: subId, employmentId, employment: { householdId } } });
    if (count === 0) throw new NotFoundError('Vacation');
  },
};

// Fixed items and their value history -----------------------------------------

async function requireItem(householdId: string, employmentId: string, itemId: string) {
  const item = await prisma.employmentItem.findFirst({ where: { id: itemId, employmentId, employment: { householdId } } });
  if (!item) throw new NotFoundError('Item');
  return item;
}

interface ItemWrite {
  name?: string;
  kind?: 'EARNING' | 'DEDUCTION';
  inInssBase?: boolean;
  inIrrfBase?: boolean;
  inFgtsBase?: boolean;
  calcMode?: 'FIXED_MONTHLY' | 'PER_BUSINESS_DAY';
  marginDays?: number;
  payDay?: number | null;
  referenceMonthOffset?: number;
  accountId?: string | null;
  isAvailableCash?: boolean;
  recurringTransactionId?: string | null;
}

const ITEM_DEFAULTS = { marginDays: 0, payDay: null, referenceMonthOffset: 0, accountId: null, isAvailableCash: true, recurringTransactionId: null } as const;

/**
 * The calculation fields of an item after a create or update (`current` = the stored row on an update). A per-business-day
 * item is an earning outside every base, with a pay day; a benefit that is not available money cannot feed a recurrence
 * (it would put the money back in the cash flow). A fixed monthly item carries none of the per-day fields.
 */
async function resolveItemCalc(householdId: string, body: ItemWrite, current?: Omit<ItemRow, 'values'>) {
  const mode = body.calcMode ?? current?.calcMode ?? 'FIXED_MONTHLY';
  const pick2 = <K extends keyof typeof ITEM_DEFAULTS>(key: K) => (body[key] !== undefined ? body[key] : current ? (current[key] as ItemWrite[K]) : ITEM_DEFAULTS[key]);
  if (mode === 'FIXED_MONTHLY') {
    const touched = (['marginDays', 'payDay', 'referenceMonthOffset', 'accountId', 'isAvailableCash', 'recurringTransactionId'] as const).filter(
      (k) => body[k] !== undefined && body[k] !== ITEM_DEFAULTS[k],
    );
    if (touched.length > 0) throw new BadRequestError(`${touched.join(', ')} only apply to an item paid per business day`);
    return { calcMode: mode, ...ITEM_DEFAULTS };
  }
  const kind = body.kind ?? current?.kind ?? 'EARNING';
  const bases = {
    inInssBase: body.inInssBase ?? current?.inInssBase ?? false,
    inIrrfBase: body.inIrrfBase ?? current?.inIrrfBase ?? false,
    inFgtsBase: body.inFgtsBase ?? current?.inFgtsBase ?? false,
  };
  if (kind !== 'EARNING') throw new BadRequestError('An item paid per business day must be an earning');
  if (bases.inInssBase || bases.inIrrfBase || bases.inFgtsBase) throw new BadRequestError('An item paid per business day stays outside the INSS, IRRF and FGTS bases');
  const payDay = pick2('payDay');
  if (!payDay) throw new BadRequestError('payDay is required for an item paid per business day');
  const accountId = pick2('accountId');
  const recurringTransactionId = pick2('recurringTransactionId');
  const isAvailableCash = pick2('isAvailableCash');
  if (recurringTransactionId && !isAvailableCash) throw new BadRequestError('A benefit that is not available money cannot feed a recurrence');
  if (accountId || recurringTransactionId) {
    await validateLinks(householdId, accountId, current && current.recurringTransactionId === recurringTransactionId ? null : recurringTransactionId);
  }
  return { calcMode: mode, marginDays: pick2('marginDays'), payDay, referenceMonthOffset: pick2('referenceMonthOffset'), accountId, isAvailableCash, recurringTransactionId };
}

/** A recurrence that already feeds an employment's salary cannot also feed a benefit. */
async function ensureRecurrenceFree(recurringId: string | null | undefined): Promise<void> {
  if (!recurringId) return;
  const used = await prisma.employment.findFirst({ where: { recurringTransactionId: recurringId }, select: { id: true } });
  if (used) throw new ConflictError('That recurrence already feeds an employment');
}

const itemInclude = { values: { orderBy: { startDate: 'asc' } } } as const;

export const items: SubService = {
  async list(householdId, employmentId) {
    await requireEmployment(householdId, employmentId);
    const rows = await prisma.employmentItem.findMany({ where: { employmentId, employment: { householdId } }, orderBy: { createdAt: 'asc' }, include: itemInclude });
    return rows.map(serializeItem);
  },
  async create(householdId, employmentId, body) {
    await requireEmployment(householdId, employmentId);
    const calc = await resolveItemCalc(householdId, body);
    await ensureRecurrenceFree(calc.recurringTransactionId);
    const row = await conflictOnUnique('That recurrence already feeds another benefit', 'The employment, account or recurrence was removed meanwhile', () =>
      prisma.employmentItem.create({
        data: {
          employmentId,
          name: body.name,
          kind: body.kind,
          inInssBase: body.inInssBase,
          inIrrfBase: body.inIrrfBase,
          inFgtsBase: body.inFgtsBase,
          ...calc,
          ...(body.value && { values: { create: [{ amount: c(body.value.amount), startDate: date(body.value.startDate) }] } }),
        },
        include: itemInclude,
      }),
    );
    return serializeItem(row);
  },
  async update(householdId, employmentId, subId, body) {
    const current = await requireItem(householdId, employmentId, subId);
    const touchesCalc = ['calcMode', 'marginDays', 'payDay', 'referenceMonthOffset', 'accountId', 'isAvailableCash', 'recurringTransactionId', 'kind', 'inInssBase', 'inIrrfBase', 'inFgtsBase'].some(
      (k) => body[k] !== undefined,
    );
    const calc = touchesCalc ? await resolveItemCalc(householdId, body, current) : null;
    if (calc && calc.recurringTransactionId !== current.recurringTransactionId) await ensureRecurrenceFree(calc.recurringTransactionId);
    const row = await conflictOnUnique('That recurrence already feeds another benefit', 'The account or recurrence was removed meanwhile', () =>
      prisma.employmentItem.update({
        where: { id: subId },
        data: { ...pick(body, { name: same, kind: same, inInssBase: same, inIrrfBase: same, inFgtsBase: same }), ...(calc ?? {}) },
        include: itemInclude,
      }),
    );
    return serializeItem(row);
  },
  async remove(householdId, employmentId, subId) {
    await requireItem(householdId, employmentId, subId);
    await prisma.employmentItem.delete({ where: { id: subId } });
  },
};

export const itemValues = {
  async list(householdId: string, employmentId: string, itemId: string) {
    await requireItem(householdId, employmentId, itemId);
    const rows = await prisma.employmentItemValue.findMany({ where: { itemId }, orderBy: { startDate: 'asc' } });
    return rows.map(serializeValue);
  },
  async create(householdId: string, employmentId: string, itemId: string, body: { amount: number; startDate: string }) {
    await requireItem(householdId, employmentId, itemId);
    const row = await conflictOnUnique('There is already a value starting that day', 'The item was removed meanwhile', () =>
      prisma.employmentItemValue.create({ data: { itemId, amount: c(body.amount), startDate: date(body.startDate) } }),
    );
    return serializeValue(row);
  },
  async update(householdId: string, employmentId: string, itemId: string, valueId: string, body: { amount?: number; startDate?: string }) {
    await requireItem(householdId, employmentId, itemId);
    const current = await prisma.employmentItemValue.findFirst({ where: { id: valueId, itemId } });
    if (!current) throw new NotFoundError('Item value');
    const row = await conflictOnUnique('There is already a value starting that day', () =>
      prisma.employmentItemValue.update({ where: { id: valueId }, data: pick(body, { amount: c, startDate: asDate }) }),
    );
    return serializeValue(row);
  },
  async remove(householdId: string, employmentId: string, itemId: string, valueId: string) {
    await requireItem(householdId, employmentId, itemId);
    const { count } = await prisma.employmentItemValue.deleteMany({ where: { id: valueId, itemId } });
    if (count === 0) throw new NotFoundError('Item value');
  },
};

// Simulation (no employment needed) ---------------------------------------------

interface SimulationInput {
  date?: string;
  dependents: number;
  items: Array<{ label: string; amount: number; kind: 'EARNING' | 'DEDUCTION'; inInssBase: boolean; inIrrfBase: boolean; inFgtsBase: boolean }>;
  workedDays?: number;
  bracketMethod: 'DEDUCTION' | 'DIRECT';
  rounding: 'TRUNCATE' | 'ROUND';
}

function simulationParts(input: SimulationInput) {
  const method: PayrollMethod = { bracket: input.bracketMethod === 'DIRECT' ? 'direct' : 'deduction', rounding: input.rounding === 'ROUND' ? 'round' : 'truncate' };
  const lines: PayrollItem[] = input.items.map((i) => ({
    label: i.label,
    amountCents: toCents(i.amount),
    kind: i.kind === 'DEDUCTION' ? 'deduction' : 'earning',
    inInssBase: i.inInssBase,
    inIrrfBase: i.inIrrfBase,
    inFgtsBase: i.inFgtsBase,
  }));
  return { date: input.date ?? todayString(), dependents: input.dependents, items: lines, workedDays: input.workedDays, method };
}

export function simulateNet(input: SimulationInput & { gross: number }) {
  const payroll = computeMonthlyPayroll({ ...simulationParts(input), grossCents: toCents(input.gross) });
  return moneyDeep({ payroll });
}

export function simulateGross(input: SimulationInput & { targetNet: number }) {
  try {
    const result = findGrossForNet({ ...simulationParts(input), targetNetCents: toCents(input.targetNet) });
    return moneyDeep(result);
  } catch (error) {
    if (error instanceof Error && error.message.includes('out of reach')) throw new BadRequestError('That net is out of reach');
    throw error;
  }
}

// Forecast events ----------------------------------------------------------------

function eventsRange(q: { from?: string; to?: string }, today: string): { from: string; to: string } {
  const from = q.from ?? today;
  const to = q.to ?? addDays(from, 365);
  if (to < from) throw new BadRequestError('from must not be after to');
  return { from, to };
}

export async function getEmploymentEvents(householdId: string, id: string, q: { from?: string; to?: string }, today = todayString()) {
  const row = await prisma.employment.findFirst({ where: { id, householdId }, ...full });
  if (!row) throw new NotFoundError('Employment');
  if (row.regime !== 'CLT') throw new BadRequestError('Only CLT employments have a payroll forecast');
  const range = eventsRange(q, today);
  return moneyDeep({ ...range, today, ...buildPayrollEvents(toEmploymentData(row), { ...range, today }) });
}

/** The events of every active CLT employment of the household, one entry each (each event set carries its employment id). */
export async function getHouseholdEvents(householdId: string, q: { from?: string; to?: string; personId?: string }, today = todayString()) {
  if (q.personId) await requirePerson(householdId, q.personId);
  const rows = await prisma.employment.findMany({ where: { householdId, isActive: true, regime: 'CLT', ...(q.personId ? { personId: q.personId } : {}) }, orderBy: { createdAt: 'asc' }, ...full });
  const range = eventsRange(q, today);
  return moneyDeep({ ...range, today, employments: rows.map((row) => buildPayrollEvents(toEmploymentData(row), { ...range, today })) });
}
