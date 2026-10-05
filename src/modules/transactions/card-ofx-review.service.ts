/**
 * Review queue of the card OFX import: sheet rows on the card that found no bank line, in months whose statement was
 * imported (some row of the month is already tied to an OFX line). For each one the user decides:
 *  - keep: it is real but has no receipt in the statement ("sem comprovante"): marked with the external ref
 *    `reviewed:<transaction id>`, which also takes it out of the reconciliation candidates (no migration);
 *  - unkeep: take that mark away, the row goes back to the queue;
 *  - move: it was paid some other way (cash, Pix): the row goes to another account of the household through the
 *    transaction service, which claims the row, keeps the balances right and frees the card limit;
 *  - delete: it should not exist: removed through the transaction service, leaving a tombstone
 *    (`deleted:<sheet ref>` anchored on a surviving row of the month) so re-importing the workbook does not bring it
 *    back.
 * Everything is household scoped (the card is authorized by the route) and idempotent: a row that is no longer in the
 * queue is reported as skipped, never acted on twice. A request is partial, row by row: an unexpected error on one
 * row is reported as `failed` and the others are still tried.
 */
import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError } from '../../shared/errors/app-error.js';
import { isFutureDraftRef } from './maxfin-import.helpers.js';
import type {
  CardOfxReviewAction,
  CardOfxReviewActionResult,
  CardOfxReviewActionsResponse,
  CardOfxReviewItem,
  CardOfxReviewQueue,
} from './card-ofx-import.types.js';
import {
  CARD_ROW_SELECT,
  LinkedRowError,
  isAlreadyTakenOrGone,
  isNotFound,
  lockRowsOrThrowIfLinked,
  markMergeBlocked,
  payingAccount,
  storedRows,
  type ResolvedCardAccount,
} from './card-ofx-import.service.js';
import { isUniqueViolation } from './maxfin-import.service.js';
import { toCents, type StoredCardRow } from './ofx-reconcile.js';
import { deleteTransaction, updateTransaction } from './transactions.service.js';

export const REVIEWED_REF_PREFIX = 'reviewed:';
export const DELETED_REF_PREFIX = 'deleted:';
export const DEFAULT_REVIEW_LIMIT = 200;
export const MAX_REVIEW_LIMIT = 500;
export const MAX_REVIEW_ACTIONS = 200;

const SHEET_REF = /^maxfin:(\d{4}-\d{2}):credit:(\d+)$/;

export function reviewedRef(transactionId: string): string {
  return `${REVIEWED_REF_PREFIX}${transactionId}`;
}

/** Tombstone ref of a deleted sheet row: `deleted:` + its sourceRef (the sheet importer reads it as "already imported"). */
export function deletedRef(sourceRef: string): string {
  return `${DELETED_REF_PREFIX}${sourceRef}`;
}

interface QueueRow {
  row: StoredCardRow;
  monthKey: string;
  line: number;
}

interface QueueState {
  /** Eligible rows (see loadQueueRows), or the kept ones for the 'kept' view. */
  rows: QueueRow[];
  /** Per sheet month: a surviving row tied to an OFX line, where tombstones are anchored. */
  anchors: Map<string, string>;
}

