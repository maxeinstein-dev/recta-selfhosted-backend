-- Forecast strategies of a recurrence: how the amount of the next occurrence is predicted.
-- Additive only, no data migration: every existing recurrence becomes LAST, which is the behaviour it already had.
CREATE TYPE "ForecastStrategy" AS ENUM ('LAST', 'FIXED', 'CONSERVATIVE', 'PER_BUSINESS_DAY');

ALTER TABLE "recurring_transactions" ADD COLUMN "forecast_strategy" "ForecastStrategy" NOT NULL DEFAULT 'LAST';
ALTER TABLE "recurring_transactions" ADD COLUMN "forecast_window" INTEGER;
ALTER TABLE "recurring_transactions" ADD COLUMN "daily_rate" DECIMAL(15,2);
ALTER TABLE "recurring_transactions" ADD COLUMN "safety_business_days" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "recurring_transactions" ADD COLUMN "non_working_days" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "recurring_transactions" ADD COLUMN "optional_holidays" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_forecast_window_range"
  CHECK ("forecast_window" IS NULL OR "forecast_window" BETWEEN 1 AND 36);
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_daily_rate_positive"
  CHECK ("daily_rate" IS NULL OR "daily_rate" > 0);
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_safety_days_range"
  CHECK ("safety_business_days" BETWEEN 0 AND 31);
