-- DropIndex
DROP INDEX "household_members_shared_account_ids_idx";

-- AlterTable
ALTER TABLE "categories" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email_verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "password_hash" TEXT,
ALTER COLUMN "firebase_uid" DROP NOT NULL;
