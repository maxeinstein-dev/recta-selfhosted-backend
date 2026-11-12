import { createHash } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { ConflictError, NotFoundError } from '../../shared/errors/index.js';
import { buildPaginationArgs, createPaginatedResponse } from '../../shared/utils/pagination.js';
import { createTransaction, getTransactionWithHousehold } from '../transactions/transactions.service.js';
import type { CreateTransactionInput } from '../transactions/transactions.schema.js';
import { buildSuggestion, type SuggestionRule } from './capture-suggestion.js';
import { PARSER_VERSION, parseCapture } from './parsers/index.js';
import type { AccountRuleInput, CaptureItemInput, CaptureStatusValue, ConfirmCaptureInput } from './captures.schema.js';

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
    data: [...firstByKey.values()].map(({ item, postedAt, dedupKey }) => {
      // The raw text is stored either way; a reading only adds `parsed` (and IGNORED for a known informative notice).
      const parsed = parseCapture({ package: item.package, title: item.title ?? null, text: item.text });
      return {
        householdId: scope.householdId,
        userId: scope.userId,
        package: item.package,
        title: item.title ?? null,
        text: item.text,
        postedAt,
        dedupKey,
        status: parsed?.ignore ? ('IGNORED' as const) : ('PENDING' as const),
        ...(parsed ? { parsed: parsed as unknown as Prisma.InputJsonObject, parserVersion: PARSER_VERSION } : {}),
      };
    }),
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

// ---------------------------------------------------------------------------------------------------------------
// Drafts (user JWT): list, count, confirm, dismiss, restore and the account rules.
// ---------------------------------------------------------------------------------------------------------------

const CAPTURE_SELECT = {
  id: true,
  package: true,
  title: true,
  text: true,
  postedAt: true,
  status: true,
  parsed: true,
  transactionId: true,
} as const;

type CaptureRow = Prisma.CapturedNotificationGetPayload<{ select: typeof CAPTURE_SELECT }>;

function toCaptureDto(row: CaptureRow, rules: readonly SuggestionRule[]) {
  // Explicit fields: the rows of the transition routes also carry the dedupKey, which is not part of the API.
  const { id, package: pkg, title, text, postedAt, status, parsed, transactionId } = row;
  return { id, package: pkg, title, text, postedAt, status, parsed, transactionId, suggestion: buildSuggestion(row, rules) };
}

/** Newest first; `id` breaks ties between captures of the same instant so cursor pages neither overlap nor skip. */
const CAPTURE_ORDER: Prisma.CapturedNotificationOrderByWithRelationInput[] = [{ postedAt: 'desc' }, { id: 'desc' }];

export async function listCaptures(householdId: string, query: { status: CaptureStatusValue; cursor?: string; limit: number }) {
  const [rows, rules] = await Promise.all([
    prisma.capturedNotification.findMany({
      where: { householdId, status: query.status },
      select: CAPTURE_SELECT,
      orderBy: CAPTURE_ORDER,
      ...buildPaginationArgs({ cursor: query.cursor, limit: query.limit }),
    }),
    prisma.captureAccountRule.findMany({ where: { householdId }, select: { package: true, kind: true, accountId: true } }),
  ]);
  const page = createPaginatedResponse(rows, query.limit);
  return { data: page.data.map((row) => toCaptureDto(row, rules)), pagination: page.pagination };
}

export async function countCaptures(householdId: string, status: CaptureStatusValue): Promise<number> {
  return prisma.capturedNotification.count({ where: { householdId, status } });
}

async function loadCapture(householdId: string, id: string) {
  const capture = await prisma.capturedNotification.findFirst({
    where: { id, householdId },
    select: { ...CAPTURE_SELECT, dedupKey: true },
  });
  if (!capture) throw new NotFoundError('Capture');
  return capture;
}

/** The source reference of the transaction a capture becomes: unique per household, so it is the dedup of confirm. */
export function captureSourceRef(dedupKey: string): string {
  return `notif:${dedupKey}`;
}

const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown })?.code === 'P2002';

/**
 * 409: the capture is CONFIRMED but its transaction was deleted afterwards (the FK sets transaction_id to NULL).
 * Deleting a transaction leaves the capture as is; it is out of the PENDING list and cannot be confirmed again.
 */
