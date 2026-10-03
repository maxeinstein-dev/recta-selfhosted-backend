-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "source_ref" VARCHAR(120);

-- CreateIndex
CREATE INDEX "transactions_household_id_source_ref_idx" ON "transactions"("household_id", "source_ref");
