-- CreateTable
CREATE TABLE "capture_card_rules" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "package" VARCHAR(150) NOT NULL,
    "card_last4" CHAR(4) NOT NULL,
    "account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "capture_card_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "capture_card_rules_household_id_package_card_last4_key" ON "capture_card_rules"("household_id", "package", "card_last4");

-- AddForeignKey
ALTER TABLE "capture_card_rules" ADD CONSTRAINT "capture_card_rules_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capture_card_rules" ADD CONSTRAINT "capture_card_rules_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
