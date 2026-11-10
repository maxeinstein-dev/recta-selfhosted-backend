-- Aliases of a recurrence: the other names the bank or the card machine uses for the same charge.
-- Additive only: every existing recurrence starts with an empty list.
ALTER TABLE "recurring_transactions" ADD COLUMN "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
