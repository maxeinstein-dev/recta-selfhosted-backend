-- Month close: the user's conference of one account (or card) for one month. Additive only: a new table.
-- One row per (household, month, account); conferring again replaces it.

-- CreateTable
CREATE TABLE "month_closings" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "informed_balance" DECIMAL(15,2) NOT NULL,
    "system_balance" DECIMAL(15,2) NOT NULL,
    "difference" DECIMAL(15,2) NOT NULL,
    "closed_by_user_id" UUID,
    "closed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "month_closings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "month_closings_household_id_month_idx" ON "month_closings"("household_id", "month");

-- CreateIndex
CREATE UNIQUE INDEX "month_closings_household_id_month_account_id_key" ON "month_closings"("household_id", "month", "account_id");

-- AddForeignKey
ALTER TABLE "month_closings" ADD CONSTRAINT "month_closings_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "month_closings" ADD CONSTRAINT "month_closings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
