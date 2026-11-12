import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EARLY_DISCOUNT_TYPES } from './early-discount.js';

// The early-payment discount columns are added by a hand-written, additive migration: pin it against the schema.

const migrationsDir = new URL('../../../prisma/migrations/', import.meta.url);
const schema = readFileSync(new URL('../../../prisma/schema.prisma', import.meta.url), 'utf8');

function migration(): string {
  const folder = readdirSync(migrationsDir).find((name) => name.endsWith('_recurring_early_discount'));
  if (!folder) throw new Error('migration recurring_early_discount not found');
  return readFileSync(new URL(`${folder}/migration.sql`, migrationsDir), 'utf8');
}

function modelBlock(name: string): string {
  const match = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!match?.[1]) throw new Error(`model ${name} not found in schema.prisma`);
  return match[1];
}

describe('recurring_early_discount migration', () => {
  const sql = migration();

  it('is additive: a new enum and three optional columns, nothing dropped, updated or deleted', () => {
    expect(sql).toMatch(/CREATE TYPE "EarlyDiscountType" AS ENUM \('FIXED', 'PERCENT'\);/);
    expect(sql).not.toMatch(/\b(DROP|UPDATE|DELETE|RENAME)\b/i);
    expect(sql.match(/ALTER TABLE "recurring_transactions" ADD COLUMN/g)).toHaveLength(3);
    expect(sql).not.toMatch(/ALTER TABLE "(?!recurring_transactions")/);
  });

  it('the columns are all optional with no default: an existing recurrence has no discount', () => {
    expect(sql).toMatch(/ADD COLUMN "early_discount_day" INTEGER;/);
    expect(sql).toMatch(/ADD COLUMN "early_discount_type" "EarlyDiscountType";/);
    expect(sql).toMatch(/ADD COLUMN "early_discount_value" DECIMAL\(15,2\);/);
  });

  it('the database enforces: day 1..31, the three columns together or none, value above zero', () => {
    expect(sql).toMatch(/"early_discount_day" IS NULL OR "early_discount_day" BETWEEN 1 AND 31/);
    expect(sql).toMatch(/\("early_discount_day" IS NULL\) = \("early_discount_type" IS NULL\)/);
    expect(sql).toMatch(/\("early_discount_day" IS NULL\) = \("early_discount_value" IS NULL\)/);
    expect(sql).toMatch(/"early_discount_value" IS NULL OR "early_discount_value" > 0/);
  });

  it('matches the Prisma model and the code', () => {
    expect(schema).toMatch(/enum EarlyDiscountType \{\s+FIXED\s+PERCENT\s+\}/);
    const block = modelBlock('RecurringTransaction');
    expect(block).toMatch(/earlyDiscountDay\s+Int\?\s+@map\("early_discount_day"\)/);
    expect(block).toMatch(/earlyDiscountType\s+EarlyDiscountType\?\s+@map\("early_discount_type"\)/);
    expect(block).toMatch(/earlyDiscountValue\s+Decimal\?\s+@map\("early_discount_value"\) @db\.Decimal\(15, 2\)/);
    const enumBody = /enum EarlyDiscountType \{([^}]*)\}/.exec(schema)![1]!.split(/\s+/).filter(Boolean);
    expect([...EARLY_DISCOUNT_TYPES].sort()).toEqual([...enumBody].sort());
  });
});
