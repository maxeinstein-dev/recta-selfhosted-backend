import { afterAll, describe, expect, it } from 'vitest';
import { budgetMonthStart } from './budgets.service.js';
import { updateBudgetSchema } from './budgets.schema.js';
import { getDayRange } from '../transactions/import.service.js';

const originalTz = process.env.TZ;

afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe.each(['America/Sao_Paulo', 'UTC', 'Asia/Tokyo', 'Pacific/Kiritimati'])('stored month and day keys with TZ=%s', (zone) => {
  it('a budget month is the first day of the picked month as UTC midnight, also for the first and last day', () => {
    process.env.TZ = zone;
    expect(budgetMonthStart(new Date(2026, 9, 1)).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(budgetMonthStart(new Date(2026, 9, 31)).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(budgetMonthStart(new Date(2026, 11, 31)).toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it('updating a budget month parses YYYY-MM-DD as the local day, so the first of October stays October', () => {
    process.env.TZ = zone;
    const { month } = updateBudgetSchema.parse({ month: '2026-10-01' });
    expect(budgetMonthStart(month!).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('the import dedup window is the one UTC day the row is stored on', () => {
    process.env.TZ = zone;
    const stamp = new Date(Date.UTC(2026, 9, 31, 12, 0, 0));
    const { start, end } = getDayRange(stamp);
    expect([start.toISOString(), end.toISOString()]).toEqual(['2026-10-31T00:00:00.000Z', '2026-10-31T00:00:00.000Z']);
  });
});
