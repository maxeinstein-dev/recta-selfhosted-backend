-- Savings goals as planned contributions: a goal can be a RESERVE or a PROVISION (yearly expense saved month by month),
-- with a planned monthly contribution on a day of the month, and every contribution is recorded in its own table.
-- Additive only, no data migration: the new columns are optional (or default to RESERVE), so every existing goal keeps
-- behaving exactly as before. Contributions create no transactions: no balance changes.
CREATE TYPE "SavingsGoalKind" AS ENUM ('RESERVE', 'PROVISION');

ALTER TABLE "savings_goals" ADD COLUMN "kind" "SavingsGoalKind" NOT NULL DEFAULT 'RESERVE';
ALTER TABLE "savings_goals" ADD COLUMN "monthly_contribution" DECIMAL(15,2);
ALTER TABLE "savings_goals" ADD COLUMN "contribution_day" INTEGER;
ALTER TABLE "savings_goals" ADD COLUMN "due_month" VARCHAR(7);

ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_contribution_day_range"
  CHECK ("contribution_day" IS NULL OR "contribution_day" BETWEEN 1 AND 28);
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_monthly_contribution_positive"
  CHECK ("monthly_contribution" IS NULL OR "monthly_contribution" > 0);
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_due_month_format"
  CHECK ("due_month" IS NULL OR "due_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_provision_has_due_month"
  CHECK (("kind" = 'PROVISION') = ("due_month" IS NOT NULL));

CREATE TABLE "savings_goal_contributions" (
    "id" UUID NOT NULL,
    "goal_id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "date" DATE NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "savings_goal_contributions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "savings_goal_contributions_amount_positive" CHECK ("amount" > 0)
);

CREATE INDEX "savings_goal_contributions_goal_id_month_idx" ON "savings_goal_contributions"("goal_id", "month");
CREATE INDEX "savings_goal_contributions_household_id_idx" ON "savings_goal_contributions"("household_id");

ALTER TABLE "savings_goal_contributions" ADD CONSTRAINT "savings_goal_contributions_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "savings_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "savings_goal_contributions" ADD CONSTRAINT "savings_goal_contributions_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;
