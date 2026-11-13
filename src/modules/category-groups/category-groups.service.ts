import { randomUUID } from 'node:crypto';
import { prisma } from '../../shared/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../shared/errors/index.js';
import { CATEGORY_NAME_DISPLAY, CategoryName, CategoryType, getCategoriesByType } from '../../shared/enums/index.js';
import { isCustomCategoryName, normalizeCategoryName, toCustomCategoryId, toCustomCategoryName } from '../../shared/utils/categoryHelpers.js';
import { DEFAULT_GROUPS, defaultAssignments, isReservedGroupName } from './category-groups.defaults.js';

type Db = Prisma.TransactionClient;

export interface GroupRow {
  id: string;
  name: string;
  sortOrder: number;
  color: string | null;
  isHousing: boolean;
}

/** A household's groups (in display order) and which group each mapped categoryName belongs to. */
export interface GroupMap {
  groups: GroupRow[];
  /** categoryName -> group id. A name that is not here is ungrouped ("Outros"). */
  groupOf: Map<string, string>;
}

const GROUP_SELECT = { id: true, name: true, sortOrder: true, color: true, isHousing: true } as const;

/**
 * Creates the default groups (Casa, Pessoal, Dia a dia) and their category mapping the first time a household needs
 * groups, once: the household row is locked and stamped (`category_groups_seeded_at`), so two first requests at the same
 * time seed once, and a household that later deletes every group does not get them back. A default whose name the
 * household already uses is not created; a category that already has a group keeps it.
 */
export async function ensureDefaultGroups(householdId: string): Promise<void> {
  const household = await prisma.household.findUnique({ where: { id: householdId }, select: { categoryGroupsSeededAt: true } });
  if (!household) throw new NotFoundError('Household');
  if (household.categoryGroupsSeededAt) return;

  await prisma.$transaction(async (tx: Db) => {
    const locked = await tx.$queryRaw<Array<{ seeded: Date | null }>>`SELECT category_groups_seeded_at AS seeded FROM households WHERE id = ${householdId}::uuid FOR UPDATE`;
    if (locked.length === 0 || locked[0]!.seeded) return;

    const existing = await tx.categoryGroup.findMany({ where: { householdId }, select: { id: true, name: true, sortOrder: true } });
    let order = existing.reduce((max, g) => Math.max(max, g.sortOrder + 1), 0);
    const idByName = new Map<string, string>();
    for (const g of existing) idByName.set(normalizeCategoryName(g.name), g.id);
    for (const def of DEFAULT_GROUPS) {
      if (idByName.has(normalizeCategoryName(def.name))) continue;
      const created = await tx.categoryGroup.create({
        data: { householdId, name: def.name, color: def.color, isHousing: def.isHousing, sortOrder: order },
        select: { id: true },
      });
      order += 1;
      idByName.set(normalizeCategoryName(def.name), created.id);
    }

    const custom = await tx.category.findMany({ where: { householdId, type: CategoryType.EXPENSE }, select: { id: true, name: true, type: true } });
    for (const [categoryName, groupName] of defaultAssignments(custom)) {
      const groupId = idByName.get(normalizeCategoryName(groupName));
      if (!groupId) continue;
      await tx.$executeRaw`
        INSERT INTO category_group_assignments (id, household_id, category_name, group_id, created_at, updated_at)
        VALUES (${randomUUID()}::uuid, ${householdId}::uuid, ${categoryName}, ${groupId}::uuid, NOW(), NOW())
        ON CONFLICT (household_id, category_name) DO NOTHING`;
    }
    await tx.household.update({ where: { id: householdId }, data: { categoryGroupsSeededAt: new Date() } });
  });
}

