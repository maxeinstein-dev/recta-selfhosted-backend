-- Reference month (competencia): income such as a meal voucher is deposited at the end of month M-1 but belongs to month M.
-- Additive only, no data migration: null keeps the old meaning (the month of the transaction date).
ALTER TABLE "transactions" ADD COLUMN "competence_month" VARCHAR(7);
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_competence_month_format"
  CHECK ("competence_month" IS NULL OR "competence_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
CREATE INDEX "transactions_household_id_competence_month_idx" ON "transactions"("household_id", "competence_month");

ALTER TABLE "recurring_transactions" ADD COLUMN "competence_offset_months" INTEGER;
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_competence_offset_range"
  CHECK ("competence_offset_months" IS NULL OR "competence_offset_months" BETWEEN 0 AND 12);
