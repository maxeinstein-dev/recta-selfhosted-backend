-- A budget repeats: it is in force from its month on, until a later budget of the same category and type replaces it,
-- or until its end month (included). Additive only: a nullable column; existing budgets have no end month.

-- AlterTable
ALTER TABLE "budgets"
    ADD COLUMN "end_month" DATE;
