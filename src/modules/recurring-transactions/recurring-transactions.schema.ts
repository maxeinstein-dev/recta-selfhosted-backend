import { z } from 'zod';
import { RecurrenceFrequency } from '../../shared/enums/index.js';
import { localDateSchema } from '../../shared/utils/dateSchema.js';
import { categoryNameSchema } from '../categories/categories.schema.js';
import { isValidNonWorkingDay, normalizeNonWorkingDays, OPTIONAL_HOLIDAYS } from './br-calendar.js';
import { FORECAST_STRATEGIES, MAX_CONSERVATIVE_WINDOW } from './expected-amount.js';

/**
 * Recurrence frequency enum
 */
export const recurrenceFrequencyEnum = z.nativeEnum(RecurrenceFrequency);

/** 0..12 months between an occurrence's date and its reference month. */
/** 0..12 months; 0 ("same month") is stored as null, like the UI sends it, so there is one way to say it. */
export const competenceOffsetSchema = z.number().int().min(0).max(12).transform((n) => (n === 0 ? null : n));

/** How the amount of the next occurrence is forecast (default LAST: the amount follows the last value, as before). */
export const forecastStrategySchema = z.enum(FORECAST_STRATEGIES);
/** N of CONSERVATIVE; null = the default of the kind (6 for income, 3 for expense). */
export const forecastWindowSchema = z.number().int().min(1).max(MAX_CONSERVATIVE_WINDOW);
/** Amount per business day (PER_BUSINESS_DAY). */
export const dailyRateSchema = z.union([z.number(), z.string().trim().min(1)]).pipe(z.coerce.number().positive().max(1_000_000_000));
/** Business days discounted from the month, "descontar N dias uteis". */
export const safetyBusinessDaysSchema = z.number().int().min(0).max(31);
/** "Dias sem vale" of the recurrence: 'MM-DD' (every year) or 'YYYY-MM-DD'. Sorted and de-duplicated. */
export const nonWorkingDaysSchema = z
  .array(z.string().trim().refine(isValidNonWorkingDay, "Use 'MM-DD' or 'YYYY-MM-DD'"))
  .max(60)
  .transform((days) => normalizeNonWorkingDays(days));
/** Optional holidays that also count as non-business days. */
export const optionalHolidaysSchema = z
  .array(z.enum(OPTIONAL_HOLIDAYS))
  .max(OPTIONAL_HOLIDAYS.length)
  .transform((days) => [...new Set(days)]);

/**
 * Create recurring transaction request
 */
export const createRecurringTransactionSchema = z.object({
  householdId: z.string().uuid().optional(), // Optional - will create personal household if not provided
  accountId: z.string().uuid(),
  categoryName: categoryNameSchema,
  amount: z.coerce.number().refine((val) => val !== 0, 'Amount cannot be zero'),
  description: z.string().max(255).optional(),
  frequency: recurrenceFrequencyEnum,
  startDate: localDateSchema,
  endDate: localDateSchema.optional(),
  nextRunAt: localDateSchema,
  isActive: z.boolean().default(true),
  // When true, editing the most recent occurrence updates the recurrence amount (predicts the next value)
  followLastAmount: z.boolean().default(false),
  // Months between the occurrence date and the month it refers to (1 = the following month); null/omitted = same month
  competenceOffsetMonths: competenceOffsetSchema.nullish(),
  // Forecast strategy (default LAST) and its parameters; PER_BUSINESS_DAY needs dailyRate (checked by the service)
  forecastStrategy: forecastStrategySchema.default('LAST'),
  forecastWindow: forecastWindowSchema.nullish(),
  dailyRate: dailyRateSchema.nullish(),
  safetyBusinessDays: safetyBusinessDaysSchema.default(0),
  nonWorkingDays: nonWorkingDaysSchema.default([]),
  optionalHolidays: optionalHolidaysSchema.default([]),
});

