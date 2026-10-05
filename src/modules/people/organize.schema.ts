import { z } from 'zod';

import { aliasList, amount, dayString, personName, shareDirectionSchema, uuid } from './people.schema.js';

export const MAX_ORGANIZE_IDS = 10_000;
export const MAX_ORGANIZE_MANUAL = 2_000;
export const MAX_ORGANIZE_PEOPLE = 200;

export const organizeOptionsSchema = z.object({
  householdId: uuid,
  startDate: dayString.optional(),
  endDate: dayString.optional(),
  onlyImported: z.boolean().optional(),
});
export type OrganizeOptions = z.infer<typeof organizeOptionsSchema>;

const organizeIdList = z.array(z.string().min(1).max(300)).max(MAX_ORGANIZE_IDS);

export const organizeApplySchema = organizeOptionsSchema.extend({
  people: z
    .array(z.object({ name: personName, aliases: aliasList.optional(), existingId: uuid.optional() }))
    .max(MAX_ORGANIZE_PEOPLE)
    .default([]),
  proposalIds: organizeIdList.default([]),
  settlementIds: organizeIdList.default([]),
  manual: z
    .array(
      z
        .object({
          transactionId: uuid,
          personId: uuid.optional(),
          personName: personName.optional(),
          direction: shareDirectionSchema,
          amount,
        })
        .refine((line) => line.personId !== undefined || line.personName !== undefined, {
          message: 'Send personId or personName',
          path: ['personId'],
        }),
    )
    .max(MAX_ORGANIZE_MANUAL)
    .default([]),
});
export type OrganizeApplyInput = z.infer<typeof organizeApplySchema>;
