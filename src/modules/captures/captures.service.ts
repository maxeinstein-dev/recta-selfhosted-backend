import { createHash } from 'node:crypto';
import { prisma } from '../../shared/db/prisma.js';
import type { CaptureItemInput } from './captures.schema.js';

export interface CaptureResult {
  dedupKey: string;
  status: 'created' | 'duplicate';
}

const MINUTE_MS = 60_000;

/** `postedAt` cut to the minute, as a UTC ISO string: the same notification sent twice, or in two zones, hashes alike. */
export function postedAtToMinuteIso(postedAt: Date): string {
  return new Date(Math.floor(postedAt.getTime() / MINUTE_MS) * MINUTE_MS).toISOString();
}

/** sha1(package | postedAt to the minute (UTC ISO) | title ?? '' | text), hex (40 chars). */
export function computeDedupKey(item: { package: string; title?: string | null; postedAt: Date; text: string }): string {
  return createHash('sha1')
    .update([item.package, postedAtToMinuteIso(item.postedAt), item.title ?? '', item.text].join('|'))
    .digest('hex');
}

/**
 * Stores the raw captures of one device request, idempotently, and reports each item in input order.
 * One INSERT ... ON CONFLICT DO NOTHING RETURNING: the unique (household_id, dedup_key) decides, so two concurrent
 * requests with the same item create one row, and only the winner sees it as `created`.
 */
export async function ingestCaptures(
  scope: { householdId: string; userId: string },
  items: CaptureItemInput[]
): Promise<CaptureResult[]> {
  const prepared = items.map((item) => {
    const postedAt = new Date(item.postedAt);
    return { item, postedAt, dedupKey: computeDedupKey({ ...item, postedAt }) };
  });

  // Repeats inside the batch: only the first occurrence is inserted (a repeat in one INSERT would be skipped
  // anyway, but then the result could not say which of the two was the creator).
  const firstByKey = new Map<string, (typeof prepared)[number]>();
  for (const entry of prepared) {
    if (!firstByKey.has(entry.dedupKey)) firstByKey.set(entry.dedupKey, entry);
  }

  const inserted = await prisma.capturedNotification.createManyAndReturn({
    data: [...firstByKey.values()].map(({ item, postedAt, dedupKey }) => ({
      householdId: scope.householdId,
      userId: scope.userId,
      package: item.package,
      title: item.title ?? null,
      text: item.text,
      postedAt,
      dedupKey,
      status: 'PENDING' as const,
    })),
    skipDuplicates: true,
    select: { dedupKey: true },
  });
  const created = new Set(inserted.map((row) => row.dedupKey));

  const reported = new Set<string>();
  return prepared.map(({ dedupKey }) => {
    const isCreator = created.has(dedupKey) && !reported.has(dedupKey);
    reported.add(dedupKey);
    return { dedupKey, status: isCreator ? ('created' as const) : ('duplicate' as const) };
  });
}
