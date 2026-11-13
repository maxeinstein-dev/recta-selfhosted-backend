import { z } from 'zod';
import { localDateSchema } from '../../shared/utils/dateSchema.js';

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM');

/** Planned-contribution fields shared by create and update. The cross-field rules live in the service (they need the stored state too). */
const planFields = {
  kind: z.enum(['RESERVE', 'PROVISION']).optional(),
  monthlyContribution: z.coerce.number().positive('Monthly contribution must be positive').max(1e11),
  contributionDay: z.coerce.number().int().min(1).max(28),
  dueMonth: monthSchema,
};

/**
 * Create savings goal request
 */
export const createSavingsGoalSchema = z.object({
  kind: planFields.kind,
  monthlyContribution: planFields.monthlyContribution.optional(),
  contributionDay: planFields.contributionDay.optional(),
  dueMonth: planFields.dueMonth.optional(),
  householdId: z.string().uuid().optional(), // Optional - will create personal household if not provided
  accountId: z.string().uuid().optional(),
  name: z.string().min(1).max(100).trim(),
  targetAmount: z.coerce.number().positive('Target amount must be positive'),
  currentAmount: z.coerce.number().min(0).default(0),
  targetDate: localDateSchema.optional(),
});

export type CreateSavingsGoalInput = z.infer<typeof createSavingsGoalSchema>;

/**
 * Update savings goal request
 */
export const updateSavingsGoalSchema = z.object({
  kind: planFields.kind,
  monthlyContribution: planFields.monthlyContribution.nullable().optional(),
  contributionDay: planFields.contributionDay.nullable().optional(),
  dueMonth: planFields.dueMonth.nullable().optional(),
  accountId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(100).trim().optional(),
  targetAmount: z.coerce.number().positive('Target amount must be positive').optional(),
  currentAmount: z.coerce.number().min(0).optional(),
  targetDate: z.coerce.date().nullable().optional(),
});

export type UpdateSavingsGoalInput = z.infer<typeof updateSavingsGoalSchema>;

/**
 * Add to savings goal
 */
export const addToSavingsGoalSchema = z.object({
  amount: z.coerce.number().positive('Amount must be positive'),
  description: z.string().max(255).optional(),
});

export type AddToSavingsGoalInput = z.infer<typeof addToSavingsGoalSchema>;

/**
 * Savings goal ID param
 */
export const savingsGoalIdParamSchema = z.object({
  goalId: z.string().uuid(),
});

export type SavingsGoalIdParam = z.infer<typeof savingsGoalIdParamSchema>;

/**
 * List savings goals query
 */
export const listSavingsGoalsQuerySchema = z.object({
  householdId: z.string().uuid().optional(), // Optional - will use personal household if not provided
});

export type ListSavingsGoalsQuery = z.infer<typeof listSavingsGoalsQuerySchema>;


/**
 * Register a contribution ("guardar agora"). Without `amount` it is the amount planned for the month. `date` (YYYY-MM-DD)
 * defaults to today and fixes the month it counts for. A second contribution in a month that already has one is refused
 * (409) unless `confirmDuplicate` is true.
 */
export const contributeSchema = z.object({
  amount: z.coerce.number().positive('Amount must be positive').max(1e11).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').optional(),
  confirmDuplicate: z.boolean().optional().default(false),
});

export type ContributeInput = z.infer<typeof contributeSchema>;

export const contributionParamsSchema = z.object({
  goalId: z.string().uuid(),
  contributionId: z.string().uuid(),
});

export const contributionsQuerySchema = z.object({
  month: monthSchema.optional(),
});
