import { z } from 'zod';
import { normalizeDescription } from './detect.js';

export const MAX_ALIASES = 20;
export const MAX_ALIAS_LENGTH = 100;

/**
 * Aliases of a recurrence: the other names the bank or the card machine prints for the same charge. Trimmed, none empty
 * (nor made only of noise, which normalizes to nothing), and no two that normalize to the same key.
 */
export const aliasesSchema = z
  .array(z.string().trim().min(1).max(MAX_ALIAS_LENGTH))
  .max(MAX_ALIASES)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((alias, index) => {
      const key = normalizeDescription(alias);
      if (!key) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Alias has no letters or digits', path: [index] });
      } else if (seen.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate alias', path: [index] });
      }
      seen.add(key);
    });
  });

/** The normalized names a recurrence answers to: its own description and every alias (empty keys dropped). */
export function recurrenceNameKeys(description: string | null | undefined, aliases: readonly string[] | null | undefined): Set<string> {
  const keys = new Set<string>();
  for (const name of [description ?? '', ...(aliases ?? [])]) {
    const key = normalizeDescription(name);
    if (key) keys.add(key);
  }
  return keys;
}
