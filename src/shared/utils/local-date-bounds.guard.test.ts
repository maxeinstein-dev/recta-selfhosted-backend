import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Structural guard: a date bound built in local time against a `@db.Date` column is wrong behind UTC. The driver sends
 * the UTC date part of the Date, so a local 23:59:59.999 is already the next day and a local month end counted the first
 * day of the following month (see parseMonthFilter). Bounds on those columns are built with Date.UTC (a UTC-midnight day).
 *
 * The guard counts, per production file, the constructs that make a local-time Date:
 *   - `.setHours(` (and the `23, 59, 59` end-of-day literal),
 *   - `new Date(a, b, ...)` with local components (anything but `Date.UTC`, a string or a number-only argument).
 * Every occurrence that is legitimate is listed below with the reason. A new occurrence, in a listed or an unlisted file,
 * fails the test: build the bound with Date.UTC / utcDayString, or list it here with why it is not a column bound.
 */
type Counts = { setHours: number; endOfDay: number; localDate: number };

/** Number of `new Date(...)` calls whose arguments are local components (a top-level comma, not `Date.UTC`). */
function countLocalConstructors(code: string): number {
  let found = 0;
  for (const match of code.matchAll(/new Date\(/g)) {
    let depth = 1;
    let comma = false;
    let i = match.index! + match[0].length;
    const start = i;
    for (; i < code.length && depth > 0; i += 1) {
      const c = code[i];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      else if (c === ',' && depth === 1) comma = true;
    }
    if (comma && !code.slice(start, i).trimStart().startsWith('Date.UTC')) found += 1;
  }
  return found;
}

export function scanLocalDates(source: string): Counts {
  // Comments are not code: strip them so prose does not count
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const count = (re: RegExp) => (code.match(re) ?? []).length;
  return {
    setHours: count(/\.setHours\(/g),
    endOfDay: count(/\b23,\s*59,\s*59\b/g),
    localDate: countLocalConstructors(code),
  };
}

const ALLOWED: Record<string, { counts: Partial<Counts>; why: string }> = {
  'src/jobs/processRecurrences.ts': { counts: { setHours: 2 }, why: 'normalizes "today" and a start date to local midnight to compare days of recurrences, not a column bound' },
  'src/modules/accounts/accounts.schema.ts': { counts: { localDate: 2 }, why: 'local calendar day of an adjustment date: validation and "today" (written through localDateSchema semantics)' },
  'src/modules/accounts/accounts.service.ts': { counts: { localDate: 1 }, why: 'default adjustment date, the local day, written like every other date the app stores' },
  'src/modules/dashboard/dashboard.service.ts': { counts: { localDate: 1 }, why: 'month label only (toLocaleString)' },
  'src/modules/notifications/budget-notifications.service.ts': { counts: { endOfDay: 1, localDate: 2 }, why: 'bounds of the notifications createdAt, a timestamp (an instant), not a @db.Date column' },
  'src/modules/recurring-transactions/recurring-dates.ts': { counts: { localDate: 2 }, why: 'localDate() is the local-midnight value the services write; daysInMonth only counts days' },
  'src/modules/recurring-transactions/recurring-follow.ts': { counts: { localDate: 1 }, why: 'day arithmetic that is turned back into a YYYY-MM-DD string' },
  'src/modules/recurring-transactions/recurring-transactions.service.ts': { counts: { setHours: 7 }, why: 'local-midnight normalization of recurrence dates before comparing them with each other' },
  'src/modules/transactions/transactions.service.ts': { counts: { setHours: 4, localDate: 1 }, why: 'recurrence generation normalizes dates to local midnight; one daysInMonth count' },
  'src/modules/transactions/maxfin-import.helpers.ts': { counts: { localDate: 4 }, why: 'parse sheet days to local midnight (writes) and count days of a month' },
  'src/modules/transactions/parsers/maxfin.parser.ts': { counts: { localDate: 2 }, why: 'parsed row dates, local midnight like the other parsers' },
  'src/modules/transactions/parsers/csv.parser.ts': { counts: { localDate: 1 }, why: 'parsed row date at local time (stored through the driver, never a bound)' },
  'src/modules/transactions/parsers/ofx.parser.ts': { counts: { localDate: 1 }, why: 'parsed row date at local time (stored through the driver, never a bound)' },
  'src/shared/utils/date.ts': { counts: { localDate: 1 }, why: 'createDate factory (local)' },
  'src/shared/utils/dateSchema.ts': { counts: { localDate: 4 }, why: 'localDateSchema: YYYY-MM-DD becomes the local-midnight value the app writes' },
};

function productionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__fixtures__' || name === 'generated' || name === 'scripts' ? [] : productionFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

describe('local-time date constructs', () => {
  it('only appear where they are not bounds of a @db.Date column (allowlist)', () => {
    const found: Record<string, Counts> = {};
    for (const file of productionFiles('src')) {
      const counts = scanLocalDates(readFileSync(file, 'utf8'));
      if (counts.setHours + counts.endOfDay + counts.localDate > 0) found[relative('.', file).split(sep).join('/')] = counts;
    }
    const expected: Record<string, Counts> = {};
    for (const [file, { counts }] of Object.entries(ALLOWED)) expected[file] = { setHours: 0, endOfDay: 0, localDate: 0, ...counts };
    expect(found).toEqual(expected);
  });

  describe('the scanner (negative and positive fixtures)', () => {
    it('flags a local end-of-day bound and a local month end', () => {
      expect(scanLocalDates('end.setHours(23, 59, 59, 999);')).toMatchObject({ setHours: 1, endOfDay: 1 });
      expect(scanLocalDates('const end = new Date(year, monthNum, 0, 23, 59, 59, 999);')).toMatchObject({ localDate: 1, endOfDay: 1 });
      expect(scanLocalDates('new Date(d.getFullYear(), d.getMonth(), 1)').localDate).toBe(1);
      expect(scanLocalDates('new Date(1970, 0, 1)').localDate).toBe(1);
    });

    it('accepts UTC day bounds, ISO strings, copies and comments', () => {
      const clean = [
        'const end = new Date(Date.UTC(year, month, 0));',
        'new Date(`${day}T00:00:00.000Z`)',
        'new Date(value)',
        'new Date()',
        'new Date(Math.min(...times))',
        '// end.setHours(23, 59, 59, 999) would be the next day in UTC',
        '/* new Date(y, m, 1) */',
      ].join('\n');
      expect(scanLocalDates(clean)).toEqual({ setHours: 0, endOfDay: 0, localDate: 0 });
    });
  });
});
