import { z } from 'zod';
import { CategoryType, GENERAL_BUDGET_CATEGORY } from '../../shared/enums/index.js';
import { localDateSchema } from '../../shared/utils/dateSchema.js';
import { categoryNameSchema } from '../categories/categories.schema.js';

/**
 * Category type enum for budgets
 */
export const categoryTypeEnum = z.nativeEnum(CategoryType);

/**
 * Budget categoryName: a system enum value, a "CUSTOM:<uuid>" id, OR the
 * budget-only "GENERAL" pseudo-category (total income/expense for the month).
 * GENERAL is valid for budgets only, so it lives here rather than in the
 * shared categoryNameSchema (which also governs transactions).
 */
export const budgetCategoryNameSchema = z.union([
  z.literal(GENERAL_BUDGET_CATEGORY),
  categoryNameSchema,
]);

/**
 * Create budget request
 */
export const createBudgetSchema = z.object({
  householdId: z.string().uuid().optional(), // Optional - will create personal household if not provided
  categoryName: budgetCategoryNameSchema,
  monthlyLimit: z.coerce.number().positive('Monthly limit must be positive'),
  month: localDateSchema,
  type: categoryTypeEnum,
});

export type CreateBudgetInput = z.infer<typeof createBudgetSchema>;

/**
 * Update budget request
 */
export const updateBudgetSchema = z.object({
  monthlyLimit: z.coerce.number().positive('Monthly limit must be positive').optional(),
  // Same parsing as on create: 'YYYY-MM-DD' is a local day (z.coerce.date read it as UTC midnight, the evening before)
  month: localDateSchema.optional(),
  type: categoryTypeEnum.optional(),
});

export type UpdateBudgetInput = z.infer<typeof updateBudgetSchema>;

/**
 * Budget ID param
 */
export const budgetIdParamSchema = z.object({
  budgetId: z.string().uuid(),
});

export type BudgetIdParam = z.infer<typeof budgetIdParamSchema>;

/**
 * List budgets query
 */
export const listBudgetsQuerySchema = z.object({
  householdId: z.string().uuid().optional(), // Optional - will use personal household if not provided
});

export type ListBudgetsQuery = z.infer<typeof listBudgetsQuerySchema>;

/**
 * Budget summary query
 */
export const budgetSummaryQuerySchema = z.object({
  householdId: z.string().uuid().optional(), // Optional - will use personal household if not provided
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be in YYYY-MM format')
    .optional(),
  startDate: localDateSchema.optional(),
  endDate: localDateSchema.optional(),
});

export type BudgetSummaryQuery = z.infer<typeof budgetSummaryQuerySchema>;

