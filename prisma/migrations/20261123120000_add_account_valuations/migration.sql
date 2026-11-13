-- Market value of an investment account on a date (informed by the user). Additive only: a new table, nothing existing changes.

-- CreateTable
CREATE TABLE "account_valuations" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_valuations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_valuations_account_id_date_key" ON "account_valuations"("account_id", "date");

-- AddForeignKey
ALTER TABLE "account_valuations" ADD CONSTRAINT "account_valuations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