export class CaptureTransactionRemovedError extends ConflictError {
  constructor() {
    super('The transaction created from this capture was deleted; the capture stays confirmed and cannot be confirmed again');
  }
}

export interface ConfirmResult {
  /** false when the capture was already confirmed (nothing was created by this call). */
  created: boolean;
  capture: { id: string; status: CaptureStatusValue; transactionId: string };
  transaction: Awaited<ReturnType<typeof getTransactionWithHousehold>>;
}

async function confirmedResult(householdId: string, captureId: string, transactionId: string, created: boolean): Promise<ConfirmResult> {
  return {
    created,
    capture: { id: captureId, status: 'CONFIRMED', transactionId },
    transaction: await getTransactionWithHousehold(transactionId, householdId),
  };
}

/**
 * Turns a PENDING capture into a transaction, once.
 *
 * Mechanism: the transaction is created through createTransaction with `sourceRef = notif:<dedupKey>` and the capture
 * is claimed (PENDING -> CONFIRMED, transaction_id set) by the `inTransaction` hook, i.e. in the SAME database
 * transaction as the insert and the balance update. So there is never a CONFIRMED capture without a transaction, nor
 * a notification transaction whose capture is still PENDING; if the claim finds the capture no longer PENDING (a
 * concurrent dismiss) it throws and the whole creation rolls back (409).
 * Race: of two simultaneous confirms the unique (household_id, source_ref) lets one insert commit; the other blocks on
 * the index, then fails with P2002 and answers with the winner's transaction. A leftover transaction carrying the
 * reference while the capture is PENDING (not producible by this code, but cheap to heal) is linked by the same path.
 */
export async function confirmCapture(
  scope: { householdId: string; userId: string },
  captureId: string,
  input: ConfirmCaptureInput
): Promise<ConfirmResult> {
  const { householdId, userId } = scope;
  const capture = await loadCapture(householdId, captureId);

  if (capture.status === 'CONFIRMED') {
    if (!capture.transactionId) throw new CaptureTransactionRemovedError();
    return confirmedResult(householdId, capture.id, capture.transactionId, false);
  }
  if (capture.status !== 'PENDING') {
    throw new ConflictError(`A ${capture.status.toLowerCase()} capture cannot be confirmed`);
  }

  const sourceRef = captureSourceRef(capture.dedupKey);
  try {
    const transaction = await createTransaction(
      { ...input, householdId, sourceRef, isSplit: false } as CreateTransactionInput,
      userId,
      {
        inTransaction: async (tx, created) => {
          const claimed = await tx.capturedNotification.updateMany({
            where: { id: capture.id, householdId, status: 'PENDING' },
            data: { status: 'CONFIRMED', transactionId: created.id },
          });
          if (claimed.count !== 1) throw new ConflictError('The capture is no longer pending');
        },
      }
    );
    return { created: true, capture: { id: capture.id, status: 'CONFIRMED', transactionId: transaction.id }, transaction };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return resolveSourceRefConflict(householdId, capture.id, sourceRef, error);
  }
}

/** The loser of a confirm race (or a retry after a crash): converge on the transaction that owns the reference. */
async function resolveSourceRefConflict(householdId: string, captureId: string, sourceRef: string, original: unknown): Promise<ConfirmResult> {
  const owner = await prisma.transaction.findFirst({ where: { householdId, sourceRef }, select: { id: true } });
  if (!owner) throw original; // the unique violation was about something else
  const current = await prisma.capturedNotification.findFirst({ where: { id: captureId, householdId }, select: { status: true, transactionId: true } });
  if (!current) throw new NotFoundError('Capture');

  if (current.status === 'PENDING') {
    // Link the capture to the transaction that already carries its reference (conditional, so two heals agree).
    await prisma.capturedNotification.updateMany({
      where: { id: captureId, householdId, status: 'PENDING' },
      data: { status: 'CONFIRMED', transactionId: owner.id },
    });
    const healed = await prisma.capturedNotification.findFirst({ where: { id: captureId, householdId }, select: { status: true, transactionId: true } });
    if (healed?.status === 'CONFIRMED' && healed.transactionId === owner.id) return confirmedResult(householdId, captureId, owner.id, false);
  } else if (current.status === 'CONFIRMED' && current.transactionId === owner.id) {
    return confirmedResult(householdId, captureId, owner.id, false);
  }
  throw new ConflictError('The capture was changed by another request');
}

