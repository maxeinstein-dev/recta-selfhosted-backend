-- AlterTable
ALTER TABLE "households" ADD COLUMN     "category_groups_seeded_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "category_groups" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "color" VARCHAR(7),
    "is_housing" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "category_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_group_assignments" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "category_name" VARCHAR(50) NOT NULL,
    "group_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "category_group_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "category_groups_household_id_idx" ON "category_groups"("household_id");

-- CreateIndex
CREATE UNIQUE INDEX "category_groups_household_id_name_key" ON "category_groups"("household_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "category_groups_id_household_id_key" ON "category_groups"("id", "household_id");

-- CreateIndex
CREATE INDEX "category_group_assignments_group_id_idx" ON "category_group_assignments"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "category_group_assignments_household_id_category_name_key" ON "category_group_assignments"("household_id", "category_name");

-- AddForeignKey
ALTER TABLE "category_groups" ADD CONSTRAINT "category_groups_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_group_assignments" ADD CONSTRAINT "category_group_assignments_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_group_assignments" ADD CONSTRAINT "category_group_assignments_group_id_household_id_fkey" FOREIGN KEY ("group_id", "household_id") REFERENCES "category_groups"("id", "household_id") ON DELETE CASCADE ON UPDATE CASCADE;

