-- DropIndex
DROP INDEX "transactions_household_id_source_ref_idx";

-- CreateIndex
CREATE UNIQUE INDEX "transactions_household_id_source_ref_key" ON "transactions"("household_id", "source_ref");
