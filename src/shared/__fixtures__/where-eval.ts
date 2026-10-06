/**
 * Tiny evaluator of the Prisma `where` shapes the month filters build (AND / OR / NOT, equality, null, in, gte / lte,
 * contains), over rows whose `date` is a 'YYYY-MM-DD' string. Date bounds are read by their local calendar day, the
 * way the services build them (local midnight to local 23:59:59.999), so the tests do not depend on the time zone.
 */
export type Row = Record<string, unknown>;

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const asDay = (v: unknown) => (v instanceof Date ? localDay(v) : String(v));

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