/** Sheet rows of statement months, with no external ref (view 'queue') or only the reviewed mark (view 'kept'). */
async function loadQueueRows(account: ResolvedCardAccount, view: 'queue' | 'kept', onlyIds?: string[]): Promise<QueueState> {
  const { householdId } = account;
  const sheet = storedRows(
    await prisma.transaction.findMany({
      where: { householdId, accountId: account.id, sourceRef: { startsWith: 'maxfin:', contains: ':credit:' } },
      select: CARD_ROW_SELECT,
    }),
  ).filter((row) => !isFutureDraftRef(row.sourceRef) && SHEET_REF.test(row.sourceRef ?? ''));
  if (sheet.length === 0) return { rows: [], anchors: new Map() };
  const refs = await prisma.transactionExternalRef.findMany({
    where: { householdId, transactionId: { in: sheet.map((row) => row.id) } },
    select: { transactionId: true, ref: true },
  });
  const monthOf = new Map(sheet.map((row) => [row.id, SHEET_REF.exec(row.sourceRef!)![1]!]));
  const refsOf = new Map<string, string[]>();
  for (const r of refs) refsOf.set(r.transactionId, [...(refsOf.get(r.transactionId) ?? []), r.ref]);
  const statementMonths = new Set<string>();
  const anchors = new Map<string, string>();
  for (const r of refs) {
    if (!r.ref.startsWith('ofx:')) continue;
    const month = monthOf.get(r.transactionId)!;
    statementMonths.add(month);
    if (!anchors.has(month)) anchors.set(month, r.transactionId);
  }

  const wanted = onlyIds ? new Set(onlyIds) : null;
  const keptOnly = (id: string) => {
    const own = refsOf.get(id) ?? [];
    return own.length > 0 && own.every((ref) => ref === reviewedRef(id));
  };
  const picked = sheet.filter((row) => {
    if (wanted && !wanted.has(row.id)) return false;
    if (view === 'kept') return keptOnly(row.id);
    return !refsOf.has(row.id) && statementMonths.has(monthOf.get(row.id)!);
  });
  await markMergeBlocked(picked);
  const rows = picked
    .map((row) => ({ row, monthKey: monthOf.get(row.id)!, line: Number(SHEET_REF.exec(row.sourceRef!)![2]) }))
    .sort((a, b) => (a.monthKey < b.monthKey ? -1 : a.monthKey > b.monthKey ? 1 : a.line - b.line));
  return { rows, anchors };
}

function signed(row: StoredCardRow): number {
  return row.type === 'EXPENSE' ? toCents(row.amount) : -toCents(row.amount);
}

export async function listReviewQueue(params: {
  account: ResolvedCardAccount;
  monthKey?: string;
  limit?: number;
  view?: 'queue' | 'kept';
}): Promise<CardOfxReviewQueue> {
  const view = params.view ?? 'queue';
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_REVIEW_LIMIT, 1), MAX_REVIEW_LIMIT);
  const all = (await loadQueueRows(params.account, view)).rows.filter((q) => !params.monthKey || q.monthKey === params.monthKey);
  const months = new Map<string, { count: number; net: number }>();
  for (const q of all) {
    const entry = months.get(q.monthKey) ?? { count: 0, net: 0 };
    entry.count += 1;
    entry.net += signed(q.row);
    months.set(q.monthKey, entry);
  }
  const items: CardOfxReviewItem[] = all.slice(0, limit).map(({ row, monthKey }) => ({
    transactionId: row.id,
    description: row.description,
    amount: row.amount,
    type: row.type,
    date: row.date,
    sourceRef: row.sourceRef!,
    monthKey,
    categoryName: row.categoryName ?? null,
    blocked: !!row.mergeBlocked,
  }));
  return {
    accountId: params.account.id,
    view,
    items,
    months: [...months.entries()].map(([monthKey, v]) => ({ monthKey, count: v.count, net: v.net / 100 })),
    totals: { count: all.length, net: all.reduce((total, q) => total + signed(q.row), 0) / 100 },
    truncated: all.length > items.length,
  };
}

function errorCode(error: unknown): string {
  const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  return typeof code === 'string' ? code : typeof name === 'string' ? name : 'ERROR';
}

/** The transaction service's 409: someone else changed the row between the check and the claim. */
function isConflict(error: unknown): boolean {
  const { code, statusCode } = (error ?? {}) as { code?: unknown; statusCode?: unknown };
  return code === 'CONFLICT' || statusCode === 409;
}

