import { z } from 'zod';
import { categoryNameSchema } from '../categories/categories.schema.js';
import { isReservedGroupName } from './category-groups.defaults.js';

const groupName = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(60, 'Name too long')
  .refine((n) => !isReservedGroupName(n), { message: '"Outros" is the group of the categories without a group' });
const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid hex color');

export const listGroupsQuerySchema = z.object({ householdId: z.string().uuid().optional() });

export const createGroupSchema = z.object({
  householdId: z.string().uuid().optional(),
  name: groupName,
  color: color.nullable().optional(),
  isHousing: z.boolean().optional(),
});

export const updateGroupSchema = z.object({
  name: groupName.optional(),
  color: color.nullable().optional(),
  isHousing: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});

export const groupIdParamSchema = z.object({ groupId: z.string().uuid() });

/** groupId null puts the category back in "Outros". */
export const assignCategorySchema = z.object({
  householdId: z.string().uuid().optional(),
  categoryName: categoryNameSchema,
  groupId: z.string().uuid().nullable(),
});
