-- Early-payment discount of a recurrence: paid up to a day of the occurrence's month, the amount is reduced by a fixed
-- value or a percentage. Additive only, no data migration: the columns are optional, so every existing recurrence has no
-- discount and behaves exactly as before.
CREATE TYPE "EarlyDiscountType" AS ENUM ('FIXED', 'PERCENT');

ALTER TABLE "recurring_transactions" ADD COLUMN "early_discount_day" INTEGER;
ALTER TABLE "recurring_transactions" ADD COLUMN "early_discount_type" "EarlyDiscountType";
ALTER TABLE "recurring_transactions" ADD COLUMN "early_discount_value" DECIMAL(15,2);

ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_early_discount_day_range"
  CHECK ("early_discount_day" IS NULL OR "early_discount_day" BETWEEN 1 AND 31);
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_early_discount_together"
  CHECK (("early_discount_day" IS NULL) = ("early_discount_type" IS NULL) AND ("early_discount_day" IS NULL) = ("early_discount_value" IS NULL));
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_early_discount_value_positive"
  CHECK ("early_discount_value" IS NULL OR "early_discount_value" > 0);
