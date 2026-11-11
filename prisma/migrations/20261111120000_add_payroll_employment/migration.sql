-- Payroll (employment): employments (regime, several per household), salary history, fixed items with value history,
-- marked vacations, FGTS mode history, FGTS balance and typed withdrawals.
-- Additive only: new enums and tables, nothing existing is altered.
-- CreateEnum
CREATE TYPE "PayrollBracketMethod" AS ENUM ('DEDUCTION', 'DIRECT');

-- CreateEnum
CREATE TYPE "PayrollRounding" AS ENUM ('TRUNCATE', 'ROUND');

-- CreateEnum
CREATE TYPE "PayrollItemKind" AS ENUM ('EARNING', 'DEDUCTION');

-- CreateEnum
CREATE TYPE "EmploymentRegime" AS ENUM ('CLT');

-- CreateEnum
CREATE TYPE "FgtsMode" AS ENUM ('TERMINATION', 'BIRTHDAY');

-- CreateEnum
CREATE TYPE "FgtsWithdrawalKind" AS ENUM ('BIRTHDAY', 'TERMINATION', 'OTHER');

-- CreateTable
CREATE TABLE "employments" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "regime" "EmploymentRegime" NOT NULL DEFAULT 'CLT',
    "employer" VARCHAR(120) NOT NULL,
    "admission_date" DATE NOT NULL,
    "end_date" DATE,
    "dependents" INTEGER NOT NULL DEFAULT 0,
    "pay_day" INTEGER NOT NULL DEFAULT 5,
    "account_id" UUID,
    "recurring_transaction_id" UUID,
    "bracket_method" "PayrollBracketMethod" NOT NULL DEFAULT 'DEDUCTION',
    "rounding" "PayrollRounding" NOT NULL DEFAULT 'TRUNCATE',
    "thirteenth_first_month" INTEGER NOT NULL DEFAULT 6,
    "thirteenth_first_day" INTEGER NOT NULL DEFAULT 30,
    "thirteenth_second_month" INTEGER NOT NULL DEFAULT 12,
    "thirteenth_second_day" INTEGER NOT NULL DEFAULT 20,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employment_salaries" (
    "id" UUID NOT NULL,
    "employment_id" UUID NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "start_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employment_salaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employment_items" (
    "id" UUID NOT NULL,
    "employment_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "kind" "PayrollItemKind" NOT NULL DEFAULT 'EARNING',
    "in_inss_base" BOOLEAN NOT NULL DEFAULT false,
    "in_irrf_base" BOOLEAN NOT NULL DEFAULT false,
    "in_fgts_base" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employment_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employment_item_values" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "start_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employment_item_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employment_vacations" (
    "id" UUID NOT NULL,
    "employment_id" UUID NOT NULL,
    "start_date" DATE,
    "month" VARCHAR(7),
    "days" INTEGER,
    "sell_days" INTEGER NOT NULL DEFAULT 0,
    "note" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employment_vacations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employment_vacation_items" (
    "id" UUID NOT NULL,
    "vacation_id" UUID NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "kind" "PayrollItemKind" NOT NULL DEFAULT 'EARNING',
    "in_inss_base" BOOLEAN NOT NULL DEFAULT false,
    "in_irrf_base" BOOLEAN NOT NULL DEFAULT false,
    "in_fgts_base" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "employment_vacation_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employment_fgts_balances" (
    "id" UUID NOT NULL,
    "employment_id" UUID NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "as_of_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employment_fgts_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employment_fgts_withdrawals" (
    "id" UUID NOT NULL,
    "employment_id" UUID NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "date" DATE NOT NULL,
    "kind" "FgtsWithdrawalKind" NOT NULL DEFAULT 'OTHER',
    "note" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employment_fgts_withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employment_fgts_modes" (
    "id" UUID NOT NULL,
    "employment_id" UUID NOT NULL,
    "mode" "FgtsMode" NOT NULL,
    "birthday_month" INTEGER,
    "expected_amount" DECIMAL(15,2),
    "start_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employment_fgts_modes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employments_recurring_transaction_id_key" ON "employments"("recurring_transaction_id");

-- CreateIndex
CREATE INDEX "employments_household_id_idx" ON "employments"("household_id");

-- CreateIndex
CREATE UNIQUE INDEX "employment_salaries_employment_id_start_date_key" ON "employment_salaries"("employment_id", "start_date");

-- CreateIndex
CREATE INDEX "employment_items_employment_id_idx" ON "employment_items"("employment_id");

-- CreateIndex
CREATE UNIQUE INDEX "employment_item_values_item_id_start_date_key" ON "employment_item_values"("item_id", "start_date");

-- CreateIndex
CREATE INDEX "employment_vacations_employment_id_idx" ON "employment_vacations"("employment_id");

-- CreateIndex
CREATE INDEX "employment_vacation_items_vacation_id_idx" ON "employment_vacation_items"("vacation_id");

-- CreateIndex
CREATE UNIQUE INDEX "employment_fgts_balances_employment_id_as_of_date_key" ON "employment_fgts_balances"("employment_id", "as_of_date");

-- CreateIndex
CREATE INDEX "employment_fgts_withdrawals_employment_id_date_idx" ON "employment_fgts_withdrawals"("employment_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "employment_fgts_modes_employment_id_start_date_key" ON "employment_fgts_modes"("employment_id", "start_date");

-- AddForeignKey
ALTER TABLE "employments" ADD CONSTRAINT "employments_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employments" ADD CONSTRAINT "employments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employments" ADD CONSTRAINT "employments_recurring_transaction_id_fkey" FOREIGN KEY ("recurring_transaction_id") REFERENCES "recurring_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_salaries" ADD CONSTRAINT "employment_salaries_employment_id_fkey" FOREIGN KEY ("employment_id") REFERENCES "employments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_items" ADD CONSTRAINT "employment_items_employment_id_fkey" FOREIGN KEY ("employment_id") REFERENCES "employments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_item_values" ADD CONSTRAINT "employment_item_values_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "employment_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_vacations" ADD CONSTRAINT "employment_vacations_employment_id_fkey" FOREIGN KEY ("employment_id") REFERENCES "employments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_vacation_items" ADD CONSTRAINT "employment_vacation_items_vacation_id_fkey" FOREIGN KEY ("vacation_id") REFERENCES "employment_vacations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_fgts_balances" ADD CONSTRAINT "employment_fgts_balances_employment_id_fkey" FOREIGN KEY ("employment_id") REFERENCES "employments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_fgts_withdrawals" ADD CONSTRAINT "employment_fgts_withdrawals_employment_id_fkey" FOREIGN KEY ("employment_id") REFERENCES "employments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_fgts_modes" ADD CONSTRAINT "employment_fgts_modes_employment_id_fkey" FOREIGN KEY ("employment_id") REFERENCES "employments"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Range checks the Prisma schema cannot express.
ALTER TABLE "employments" ADD CONSTRAINT "employments_ranges_check" CHECK (
    "dependents" >= 0 AND "pay_day" BETWEEN 1 AND 31
    AND "thirteenth_first_month" BETWEEN 1 AND 12 AND "thirteenth_first_day" BETWEEN 1 AND 31
    AND "thirteenth_second_month" BETWEEN 1 AND 12 AND "thirteenth_second_day" BETWEEN 1 AND 31
    AND ("end_date" IS NULL OR "end_date" >= "admission_date")
);

-- A vacation is either an exact start date or only a month, never both and never neither.
ALTER TABLE "employment_vacations" ADD CONSTRAINT "employment_vacations_start_or_month_check" CHECK (
    ("start_date" IS NOT NULL) <> ("month" IS NOT NULL)
);
ALTER TABLE "employment_vacations" ADD CONSTRAINT "employment_vacations_days_check" CHECK (
    "sell_days" BETWEEN 0 AND 10 AND ("days" IS NULL OR "days" BETWEEN 1 AND 30)
);

-- The birthday mode needs the month of the birthday; the termination mode has none and no expected amount.
ALTER TABLE "employment_fgts_modes" ADD CONSTRAINT "employment_fgts_modes_birthday_check" CHECK (
    ("mode" = 'BIRTHDAY' AND COALESCE("birthday_month" BETWEEN 1 AND 12, false))
    OR ("mode" = 'TERMINATION' AND "birthday_month" IS NULL AND "expected_amount" IS NULL)
);
