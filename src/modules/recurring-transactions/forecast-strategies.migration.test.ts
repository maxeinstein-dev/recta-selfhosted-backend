import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The forecast strategy columns are added by a hand-written, additive migration: pin it against the schema.

const migrationsDir = new URL('../../../prisma/migrations/', import.meta.url);
const schema = readFileSync(new URL('../../../prisma/schema.prisma', import.meta.url), 'utf8');

function migration(): string {
  const folder = readdirSync(migrationsDir).find((name) => name.endsWith('_forecast_strategies'));
  if (!folder) throw new Error('migration forecast_strategies not found');
  return readFileSync(new URL(`${folder}/migration.sql`, migrationsDir), 'utf8');
}

function modelBlock(name: string): string {
  const match = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!match?.[1]) throw new Error(`model ${name} not found in schema.prisma`);
  return match[1];
}

describe('forecast_strategies migration', () => {
  const sql = migration();

  it('is additive: a new enum and new columns, nothing dropped, updated or deleted', () => {
    expect(sql).toMatch(/CREATE TYPE "ForecastStrategy" AS ENUM \('LAST', 'FIXED', 'CONSERVATIVE', 'PER_BUSINESS_DAY'\);/);
    expect(sql).not.toMatch(/\b(DROP|UPDATE|DELETE|RENAME)\b/i);
    expect(sql.match(/ALTER TABLE "recurring_transactions" ADD COLUMN/g)).toHaveLength(6);
    expect(sql).not.toMatch(/ALTER TABLE "(?!recurring_transactions")/);
  });

  it('the default keeps the behaviour that existed: every existing recurrence becomes LAST, no margin, no extra days', () => {
    expect(sql).toMatch(/ADD COLUMN "forecast_strategy" "ForecastStrategy" NOT NULL DEFAULT 'LAST'/);
    expect(sql).toMatch(/ADD COLUMN "safety_business_days" INTEGER NOT NULL DEFAULT 0/);
    expect(sql).toMatch(/ADD COLUMN "non_working_days" TEXT\[\] DEFAULT ARRAY\[\]::TEXT\[\]/);
    expect(sql).toMatch(/ADD COLUMN "optional_holidays" TEXT\[\] DEFAULT ARRAY\[\]::TEXT\[\]/);
    // the parameters of the other strategies start empty
    expect(sql).toMatch(/ADD COLUMN "forecast_window" INTEGER;/);
    expect(sql).toMatch(/ADD COLUMN "daily_rate" DECIMAL\(15,2\);/);
  });

  it('the database enforces the ranges: window 1..36, rate above zero, margin 0..31', () => {
    expect(sql).toMatch(/CHECK \("forecast_window" IS NULL OR "forecast_window" BETWEEN 1 AND 36\)/);
    expect(sql).toMatch(/CHECK \("daily_rate" IS NULL OR "daily_rate" > 0\)/);
    expect(sql).toMatch(/CHECK \("safety_business_days" BETWEEN 0 AND 31\)/);
  });

  it('matches the Prisma model', () => {
    expect(schema).toMatch(/enum ForecastStrategy \{\s+LAST\s+FIXED\s+CONSERVATIVE\s+PER_BUSINESS_DAY\s+\}/);
    const block = modelBlock('RecurringTransaction');
    expect(block).toMatch(/forecastStrategy\s+ForecastStrategy\s+@default\(LAST\)\s+@map\("forecast_strategy"\)/);
    expect(block).toMatch(/forecastWindow\s+Int\?\s+@map\("forecast_window"\)/);
    expect(block).toMatch(/dailyRate\s+Decimal\?\s+@map\("daily_rate"\) @db\.Decimal\(15, 2\)/);
    expect(block).toMatch(/safetyBusinessDays\s+Int\s+@default\(0\)\s+@map\("safety_business_days"\)/);
    expect(block).toMatch(/nonWorkingDays\s+String\[\]\s+@default\(\[\]\)\s+@map\("non_working_days"\)/);
    expect(block).toMatch(/optionalHolidays\s+String\[\]\s+@default\(\[\]\)\s+@map\("optional_holidays"\)/);
  });

  it('the strategy list of the code is the enum of the database', () => {
    const enumBody = /enum ForecastStrategy \{([^}]*)\}/.exec(schema)![1]!.split(/\s+/).filter(Boolean);
    return import('./expected-amount.js').then(({ FORECAST_STRATEGIES }) => {
      expect([...FORECAST_STRATEGIES].sort()).toEqual([...enumBody].sort());
    });
  });
});
