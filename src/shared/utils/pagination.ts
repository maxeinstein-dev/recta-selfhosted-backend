import { z } from 'zod';

/**
 * Pagination query schema for cursor-based pagination
 */
export const paginationSchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationQuery = z.infer<typeof paginationSchema>;

/**
 * Paginated response structure
 */
export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    nextCursor: string | null;
    hasMore: boolean;
    total?: number;
  };
}

/**
 * Create a paginated response
 */
export function createPaginatedResponse<T extends { id: string }>(
  items: T[],
  limit: number,
  total?: number
): PaginatedResponse<T> {
  const hasMore = items.length > limit;
  const data = hasMore ? items.slice(0, limit) : items;
  const nextCursor = hasMore ? data[data.length - 1]?.id ?? null : null;

  return {
    data,
    pagination: {
      nextCursor,
      hasMore,
      ...(total !== undefined && { total }),
    },
  };
}

/**
 * Build Prisma pagination args for cursor-based pagination
 */
export function buildPaginationArgs(params: PaginationQuery) {
  const { cursor, limit } = params;

  return {
    take: limit + 1, // Take one extra to check if there are more
    ...(cursor && {
      skip: 1, // Skip the cursor item
      cursor: { id: cursor },
    }),
  };
}

/**
 * Month filter schema (YYYY-MM format)
 */
export const monthFilterSchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be in YYYY-MM format')
    .optional(),
});

/**
 * 'YYYY-MM-DD' of a Date read as a UTC day: the day a `@db.Date` column holds for that instant.
 * The driver truncates a Date bound to its UTC date and Prisma returns `@db.Date` values as UTC midnight, so
 * every date-only bound has to be a UTC-midnight Date, whatever time zone the process runs in.
 */
export function utcDayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Parse a 'YYYY-MM' month into its first and last day as UTC-midnight Dates, to filter `@db.Date` columns with
 * `gte: start, lte: end` (both days inclusive). Local-time bounds (the last day at 23:59:59.999) are wrong behind
 * UTC: in America/Sao_Paulo that instant is already the first day of the next month in UTC, so the driver
 * truncated it to that day and every month list and total also counted the first day of the following month.
 */
export function parseMonthFilter(month: string): { start: Date; end: Date } {
  const [year, monthNum] = month.split('-').map(Number);
  const start = new Date(Date.UTC(year!, monthNum! - 1, 1));
  // Day 0 of the next month is the last day of this one
  const end = new Date(Date.UTC(year!, monthNum!, 0));
  return { start, end };
}
