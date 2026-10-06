import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The reference month columns are added by a hand-written, additive migration: pin it against the schema.

const migrationsDir = new URL('../../../prisma/migrations/', import.meta.url);
const schema = readFileSync(new URL('../../../prisma/schema.prisma', import.meta.url), 'utf8');

function migration(): string {
  const folder = readdirSync(migrationsDir).find((name) => name.endsWith('_reference_month'));
  if (!folder) throw new Error('migration reference_month not found');
  return readFileSync(new URL(`${folder}/migration.sql`, migrationsDir), 'utf8');
}

function modelBlock(name: string): string {
  const match = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!match?.[1]) throw new Error(`model ${name} not found in schema.prisma`);
  return match[1];
}

describe('reference_month migration', () => {
  const sql = migration();

  it('only adds nullable columns, a check and an index (no data migration, nothing dropped)', () => {
    expect(sql).toMatch(/ALTER TABLE "transactions" ADD COLUMN "competence_month" VARCHAR\(7\);/);
    expect(sql).toMatch(/ALTER TABLE "recurring_transactions" ADD COLUMN "competence_offset_months" INTEGER;/);
    expect(sql).not.toMatch(/\b(DROP|UPDATE|DELETE|NOT NULL)\b/i);
  });

  it('checks the format of the month and the range of the offset', () => {
    expect(sql).toMatch(/CHECK \("competence_month" IS NULL OR "competence_month" ~ '\^\[0-9\]\{4\}-\(0\[1-9\]\|1\[0-2\]\)\$'\)/);
    expect(sql).toMatch(/CHECK \("competence_offset_months" IS NULL OR "competence_offset_months" BETWEEN 0 AND 12\)/);
  });

  it('indexes the month filter by household', () => {
    expect(sql).toMatch(/CREATE INDEX "transactions_household_id_competence_month_idx" ON "transactions"\("household_id", "competence_month"\)/);
  });

  it('matches the Prisma models', () => {
    expect(modelBlock('Transaction')).toMatch(/competenceMonth\s+String\?\s+@map\("competence_month"\) @db\.VarChar\(7\)/);
    expect(modelBlock('Transaction')).toMatch(/@@index\(\[householdId, competenceMonth\]\)/);
    expect(modelBlock('RecurringTransaction')).toMatch(/competenceOffsetMonths\s+Int\?\s+@map\("competence_offset_months"\)/);
  });
});
