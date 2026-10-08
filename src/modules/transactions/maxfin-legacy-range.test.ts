import { afterAll, describe, expect, it } from 'vitest';
import { localDaysAsUtcRange } from './maxfin-import.service.js';

const originalTz = process.env.TZ;
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe.each(['America/Sao_Paulo', 'UTC', 'Asia/Tokyo', 'Pacific/Kiritimati'])('legacy dedup range with TZ=%s', (zone) => {
  it('is the UTC days of the first and last local day, never reaching the next day', () => {
    process.env.TZ = zone;
    const { start, end } = localDaysAsUtcRange(new Date(2026, 8, 30).getTime(), new Date(2026, 9, 31).getTime());
    expect([start.toISOString(), end.toISOString()]).toEqual(['2026-09-30T00:00:00.000Z', '2026-10-31T00:00:00.000Z']);
  });
});
