import { z } from 'zod';

import { MAX_AMOUNT } from '../people/money.js';
import { dayString, householdQuerySchema, uuid } from '../people/people.schema.js';

export { dayString, householdQuerySchema, uuid };

/** Reais with at most 2 decimals are checked when converted to cents (BadRequest); here only the range. */
const money = z.number().min(0).max(MAX_AMOUNT);
const positiveMoney = z.number().positive().max(MAX_AMOUNT);
const monthKey = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be YYYY-MM');
const text = (max: number) => z.string().trim().min(1).max(max);

export const idParamSchema = z.object({ id: uuid });
export const subParamSchema = z.object({ id: uuid, subId: uuid });
export const valueParamSchema = z.object({ id: uuid, subId: uuid, valueId: uuid });
export const householdHintQuerySchema = z.object({ householdId: uuid.optional() });

export const regimeSchema = z.enum(['CLT']);
const bracketMethod = z.enum(['DEDUCTION', 'DIRECT']);
const rounding = z.enum(['TRUNCATE', 'ROUND']);
const itemKind = z.enum(['EARNING', 'DEDUCTION']);
const monthNumber = z.number().int().min(1).max(12);
const dayNumber = z.number().int().min(1).max(31);

const employmentFields = {
  regime: regimeSchema,
  employer: text(120),
  admissionDate: dayString,
  endDate: dayString.nullable(),
  dependents: z.number().int().min(0).max(20),
  payDay: dayNumber,
  accountId: uuid.nullable(),
  recurringTransactionId: uuid.nullable(),
  bracketMethod,
  rounding,
  thirteenthFirstMonth: monthNumber,
  thirteenthFirstDay: dayNumber,
  thirteenthSecondMonth: monthNumber,
  thirteenthSecondDay: dayNumber,
  isActive: z.boolean(),
};

export const createEmploymentSchema = z.object({
  householdId: uuid,
  regime: employmentFields.regime.default('CLT'),
  employer: employmentFields.employer,
  admissionDate: employmentFields.admissionDate,
  endDate: employmentFields.endDate.optional(),
  dependents: employmentFields.dependents.default(0),
  payDay: employmentFields.payDay.default(5),
  accountId: employmentFields.accountId.optional(),
  recurringTransactionId: employmentFields.recurringTransactionId.optional(),
  bracketMethod: bracketMethod.default('DEDUCTION'),
  rounding: rounding.default('TRUNCATE'),
  thirteenthFirstMonth: monthNumber.default(6),
  thirteenthFirstDay: dayNumber.default(30),
  thirteenthSecondMonth: monthNumber.default(12),
  thirteenthSecondDay: dayNumber.default(20),
  isActive: z.boolean().default(true),
});
export type CreateEmploymentInput = z.infer<typeof createEmploymentSchema>;

export const updateEmploymentSchema = z
  .object({
    employer: employmentFields.employer.optional(),
    admissionDate: employmentFields.admissionDate.optional(),
    endDate: employmentFields.endDate.optional(),
    dependents: employmentFields.dependents.optional(),
    payDay: employmentFields.payDay.optional(),
    accountId: employmentFields.accountId.optional(),
    recurringTransactionId: employmentFields.recurringTransactionId.optional(),
    bracketMethod: bracketMethod.optional(),
    rounding: rounding.optional(),
    thirteenthFirstMonth: monthNumber.optional(),
    thirteenthFirstDay: dayNumber.optional(),
    thirteenthSecondMonth: monthNumber.optional(),
    thirteenthSecondDay: dayNumber.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });
export type UpdateEmploymentInput = z.infer<typeof updateEmploymentSchema>;

export const listEmploymentsQuerySchema = z.object({ householdId: uuid });

// Sub-resources -------------------------------------------------------------

export const salarySchema = z.object({ amount: positiveMoney, startDate: dayString });
export const salaryUpdateSchema = salarySchema.partial().refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

const itemBase = {
  name: text(100),
  kind: itemKind,
  inInssBase: z.boolean(),
  inIrrfBase: z.boolean(),
  inFgtsBase: z.boolean(),
};
export const itemSchema = z.object({
  name: itemBase.name,
  kind: itemBase.kind.default('EARNING'),
  inInssBase: itemBase.inInssBase.default(false),
  inIrrfBase: itemBase.inIrrfBase.default(false),
  inFgtsBase: itemBase.inFgtsBase.default(false),
  /** Optional first value of the history. */
  value: z.object({ amount: money, startDate: dayString }).optional(),
});
export const itemUpdateSchema = z
  .object({ name: itemBase.name.optional(), kind: itemBase.kind.optional(), inInssBase: itemBase.inInssBase.optional(), inIrrfBase: itemBase.inIrrfBase.optional(), inFgtsBase: itemBase.inFgtsBase.optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });
