-- Income area (T1): owner of the employment, holiday calendar of the employment and benefits paid per business day.
-- Additive only: new enum and new columns (nullable or with a default); existing rows keep working unchanged
-- (no owner, no calendar, fixed monthly items).

-- CreateEnum
CREATE TYPE "PayrollItemCalc" AS ENUM ('FIXED_MONTHLY', 'PER_BUSINESS_DAY');

-- AlterTable
ALTER TABLE "employments"
    ADD COLUMN "person_id" UUID,
    ADD COLUMN "holiday_uf" VARCHAR(2),
    ADD COLUMN "holiday_city" VARCHAR(80),
    ADD COLUMN "optional_holidays_off" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "employment_items"
    ADD COLUMN "calc_mode" "PayrollItemCalc" NOT NULL DEFAULT 'FIXED_MONTHLY',
    ADD COLUMN "margin_days" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "pay_day" INTEGER,
    ADD COLUMN "reference_month_offset" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "account_id" UUID,
    ADD COLUMN "is_available_cash" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "recurring_transaction_id" UUID;

-- CreateIndex
CREATE INDEX "employments_person_id_idx" ON "employments"("person_id");

-- CreateIndex
CREATE UNIQUE INDEX "employment_items_recurring_transaction_id_key" ON "employment_items"("recurring_transaction_id");

-- AddForeignKey: a person with employments cannot be deleted (it can be deactivated)
ALTER TABLE "employments" ADD CONSTRAINT "employments_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_items" ADD CONSTRAINT "employment_items_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_items" ADD CONSTRAINT "employment_items_recurring_transaction_id_fkey" FOREIGN KEY ("recurring_transaction_id") REFERENCES "recurring_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Range checks the Prisma schema cannot express.
ALTER TABLE "employments" ADD CONSTRAINT "employments_holiday_check" CHECK (
    ("holiday_uf" IS NULL OR "holiday_uf" ~ '^[A-Z]{2}$')
    AND ("holiday_city" IS NULL OR "holiday_uf" IS NOT NULL)
);

-- A per-business-day item is a plain earning outside every base, with its own pay day; the offset is a month either way.
ALTER TABLE "employment_items" ADD CONSTRAINT "employment_items_calc_check" CHECK (
    "margin_days" >= 0
    AND "reference_month_offset" BETWEEN -1 AND 1
    AND ("pay_day" IS NULL OR "pay_day" BETWEEN 1 AND 31)
    AND (
        "calc_mode" = 'FIXED_MONTHLY'
        OR ("pay_day" IS NOT NULL AND "kind" = 'EARNING' AND NOT "in_inss_base" AND NOT "in_irrf_base" AND NOT "in_fgts_base")
    )
);