/** PENDING -> DISMISSED. Idempotent on DISMISSED; CONFIRMED and IGNORED answer 409. */
export async function dismissCapture(householdId: string, id: string) {
  const { count } = await prisma.capturedNotification.updateMany({
    where: { id, householdId, status: 'PENDING' },
    data: { status: 'DISMISSED' },
  });
  const capture = await loadCapture(householdId, id);
  if (count !== 1 && capture.status !== 'DISMISSED') {
    throw new ConflictError(`A ${capture.status.toLowerCase()} capture cannot be dismissed`);
  }
  return toCaptureDto(capture, []);
}

/** DISMISSED -> PENDING (undo of an accidental dismiss). Any other status, PENDING included, answers 409. */
export async function restoreCapture(householdId: string, id: string) {
  const { count } = await prisma.capturedNotification.updateMany({
    where: { id, householdId, status: 'DISMISSED' },
    data: { status: 'PENDING' },
  });
  const capture = await loadCapture(householdId, id);
  if (count !== 1) {
    throw new ConflictError(`Only a dismissed capture can be restored (this one is ${capture.status.toLowerCase()})`);
  }
  return toCaptureDto(capture, []);
}

export async function listAccountRules(householdId: string) {
  return prisma.captureAccountRule.findMany({
    where: { householdId },
    select: { package: true, kind: true, accountId: true },
    orderBy: [{ package: 'asc' }, { kind: 'asc' }],
  });
}

/**
 * Replaces the household's rules with `rules`, in one database transaction. Every account must be an active account
 * of the household (404 otherwise, so another household's id is indistinguishable from a missing one). The household
 * row is locked FOR UPDATE so two simultaneous replaces apply one after the other instead of colliding on the unique.
 */
export async function replaceAccountRules(householdId: string, rules: AccountRuleInput[]) {
  const accountIds = [...new Set(rules.map((rule) => rule.accountId))];
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM households WHERE id = ${householdId}::uuid FOR UPDATE`;
    if (accountIds.length > 0) {
      const found = await tx.account.count({ where: { id: { in: accountIds }, householdId, isActive: true } });
      if (found !== accountIds.length) throw new NotFoundError('Account');
    }
    await tx.captureAccountRule.deleteMany({ where: { householdId } });
    if (rules.length > 0) {
      await tx.captureAccountRule.createMany({
        data: rules.map((rule) => ({ householdId, package: rule.package, kind: rule.kind, accountId: rule.accountId })),
      });
    }
  });
  return listAccountRules(householdId);
}

// ---------------------------------------------------------------------------------------------------------------
// Reparse
// ---------------------------------------------------------------------------------------------------------------

/** Upper bound of one reparse run; a personal household has a handful of pending drafts. */
const REPARSE_LIMIT = 1000;

export interface ReparseResult {
  scanned: number;
  understood: number;
  ignored: number;
  notUnderstood: number;
  parserVersion: number;
}

/**
 * Reads again, with the current parser, the PENDING captures of the household (after a rule changed). A capture the
 * parser no longer understands loses its old reading; a known informative notice becomes IGNORED. Each update is
 * conditional on the capture still being PENDING, so a draft confirmed or dismissed meanwhile is left alone.
 * Nothing is created or deleted besides these two fields and the status.
 */
export async function reparseCaptures(householdId: string): Promise<ReparseResult> {
  const rows = await prisma.capturedNotification.findMany({
    where: { householdId, status: 'PENDING' },
    select: { id: true, package: true, title: true, text: true },
    orderBy: CAPTURE_ORDER,
    take: REPARSE_LIMIT,
  });
  const result: ReparseResult = { scanned: rows.length, understood: 0, ignored: 0, notUnderstood: 0, parserVersion: PARSER_VERSION };
  for (const row of rows) {
    const parsed = parseCapture(row);
    if (!parsed) result.notUnderstood += 1;
    else if (parsed.ignore) result.ignored += 1;
    else result.understood += 1;
    await prisma.capturedNotification.updateMany({
      where: { id: row.id, householdId, status: 'PENDING' },
      data: {
        parsed: parsed ? (parsed as unknown as Prisma.InputJsonObject) : Prisma.DbNull,
        parserVersion: PARSER_VERSION,
        ...(parsed?.ignore ? { status: 'IGNORED' as const } : {}),
      },
    });
  }
  return result;
}
