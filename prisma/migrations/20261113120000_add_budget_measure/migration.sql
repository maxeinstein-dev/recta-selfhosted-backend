-- How a budget is measured: WHOLE (the full spending of the category, a budget kept together) or OWN_SHARE (the
-- spending minus what other people owe on those expenses, a budget kept separately).
-- Additive only: a new enum and a new column with a default; existing budgets keep being measured as before (WHOLE).

-- CreateEnum
CREATE TYPE "BudgetMeasure" AS ENUM ('WHOLE', 'OWN_SHARE');

-- AlterTable
ALTER TABLE "budgets"
    ADD COLUMN "measure" "BudgetMeasure" NOT NULL DEFAULT 'WHOLE';