export type CreateRecurringTransactionInput = z.infer<
  typeof createRecurringTransactionSchema
>;

/**
 * Update recurring transaction request
 */
export const updateRecurringTransactionSchema = z.object({
  accountId: z.string().uuid().optional(),
  categoryName: categoryNameSchema.optional(),
  amount: z.coerce.number().refine((val) => val !== 0, 'Amount cannot be zero').optional(),
  description: z.string().max(255).optional(),
  frequency: recurrenceFrequencyEnum.optional(),
  startDate: localDateSchema.optional(),
  endDate: localDateSchema.nullable().optional(),
  nextRunAt: localDateSchema.optional(),
  isActive: z.boolean().optional(),
  followLastAmount: z.boolean().optional(),
  competenceOffsetMonths: competenceOffsetSchema.nullable().optional(), // null clears (back to the same month)
  forecastStrategy: forecastStrategySchema.optional(),
  forecastWindow: forecastWindowSchema.nullable().optional(), // null = the default of the kind
  dailyRate: dailyRateSchema.nullable().optional(),
  safetyBusinessDays: safetyBusinessDaysSchema.optional(),
  nonWorkingDays: nonWorkingDaysSchema.optional(),
  optionalHolidays: optionalHolidaysSchema.optional(),
});

export type UpdateRecurringTransactionInput = z.infer<
  typeof updateRecurringTransactionSchema
>;

/**
 * Recurring transaction ID param
 */
export const recurringTransactionIdParamSchema = z.object({
  recurringId: z.string().uuid(),
});

export type RecurringTransactionIdParam = z.infer<
  typeof recurringTransactionIdParamSchema
>;

/**
 * List recurring transactions query
 */
export const listRecurringTransactionsQuerySchema = z.object({
  householdId: z.string().uuid().optional(), // Optional - will use personal household if not provided
  isActive: z.coerce.boolean().optional(),
});

export type ListRecurringTransactionsQuery = z.infer<
  typeof listRecurringTransactionsQuerySchema
>;

/**
 * Execute recurring transaction
 * REGRA DE NEGÓCIO:
 * - paid: true para cartão de crédito (consome limite imediatamente)
 * - paid: false para conta bancária (pendente para revisão)
 */
export const executeRecurringTransactionSchema = z.object({
  date: localDateSchema.optional(),
  paid: z.boolean().optional(), // Se não fornecido, usa false (padrão seguro)
});

export type ExecuteRecurringTransactionInput = z.infer<
  typeof executeRecurringTransactionSchema
>;


/**
 * Detect recurring expenses (POST /recurring-transactions/detect) and apply the chosen candidates
 * (POST /recurring-transactions/detect/apply). Caps keep the work bounded.
 */
const detectWindowShape = {
  householdId: z.string().uuid(),
  minMonths: z.number().int().min(2).max(12).optional(),
  months: z.number().int().min(3).max(36).optional(),
};

function minMonthsFitsWindow(v: { minMonths?: number; months?: number }): boolean {
  return (v.minMonths ?? 3) <= (v.months ?? 12);
}

export const detectRecurringSchema = z
  .object(detectWindowShape)
  .refine(minMonthsFitsWindow, { message: 'minMonths cannot exceed months', path: ['minMonths'] });

export type DetectRecurringInput = z.infer<typeof detectRecurringSchema>;

export const MAX_DETECT_APPLY_ITEMS = 300;

export const detectApplySchema = z
  .object({
    ...detectWindowShape,
    items: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          amount: z.number().positive().max(1_000_000_000).optional(),
          dayOfMonth: z.number().int().min(1).max(31).optional(),
          description: z.string().trim().min(1).max(255).optional(),
          followLastAmount: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(MAX_DETECT_APPLY_ITEMS),
  })
  .refine(minMonthsFitsWindow, { message: 'minMonths cannot exceed months', path: ['minMonths'] });

export type DetectApplyInput = z.infer<typeof detectApplySchema>;