/** Groups and the category mapping of a household (seeding the defaults on first use). Used by the income split. */
export async function loadGroupMap(householdId: string): Promise<GroupMap> {
  await ensureDefaultGroups(householdId);
  const [groups, assignments] = await Promise.all([
    prisma.categoryGroup.findMany({ where: { householdId }, select: GROUP_SELECT, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    prisma.categoryGroupAssignment.findMany({ where: { householdId }, select: { categoryName: true, groupId: true } }),
  ]);
  return { groups, groupOf: new Map(assignments.map((a) => [a.categoryName, a.groupId])) };
}

export interface CategoryRef {
  categoryName: string;
  name: string;
  isSystem: boolean;
}

/** The household's expense categories (system first, then custom by name) as the transactions reference them. */
async function expenseCategories(householdId: string): Promise<CategoryRef[]> {
  const system = getCategoriesByType(CategoryType.EXPENSE).map((n) => ({ categoryName: n, name: CATEGORY_NAME_DISPLAY[n], isSystem: true }));
  const custom = await prisma.category.findMany({ where: { householdId, type: CategoryType.EXPENSE }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  return [...system, ...custom.map((c) => ({ categoryName: toCustomCategoryName(c.id), name: c.name, isSystem: false }))];
}

/** GET /category-groups: every group with its categories, and the expense categories that have no group ("Outros"). */
export async function listGroups(householdId: string) {
  const map = await loadGroupMap(householdId);
  const categories = await expenseCategories(householdId);
  const byGroup = new Map<string, CategoryRef[]>(map.groups.map((g) => [g.id, []]));
  const ungrouped: CategoryRef[] = [];
  for (const c of categories) {
    const groupId = map.groupOf.get(c.categoryName);
    const list = groupId ? byGroup.get(groupId) : undefined;
    if (list) list.push(c);
    else ungrouped.push(c);
  }
  return { groups: map.groups.map((g) => ({ ...g, categories: byGroup.get(g.id) ?? [] })), ungrouped };
}

async function assertNameFree(db: Db, householdId: string, name: string, ignoreId?: string): Promise<void> {
  if (isReservedGroupName(name)) throw new BadRequestError('"Outros" is the group of the categories without a group');
  const wanted = normalizeCategoryName(name);
  const siblings = await db.categoryGroup.findMany({ where: { householdId, ...(ignoreId && { id: { not: ignoreId } }) }, select: { name: true } });
  if (siblings.some((g) => normalizeCategoryName(g.name) === wanted)) throw new ConflictError('A group with this name already exists');
}

const nameTaken = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

export async function createGroup(householdId: string, input: { name: string; color?: string | null; isHousing?: boolean }) {
  await ensureDefaultGroups(householdId);
  try {
    return await prisma.$transaction(async (tx: Db) => {
      await assertNameFree(tx, householdId, input.name);
      const last = await tx.categoryGroup.aggregate({ where: { householdId }, _max: { sortOrder: true } });
      return tx.categoryGroup.create({
        data: { householdId, name: input.name, color: input.color ?? null, isHousing: input.isHousing ?? false, sortOrder: (last._max.sortOrder ?? -1) + 1 },
        select: GROUP_SELECT,
      });
    });
  } catch (error) {
    if (nameTaken(error)) throw new ConflictError('A group with this name already exists');
    throw error;
  }
}

export async function findGroupHousehold(groupId: string): Promise<string | null> {
  const row = await prisma.categoryGroup.findUnique({ where: { id: groupId }, select: { householdId: true } });
  return row?.householdId ?? null;
}

export async function updateGroup(groupId: string, householdId: string, input: { name?: string; color?: string | null; isHousing?: boolean; sortOrder?: number }) {
  try {
    return await prisma.$transaction(async (tx: Db) => {
      const group = await tx.categoryGroup.findFirst({ where: { id: groupId, householdId }, select: { id: true } });
      if (!group) throw new NotFoundError('Category group');
      if (input.name !== undefined) await assertNameFree(tx, householdId, input.name, groupId);
      return tx.categoryGroup.update({
        where: { id: groupId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.color !== undefined && { color: input.color }),
          ...(input.isHousing !== undefined && { isHousing: input.isHousing }),
          ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
        },
        select: GROUP_SELECT,
      });
    });
  } catch (error) {
    if (nameTaken(error)) throw new ConflictError('A group with this name already exists');
    throw error;
  }
}

/** Deletes a group; its categories go back to "Outros" (the assignments go with the group, by cascade). */
export async function deleteGroup(groupId: string, householdId: string): Promise<void> {
  const { count } = await prisma.categoryGroup.deleteMany({ where: { id: groupId, householdId } });
  if (count === 0) throw new NotFoundError('Category group');
}

/** True when the categoryName is an expense category of the household (system, or a custom one of its own). */
async function isExpenseCategory(db: Db, householdId: string, categoryName: string): Promise<boolean> {
  if (isCustomCategoryName(categoryName)) {
    const id = toCustomCategoryId(categoryName)!;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    const row = await db.category.findFirst({ where: { id, householdId }, select: { type: true } });
    return row?.type === CategoryType.EXPENSE;
  }
  return getCategoriesByType(CategoryType.EXPENSE).includes(categoryName as CategoryName);
}

/**
 * Puts a category in a group (`groupId`), or back in "Outros" (null). One statement per change inside a transaction:
 * the unique (household, category) index makes two concurrent assignments of the same category end with exactly one
 * row (the last write wins), and the composite key (group, household) refuses a group of another household.
 */
export async function assignCategory(householdId: string, categoryName: string, groupId: string | null) {
  await ensureDefaultGroups(householdId);
  return prisma.$transaction(async (tx: Db) => {
    if (!(await isExpenseCategory(tx, householdId, categoryName))) throw new BadRequestError('Only expense categories of the household can be grouped');
    if (groupId === null) {
      await tx.categoryGroupAssignment.deleteMany({ where: { householdId, categoryName } });
      return { categoryName, groupId: null };
    }
    const group = await tx.categoryGroup.findFirst({ where: { id: groupId, householdId }, select: { id: true } });
    if (!group) throw new NotFoundError('Category group');
    await tx.$executeRaw`
      INSERT INTO category_group_assignments (id, household_id, category_name, group_id, created_at, updated_at)
      VALUES (${randomUUID()}::uuid, ${householdId}::uuid, ${categoryName}, ${groupId}::uuid, NOW(), NOW())
      ON CONFLICT (household_id, category_name) DO UPDATE SET group_id = EXCLUDED.group_id, updated_at = NOW()`;
    return { categoryName, groupId };
  });
}