export async function applyReviewActions(params: {
  account: ResolvedCardAccount;
  actions: CardOfxReviewAction[];
}): Promise<CardOfxReviewActionsResponse> {
  const { account, actions } = params;
  const { householdId } = account;
  if (actions.length > MAX_REVIEW_ACTIONS) throw new BadRequestError(`At most ${MAX_REVIEW_ACTIONS} actions per request.`);
  const seen = new Set<string>();
  for (const action of actions) {
    if (seen.has(action.transactionId)) throw new BadRequestError(`Duplicate action for ${action.transactionId}`);
    seen.add(action.transactionId);
    if (action.action === 'move' && !action.targetAccountId) {
      throw new BadRequestError(`move needs targetAccountId (${action.transactionId})`);
    }
  }
  // Validate every destination before the first write.
  for (const target of new Set(actions.filter((a) => a.action === 'move').map((a) => a.targetAccountId!))) {
    const status = await payingAccount(target, householdId);
    if (status === 'missing') throw new BadRequestError('targetAccountId: account not found or inactive in this household.');
    if (status === 'credit') throw new BadRequestError('targetAccountId: a row cannot be moved to a credit card.');
  }

  const ids = actions.map((a) => a.transactionId);
  const wantsQueue = actions.some((a) => a.action !== 'unkeep');
  const wantsKept = actions.some((a) => a.action === 'unkeep');
  const queue = wantsQueue ? await loadQueueRows(account, 'queue', ids) : { rows: [], anchors: new Map<string, string>() };
  const kept = wantsKept ? await loadQueueRows(account, 'kept', ids) : { rows: [], anchors: new Map<string, string>() };
  const inQueue = new Map(queue.rows.map((q) => [q.row.id, q]));
  const inKept = new Map(kept.rows.map((q) => [q.row.id, q]));

  const results: CardOfxReviewActionResult[] = [];
  const warnings = new Set<string>();
  for (const action of actions) {
    const base = { transactionId: action.transactionId, action: action.action };
    const entry = action.action === 'unkeep' ? inKept.get(action.transactionId) : inQueue.get(action.transactionId);
    if (!entry) {
      results.push({ ...base, status: 'skipped', reason: 'not-in-queue' });
      continue;
    }
    if ((action.action === 'move' || action.action === 'delete') && entry.row.mergeBlocked) {
      results.push({ ...base, status: 'blocked', reason: 'has-shares-split-settlement-recurrence-or-attachment' });
      continue;
    }
    try {
      if (action.action === 'keep') {
        await prisma.transactionExternalRef.create({ data: { householdId, transactionId: action.transactionId, ref: reviewedRef(action.transactionId) } });
      } else if (action.action === 'unkeep') {
        const removed = await prisma.transactionExternalRef.deleteMany({
          where: { householdId, transactionId: action.transactionId, ref: reviewedRef(action.transactionId) },
        });
        if (removed.count !== 1) {
          results.push({ ...base, status: 'skipped', reason: 'changed-meanwhile' });
          continue;
        }
      } else if (action.action === 'move') {
        await updateTransaction(action.transactionId, householdId, { accountId: action.targetAccountId! });
      } else {
        const anchor = queue.anchors.get(entry.monthKey);
        const tombstone = deletedRef(entry.row.sourceRef!);
        let tombstoned = false;
        let createdHere = false;
        if (anchor) {
          try {
            await prisma.transactionExternalRef.create({ data: { householdId, transactionId: anchor, ref: tombstone } });
            tombstoned = true;
            createdHere = true;
          } catch (error) {
            // Only a unique violation means "already there" (a concurrent or earlier attempt). A missing anchor row
            // (foreign key) means no tombstone; anything else is a real failure.
            if (isUniqueViolation(error)) tombstoned = true;
            else if ((error as { code?: unknown })?.code !== 'P2003') throw error;
          }
        }
        try {
          await deleteTransaction(action.transactionId, householdId, {
            guard: (tx) => lockRowsOrThrowIfLinked(tx, [action.transactionId]),
          });
        } catch (error) {
          // Take back only the tombstone this call wrote, and only when the row still exists: if it is gone, someone else
          // deleted it and the tombstone must stay.
          if (createdHere && !isNotFound(error)) await prisma.transactionExternalRef.deleteMany({ where: { householdId, ref: tombstone } });
          throw error;
        }
        warnings.add(
          tombstoned
            ? 'Linhas apagadas não voltam ao reimportar a planilha (ficam registradas como removidas); para trazê-las de volta, reimporte-as à mão.'
            : 'Não havia linha de apoio no mês para registrar a remoção: reimportar a planilha traz as linhas apagadas de volta.',
        );
      }
      results.push({ ...base, status: 'done' });
    } catch (error) {
      if (error instanceof LinkedRowError) results.push({ ...base, status: 'blocked', reason: 'has-shares-or-settlement' });
      else if (isConflict(error) || isAlreadyTakenOrGone(error) || isNotFound(error)) {
        // Lost a race (marked, moved or deleted meanwhile): nothing was written for this row.
        results.push({ ...base, status: 'skipped', reason: 'changed-meanwhile' });
      } else results.push({ ...base, status: 'failed', reason: errorCode(error) });
    }
  }
  const count = (status: CardOfxReviewActionResult['status']) => results.filter((r) => r.status === status).length;
  return { results, done: count('done'), skipped: count('skipped'), blocked: count('blocked'), failed: count('failed'), warnings: [...warnings] };
}
