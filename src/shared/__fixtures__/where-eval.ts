/**
 * Tiny evaluator of the Prisma `where` shapes the month filters build (AND / OR / NOT, equality, null, in, gte / lte,
 * contains), over rows whose `date` is a 'YYYY-MM-DD' string. A Date bound is read by its UTC calendar day, which is
 * what the driver does with a bound on a `@db.Date` column (it sends the UTC date part), so a bound that is not built
 * as a UTC-midnight day is judged here exactly as the database judges it, in every time zone.
 */
export type Row = Record<string, unknown>;

const asDay = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

export function matchesWhere(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'AND') {
      const list = Array.isArray(condition) ? condition : [condition];
      if (!list.every((w) => matchesWhere(row, w as Record<string, unknown>))) return false;
      continue;
    }
    if (key === 'OR') {
      if (!(condition as Array<Record<string, unknown>>).some((w) => matchesWhere(row, w))) return false;
      continue;
    }
    if (key === 'NOT') {
      const list = Array.isArray(condition) ? condition : [condition];
      if (list.some((w) => matchesWhere(row, w as Record<string, unknown>))) return false;
      continue;
    }
    const value = row[key];
    if (condition === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (typeof condition !== 'object' || condition instanceof Date) {
      if (value !== condition) return false;
      continue;
    }
    const c = condition as Record<string, unknown>;
    if ('in' in c && !(c.in as unknown[]).includes(value)) return false;
    if ('equals' in c && value !== c.equals) return false;
    if ('contains' in c && !(typeof value === 'string' && value.toLowerCase().includes(String(c.contains).toLowerCase()))) return false;
    if ('gte' in c && !(asDay(value) >= asDay(c.gte))) return false;
    if ('lte' in c && !(asDay(value) <= asDay(c.lte))) return false;
  }
  return true;
}
