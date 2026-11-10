import { z } from 'zod';

export const createDeviceSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  householdId: z.string().uuid().optional(),
});

export const deviceIdParamSchema = z.object({ id: z.string().uuid() });

export type CreateDeviceInput = z.infer<typeof createDeviceSchema>;
