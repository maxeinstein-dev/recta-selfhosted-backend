import { describe, expect, it } from 'vitest';

import { aliasesSchema, MAX_ALIASES, MAX_ALIAS_LENGTH, recurrenceNameKeys } from './recurring-aliases.js';
import { createRecurringTransactionSchema, updateRecurringTransactionSchema } from './recurring-transactions.schema.js';

describe('aliasesSchema', () => {
  it('trims and keeps the text as typed', () => {
    expect(aliasesSchema.parse(['  Pg *Seguro Alfa  ', 'Loja Beta'])).toEqual(['Pg *Seguro Alfa', 'Loja Beta']);
  });

  it('rejects empty, noise-only, duplicated (after normalizing), too many and too long aliases', () => {
    expect(aliasesSchema.safeParse(['   ']).success).toBe(false);
    expect(aliasesSchema.safeParse(['***']).success).toBe(false);
    expect(aliasesSchema.safeParse(['Seguro Alfa', 'SEGURO  alfa']).success).toBe(false);
    expect(aliasesSchema.safeParse(Array.from({ length: MAX_ALIASES + 1 }, (_, i) => `Nome ${String.fromCharCode(97 + i)}`)).success).toBe(false);
    expect(aliasesSchema.safeParse(['a'.repeat(MAX_ALIAS_LENGTH + 1)]).success).toBe(false);
    expect(aliasesSchema.safeParse(['a'.repeat(MAX_ALIAS_LENGTH)]).success).toBe(true);
  });

  it('is optional on update and defaults to an empty list on create', () => {
    expect(updateRecurringTransactionSchema.parse({}).aliases).toBeUndefined();
    const created = createRecurringTransactionSchema.parse({
      accountId: '11111111-1111-4111-8111-111111111111', categoryName: 'UTILITIES', amount: 10, frequency: 'MONTHLY', startDate: '2026-10-05', nextRunAt: '2026-10-05',
    });
    expect(created.aliases).toEqual([]);
    expect(updateRecurringTransactionSchema.parse({ aliases: [] }).aliases).toEqual([]);
  });
});

describe('recurrenceNameKeys', () => {
  it('holds the normalized description and every alias', () => {
    expect([...recurrenceNameKeys('Seguro Alfa', ['Pg *Seguro Alfa Conecta'])].sort()).toEqual(['pg seguro alfa conecta', 'seguro alfa']);
    expect(recurrenceNameKeys(null, undefined).size).toBe(0);
  });
});
