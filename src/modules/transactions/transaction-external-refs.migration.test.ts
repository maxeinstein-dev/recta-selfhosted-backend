import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The card OFX import relies on these properties of `transaction_external_refs`: a ref is unique per household
// (a second insert is a P2002, read as "already reconciled"), refs go away with their transaction (cascade), and
// lookups by transaction are indexed. The migration is written by hand, so pin it against the schema.

const migrationsDir = new URL('../../../prisma/migrations/', import.meta.url);
const schema = readFileSync(new URL('../../../prisma/schema.prisma', import.meta.url), 'utf8');

function externalRefsMigration(): string {
  const folder = readdirSync(migrationsDir).find((name) => name.endsWith('_add_transaction_external_refs'));
  if (!folder) throw new Error('migration add_transaction_external_refs not found');
  return readFileSync(new URL(`${folder}/migration.sql`, migrationsDir), 'utf8');
}

function modelBlock(name: string): string {
  const match = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!match?.[1]) throw new Error(`model ${name} not found in schema.prisma`);
  return match[1];
}

describe('transaction_external_refs migration', () => {
  const sql = externalRefsMigration();

  it('creates the table with the columns the service writes', () => {
    expect(sql).toContain('CREATE TABLE "transaction_external_refs"');
    expect(sql).toMatch(/"household_id" UUID NOT NULL/);
    expect(sql).toMatch(/"transaction_id" UUID NOT NULL/);
    expect(sql).toMatch(/"ref" VARCHAR\(120\) NOT NULL/);
    expect(sql).toMatch(/"created_at" TIMESTAMP\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/);
  });

  it('makes a ref unique per household', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "transaction_external_refs_household_id_ref_key" ON "transaction_external_refs"\("household_id", "ref"\)/,
    );
  });

  it('deletes the refs with their transaction and indexes the lookup by transaction', () => {
    expect(sql).toMatch(
      /FOREIGN KEY \("transaction_id"\) REFERENCES "transactions"\("id"\) ON DELETE CASCADE/,
    );
    expect(sql).toMatch(/CREATE INDEX "transaction_external_refs_transaction_id_idx" ON "transaction_external_refs"\("transaction_id"\)/);
  });

  it('matches the Prisma model', () => {
    const model = modelBlock('TransactionExternalRef');
    expect(model).toMatch(/@@unique\(\[householdId, ref\]\)/);
    expect(model).toMatch(/@@index\(\[transactionId\]\)/);
    expect(model).toMatch(/ref\s+String\s+@db\.VarChar\(120\)/);
    expect(model).toMatch(/onDelete: Cascade/);
    expect(model).toMatch(/@@map\("transaction_external_refs"\)/);
  });
});
