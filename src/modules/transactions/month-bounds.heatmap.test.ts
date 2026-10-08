import { afterAll, describe, expect, it, vi } from 'vitest';

// The daily heatmaps aggregate in SQL, where a Date parameter is an instant: a local 23:59:59.999 end bound reached
// the first day of the next month (its day 1 was added to day 1 of the month). They bind 'YYYY-MM-DD' text now.
const calls = vi.hoisted(() => [] as unknown[][]);

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    account: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      return [];
    }),
  },
}));

const { getSpendingHeatmap } = await import('./transactions.service.js');
const originalTz = process.env.TZ;

afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe.each(['America/Sao_Paulo', 'UTC', 'Asia/Tokyo', 'Pacific/Kiritimati'])('getSpendingHeatmap bounds with TZ=%s', (zone) => {
  it.each([
    ['2026-10', '2026-10-01', '2026-10-31', 31],
    ['2024-02', '2024-02-01', '2024-02-29', 29],
    ['2026-12', '2026-12-01', '2026-12-31', 31],
  ])('%s binds the first and last day as date text', async (month, first, last, days) => {
    process.env.TZ = zone;
    calls.length = 0;
    const heatmap = await getSpendingHeatmap('hh-1', month);
    const values = calls[0]!.slice(1);
    expect(values).toContain(first);
    expect(values).toContain(last);
    expect(values.some((v) => v instanceof Date)).toBe(false);
    expect(heatmap.daysInMonth).toBe(days);
  });
});