export const itemValueSchema = z.object({ amount: money, startDate: dayString });
export const itemValueUpdateSchema = itemValueSchema.partial().refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

const vacationItem = z.object({
  label: text(100),
  amount: positiveMoney,
  kind: itemKind.default('EARNING'),
  inInssBase: z.boolean().default(false),
  inIrrfBase: z.boolean().default(false),
  inFgtsBase: z.boolean().default(false),
});
const vacationFields = {
  startDate: dayString.nullable().optional(),
  month: monthKey.nullable().optional(),
  days: z.number().int().min(1).max(30).nullable().optional(),
  sellDays: z.number().int().min(0).max(10).optional(),
  note: z.string().trim().max(200).nullable().optional(),
  items: z.array(vacationItem).max(20).optional(),
};
export const vacationSchema = z
  .object({ ...vacationFields, sellDays: z.number().int().min(0).max(10).default(0) })
  .refine((v) => (v.startDate ? 1 : 0) + (v.month ? 1 : 0) === 1, { message: 'Inform the start date or only the month, not both' })
  .refine((v) => (v.days ?? 0) + v.sellDays <= 30, { message: 'days plus sold days cannot exceed 30' });
export const vacationUpdateSchema = z
  .object(vacationFields)
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });
export type VacationInput = z.infer<typeof vacationSchema>;
export type VacationUpdateInput = z.infer<typeof vacationUpdateSchema>;

export const fgtsBalanceSchema = z.object({ amount: money, asOfDate: dayString });
export const fgtsBalanceUpdateSchema = fgtsBalanceSchema.partial().refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

export const fgtsWithdrawalSchema = z.object({
  amount: positiveMoney,
  date: dayString,
  kind: z.enum(['BIRTHDAY', 'TERMINATION', 'OTHER']).default('OTHER'),
  note: z.string().trim().max(200).nullable().optional(),
});
export const fgtsWithdrawalUpdateSchema = z
  .object({ amount: positiveMoney.optional(), date: dayString.optional(), kind: z.enum(['BIRTHDAY', 'TERMINATION', 'OTHER']).optional(), note: z.string().trim().max(200).nullable().optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

const modeBase = {
  mode: z.enum(['TERMINATION', 'BIRTHDAY']),
  birthdayMonth: monthNumber.nullable().optional(),
  expectedAmount: positiveMoney.nullable().optional(),
  startDate: dayString,
};
export const fgtsModeSchema = z.object(modeBase).superRefine((v, ctx) => {
  if (v.mode === 'BIRTHDAY' && !v.birthdayMonth) ctx.addIssue({ code: 'custom', message: 'The birthday mode needs birthdayMonth', path: ['birthdayMonth'] });
  if (v.mode === 'TERMINATION' && (v.birthdayMonth || v.expectedAmount)) {
    ctx.addIssue({ code: 'custom', message: 'The termination mode has no birthday month or expected amount', path: ['mode'] });
  }
});
export const fgtsModeUpdateSchema = z
  .object({ mode: modeBase.mode.optional(), birthdayMonth: modeBase.birthdayMonth, expectedAmount: modeBase.expectedAmount, startDate: dayString.optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

// Simulation and events ------------------------------------------------------

const lineItem = z.object({
  label: text(100),
  amount: positiveMoney,
  kind: itemKind.default('EARNING'),
  inInssBase: z.boolean().default(false),
  inIrrfBase: z.boolean().default(false),
  inFgtsBase: z.boolean().default(false),
});
const simulationCommon = {
  /** Day that picks the tax tables; default: today. */
  date: dayString.optional(),
  dependents: z.number().int().min(0).max(20).default(0),
  items: z.array(lineItem).max(30).default([]),
  workedDays: z.number().int().min(0).max(30).optional(),
  bracketMethod: bracketMethod.default('DEDUCTION'),
  rounding: rounding.default('TRUNCATE'),
};
export const simulateNetSchema = z.object({ gross: money, ...simulationCommon });
export const simulateGrossSchema = z.object({ targetNet: positiveMoney, ...simulationCommon });

const MAX_RANGE_DAYS = 366 * 5;
export const eventsQuerySchema = z
  .object({ householdId: uuid.optional(), from: dayString.optional(), to: dayString.optional() })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'from must not be after to' })
  .refine((v) => !v.from || !v.to || (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= MAX_RANGE_DAYS, { message: 'The period is too long (5 years at most)' });
export const eventsHouseholdQuerySchema = z
  .object({ householdId: uuid, from: dayString.optional(), to: dayString.optional() })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'from must not be after to' })
  .refine((v) => !v.from || !v.to || (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= MAX_RANGE_DAYS, { message: 'The period is too long (5 years at most)' });

export { monthKey };
