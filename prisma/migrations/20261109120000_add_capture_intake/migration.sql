-- CreateEnum
CREATE TYPE "CaptureStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DISMISSED', 'IGNORED');

-- CreateTable
CREATE TABLE "captured_notifications" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "package" VARCHAR(150) NOT NULL,
    "title" VARCHAR(300),
    "text" VARCHAR(2000) NOT NULL,
    "posted_at" TIMESTAMPTZ(3) NOT NULL,
    "dedup_key" VARCHAR(40) NOT NULL,
    "status" "CaptureStatus" NOT NULL DEFAULT 'PENDING',
    "parsed" JSONB,
    "parser_version" INTEGER,
    "transaction_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "captured_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capture_account_rules" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "package" VARCHAR(150) NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "capture_account_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "captured_notifications_household_id_status_posted_at_idx" ON "captured_notifications"("household_id", "status", "posted_at");

-- CreateIndex
CREATE UNIQUE INDEX "captured_notifications_household_id_dedup_key_key" ON "captured_notifications"("household_id", "dedup_key");

-- CreateIndex
CREATE UNIQUE INDEX "device_tokens_token_hash_key" ON "device_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "device_tokens_user_id_idx" ON "device_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "capture_account_rules_household_id_package_kind_key" ON "capture_account_rules"("household_id", "package", "kind");

-- AddForeignKey
ALTER TABLE "captured_notifications" ADD CONSTRAINT "captured_notifications_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "captured_notifications" ADD CONSTRAINT "captured_notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "captured_notifications" ADD CONSTRAINT "captured_notifications_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capture_account_rules" ADD CONSTRAINT "capture_account_rules_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capture_account_rules" ADD CONSTRAINT "capture_account_rules_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

