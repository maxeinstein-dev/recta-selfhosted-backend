import { z } from 'zod';

export const creditCardCommitmentParamsSchema = z.object({
  accountId: z.string().uuid(),
});

/** months: how many invoices (1 to 12, default 6). from: first invoice month, 'YYYY-MM' (default: the current month). */
export const creditCardCommitmentQuerySchema = z.object({
  householdId: z.string().uuid().optional(),
  months: z.coerce.number().int().min(1).max(12).optional(),
  from: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'from must be in format YYYY-MM')
    .optional(),
});
