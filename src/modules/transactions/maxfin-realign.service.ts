/**
 * Database side of the shifted-rows realignment (see maxfin-realign.ts): loading what the detection needs, turning a
 * block into a proposal of the preview, and applying the decisions of a confirm.
 *
 * Applying only ever changes `sourceRef` (of the moved transactions, of their generated future installments and of the
 * external references that record absorbed rows' lines): in one database transaction, under an advisory lock of the
 * household and month and `FOR UPDATE` on the moved rows in id order, re-checking everything against the stored data,
 * through temporary references so that a chain of moves never meets the unique constraints halfway.
 */
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError } from '../../shared/errors/app-error.js';
import {
  MAX_REALIGN_SHIFT,
  MIN_VERIFIED_ROWS,
  buildSheetRef,
  compareIdentity,
  parseSheetRef,
  temporaryRef,
  type RealignBlock,
  type RealignSheetRow,
  type RealignStored,
} from './maxfin-realign.js';
import { MAXFIN_SECTION_LABELS } from './parsers/maxfin.types.js';
import type { MaxFinSectionKey } from './parsers/maxfin.types.js';
import type { MaxFinRealignDecision, MaxFinRealignOutcome, MaxFinRealignProposal } from './maxfin-import.types.js';

type Db = Prisma.TransactionClient;

/** Postgres unique violation surfaced by Prisma (duck-typed; same test as the importer's). */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

const MAX_DECISIONS = 50;
const MAX_MOVES = 500;

export interface MonthContext {
  stored: RealignStored[];
  tombstones: Array<{ section: MaxFinSectionKey; line: number }>;
  /** External references of the month that record a sheet line: `{ id, ref }` (ref without the `deleted:` prefix kept in `ref`). */
  lineRefs: Array<{ id: string; ref: string; section: MaxFinSectionKey; line: number }>;
}

/** Everything stored for one month's sheet refs (rows and generated futures), with the card-statement flags. */
export async function loadMonthContext(db: Db, householdId: string, monthKey: string): Promise<MonthContext> {
  const rows = await db.transaction.findMany({
    where: { householdId, sourceRef: { startsWith: `maxfin:${monthKey}:` } },
    select: {
      id: true,
      sourceRef: true,
      accountId: true,
      type: true,
      amount: true,
      description: true,
      notes: true,
      installmentNumber: true,
      totalInstallments: true,
    },
  });
  const parsed = rows.flatMap((row: any) => {
    const ref = parseSheetRef(row.sourceRef ?? '');
    return ref && ref.monthKey === monthKey ? [{ row, ref }] : [];
  });
  const ids = parsed.map((p) => p.row.id as string);
  const refs = await db.transactionExternalRef.findMany({
    where: {
      householdId,
      OR: [
        { ref: { startsWith: `maxfin:${monthKey}:` } },
        { ref: { startsWith: `deleted:maxfin:${monthKey}:` } },
        ...(ids.length > 0 ? [{ transactionId: { in: ids }, ref: { startsWith: 'ofx:' } }] : []),
      ],
    },
    select: { id: true, ref: true, transactionId: true },
  });
  const linked = new Set<string>();
  const mergeTargets = new Set<string>();
  const tombstones: MonthContext['tombstones'] = [];
  const lineRefs: MonthContext['lineRefs'] = [];
  for (const r of refs as Array<{ id: string; ref: string; transactionId: string }>) {
    if (r.ref.startsWith('ofx:')) {
      linked.add(r.transactionId);
      continue;
    }
    const bare = r.ref.startsWith('deleted:') ? r.ref.slice('deleted:'.length) : r.ref;
    const ref = parseSheetRef(bare);
    if (!ref || ref.future !== null || ref.monthKey !== monthKey) continue;
    tombstones.push({ section: ref.section, line: ref.line });
    lineRefs.push({ id: r.id, ref: r.ref, section: ref.section, line: ref.line });
    if (!r.ref.startsWith('deleted:')) mergeTargets.add(r.transactionId);
  }
  const stored: RealignStored[] = parsed.map(({ row, ref }) => ({
    id: row.id,
    ref: row.sourceRef,
    section: ref.section,
    line: ref.line,
    future: ref.future,
    accountId: row.accountId ?? null,
    type: String(row.type) === 'INCOME' ? 'INCOME' : 'EXPENSE',
    amount: typeof row.amount?.toNumber === 'function' ? row.amount.toNumber() : Number(row.amount),
    description: row.description ?? null,
    notes: row.notes ?? null,
    installment:
      row.installmentNumber != null && row.totalInstallments != null
        ? { number: row.installmentNumber, total: row.totalInstallments }
        : null,
    linked: linked.has(row.id),
    mergeTarget: mergeTargets.has(row.id),
  }));
  return { stored, tombstones, lineRefs };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function blockToProposal(block: RealignBlock): MaxFinRealignProposal {
  const label = MAXFIN_SECTION_LABELS[block.section] ?? block.section;
  const lines = Math.abs(block.shift);
  const count = block.rows.length;
  const detail =
    block.kind === 'insertion'
      ? `${label}: ${plural(count, 'lançamento está', 'lançamentos estão')} ${plural(lines, 'linha', 'linhas')} abaixo da posição em que ${count === 1 ? 'foi importado' : 'foram importados'} (${lines === 1 ? `linha inserida acima, na linha ${block.firstLine - 1}` : `linhas inseridas acima, nas linhas ${block.firstLine - lines} a ${block.firstLine - 1}`}). Realinhar troca só a referência de origem; valores, datas e conciliações não mudam.`
      : `${label}: ${plural(count, 'lançamento está', 'lançamentos estão')} ${plural(lines, 'linha', 'linhas')} acima da posição em que ${count === 1 ? 'foi importado' : 'foram importados'} (linhas removidas acima${block.removed.length > 0 ? `; ${plural(block.removed.length, 'lançamento removido da planilha continua', 'lançamentos removidos da planilha continuam')} no Recta` : ''}). Realinhar troca só a referência de origem; valores, datas e conciliações não mudam.`;
  return {
    id: block.id,
    section: block.section,
    kind: block.kind,
    shift: block.shift,
    firstLine: block.firstLine,
    lastLine: block.lastLine,
    moves: block.rows.map((r) => ({
      transactionId: r.transactionId,
      from: r.from,
      to: r.to,
      sheetLine: r.sheetLine,
      verified: r.verified,
      sheet: r.sheet,
      storedDescription: r.storedDescription,
      storedAmount: r.storedAmount,
    })),
    removed: block.removed.map((r) => ({ transactionId: r.transactionId, from: r.from, to: r.to, description: r.description, amount: r.amount })),
    insertedRefs: block.insertedRefs,
    requires: block.requires,
    defaultSelected: !block.ambiguous,
    ambiguous: block.ambiguous,
    reason: block.reason,
    detail,
  };
}

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

export interface ApplyRealignParams {
  householdId: string;
  monthKey: string;
  accountIds: Record<MaxFinSectionKey, string>;
  decisions: MaxFinRealignDecision[] | undefined;
}

export interface ApplyRealignResult {
  outcomes: MaxFinRealignOutcome[];
  realigned: number;
  warnings: string[];
  /**
   * Refs the row loop of the confirm must not replace: with the realignment applied the row at a moved line is the very
   * purchase it describes (replacing it would delete a reconciled purchase and duplicate it).
   */
  guardedRefs: Set<string>;
  /**
   * Refs of a block left pending (unticked, refused, stale): the row loop must not write them at all, neither replace
   * (it would overwrite the neighbour that still sits there) nor create (the last line of the block would duplicate a
   * purchase that is stored one line up).
   */
  pendingRefs: Set<string>;
}

/** Shape and consistency of what the client echoes. Anything off is a client bug or a tampered request: rejected before any write. */
function validateDecisions(decisions: MaxFinRealignDecision[], monthKey: string): void {
  if (decisions.length > MAX_DECISIONS) throw new BadRequestError(`Too many realignment decisions (max ${MAX_DECISIONS})`);
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (seen.has(decision.id)) throw new BadRequestError(`Duplicate realignment ${decision.id}`);
    seen.add(decision.id);
    if (!Number.isInteger(decision.shift) || decision.shift === 0 || Math.abs(decision.shift) > MAX_REALIGN_SHIFT) {
      throw new BadRequestError(`Realignment ${decision.id}: invalid shift ${decision.shift}`);
    }
    if (decision.moves.length === 0 || decision.moves.length > MAX_MOVES) {
      throw new BadRequestError(`Realignment ${decision.id}: invalid number of moves`);
    }
    const ids = new Set<string>();
    const froms = new Set<string>();
    const tos = new Set<string>();
    const check = (ref: string, what: string) => {
      const parsed = parseSheetRef(ref);
      if (!parsed || parsed.future !== null || parsed.monthKey !== monthKey || parsed.section !== decision.section) {
        throw new BadRequestError(`Realignment ${decision.id}: ${what} ${ref} is not a ${decision.section} row of ${monthKey}`);
      }
      return parsed.line;
    };
    for (const move of decision.moves) {
      const fromLine = check(move.from, 'reference');
      const toLine = check(move.to, 'reference');
      if (toLine !== fromLine + decision.shift) throw new BadRequestError(`Realignment ${decision.id}: ${move.from} -> ${move.to} is not a shift of ${decision.shift}`);
      if (ids.has(move.transactionId) || froms.has(move.from) || tos.has(move.to)) throw new BadRequestError(`Realignment ${decision.id}: repeated move`);
      ids.add(move.transactionId);
      froms.add(move.from);
      tos.add(move.to);
    }
    for (const removed of decision.removed ?? []) {
      check(removed.from, 'reference');
      check(removed.to, 'reference');
      if (ids.has(removed.transactionId) || froms.has(removed.from) || tos.has(removed.to)) throw new BadRequestError(`Realignment ${decision.id}: repeated move`);
      ids.add(removed.transactionId);
      froms.add(removed.from);
      tos.add(removed.to);
    }
  }
}

interface Plan {
  decision: MaxFinRealignDecision;
  /** Main rows and removed rows. */
  moves: Array<{ id: string; from: string; to: string }>;
  followers: Array<{ id: string; from: string; to: string }>;
  lineRefs: Array<{ id: string; from: string; to: string }>;
}

const lineOf = (ref: string): number => parseSheetRef(ref)!.line;

/** One decision against the stored data (rows locked and read again). Returns the plan, or why it cannot be applied. */
function planDecision(
  decision: MaxFinRealignDecision,
  ctx: MonthContext,
  monthKey: string,
  accountIds: Record<MaxFinSectionKey, string>,
): { kind: 'pending'; plan: Plan } | { kind: 'done' } | { kind: 'refused'; reason: string } {
  const byId = new Map(ctx.stored.map((s) => [s.id, s]));
  const all = [...decision.moves, ...(decision.removed ?? [])];
  let pending = 0;
  let done = 0;
  for (const move of all) {
    const stored = byId.get(move.transactionId);
    if (!stored) return { kind: 'refused', reason: 'um dos lançamentos não existe mais ou saiu deste mês' };
    if (stored.ref === move.from) pending += 1;
    else if (stored.ref === move.to) done += 1;
    else return { kind: 'refused', reason: 'a referência de um lançamento mudou desde a prévia; gere a prévia de novo' };
  }
  if (pending === 0) return { kind: 'done' };
  if (done > 0) return { kind: 'refused', reason: 'o bloco já está parcialmente realinhado; gere a prévia de novo' };

  // The identity of every verified row, compared again with what is stored now.
  const rows = [...decision.moves].sort((a, b) => a.sheetLine - b.sheetLine);
  let verified = 0;
  for (const move of rows) {
    if (!move.verified) continue;
    const stored = byId.get(move.transactionId)!;
    if (!move.sheet) return { kind: 'refused', reason: 'faltam os dados da linha da planilha para conferir o lançamento' };
    const sheetRow: RealignSheetRow = {
      ref: move.to,
      section: decision.section,
      line: lineOf(move.to),
      description: move.sheet.description,
      type: move.sheet.type,
      amount: move.sheet.amount,
      installment: move.sheet.installment,
      accountId: accountIds[decision.section],
    };
    if (compareIdentity(sheetRow, stored) !== 'match') {
      return { kind: 'refused', reason: `o lançamento "${stored.description ?? ''}" já não corresponde à linha da planilha` };
    }
    verified += 1;
  }
  if (verified < MIN_VERIFIED_ROWS || !rows[0]!.verified || !rows[rows.length - 1]!.verified) {
    return { kind: 'refused', reason: 'poucas linhas conferidas para provar o deslocamento' };
  }

  const moves = all.map((m) => ({ id: m.transactionId, from: m.from, to: m.to }));
  const followers: Plan['followers'] = [];
  for (const move of all) {
    const fromLine = lineOf(move.from);
    const toLine = lineOf(move.to);
    for (const s of ctx.stored) {
      if (s.future !== null && s.section === decision.section && s.line === fromLine) {
        followers.push({ id: s.id, from: s.ref, to: buildSheetRef(monthKey, decision.section, toLine, s.future) });
      }
    }
  }
  // The lines of absorbed rows (external references) lie in the span of the moved rows and move with them.
  const sources = decision.moves.map((m) => lineOf(m.from));
  const low = Math.min(...sources);
  const high = Math.max(...sources);
  const lineRefs = ctx.lineRefs
    .filter((r) => r.section === decision.section && r.line >= low && r.line <= high)
    .map((r) => {
      const prefix = r.ref.startsWith('deleted:') ? 'deleted:' : '';
      return { id: r.id, from: r.ref, to: `${prefix}${buildSheetRef(monthKey, decision.section, r.line + decision.shift)}` };
    });
  return { kind: 'pending', plan: { decision, moves, followers, lineRefs } };
}

export async function applyRealignments(params: ApplyRealignParams): Promise<ApplyRealignResult> {
  const { householdId, monthKey, accountIds } = params;
  const decisions = params.decisions ?? [];
  const result: ApplyRealignResult = { outcomes: [], realigned: 0, warnings: [], guardedRefs: new Set(), pendingRefs: new Set() };
  if (decisions.length === 0) return result;
  validateDecisions(decisions, monthKey);

  const outcomes = new Map<string, MaxFinRealignOutcome>();
  const guardPending = (decision: MaxFinRealignDecision) => {
    for (const m of [...decision.moves, ...(decision.removed ?? [])]) {
      result.pendingRefs.add(m.from);
      result.pendingRefs.add(m.to);
    }
  };
  const guardMoved = (decision: MaxFinRealignDecision) => {
    for (const m of decision.moves) result.guardedRefs.add(m.to);
  };
  const skip = (decision: MaxFinRealignDecision, reason: string) => {
    outcomes.set(decision.id, { id: decision.id, status: 'skipped', moved: 0, reason });
    guardPending(decision);
    result.warnings.push(`Realinhamento ${decision.id} não foi aplicado: ${reason}. As linhas dele ficaram pendentes.`);
  };

  for (const decision of decisions) {
    if (!decision.apply) {
      outcomes.set(decision.id, { id: decision.id, status: 'declined', moved: 0, reason: 'bloco deixado pendente por escolha: nada nele foi alterado' });
      guardPending(decision);
      result.warnings.push(
        `As linhas deslocadas de ${MAXFIN_SECTION_LABELS[decision.section] ?? decision.section} (${decision.moves.length} lançamento(s), ${decision.id}) ficaram pendentes: não foram realinhadas nem substituídas.`,
      );
    }
  }
  const accepted = decisions.filter((d) => d.apply);

  if (accepted.length > 0) {
    try {
      await prisma.$transaction(
        async (tx: Db) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`maxfin-realign:${householdId}:${monthKey}`}))`;

          // Lock the rows to move (and their generated installments) in id order, then read them again.
          const first = await loadMonthContext(tx, householdId, monthKey);
          const wanted = new Set(accepted.flatMap((d) => [...d.moves, ...(d.removed ?? [])].map((m) => m.transactionId)));
          const lines = new Set(accepted.flatMap((d) => [...d.moves, ...(d.removed ?? [])].map((m) => `${d.section}:${lineOf(m.from)}`)));
          for (const s of first.stored) if (s.future !== null && lines.has(`${s.section}:${s.line}`)) wanted.add(s.id);
          const lockIds = [...wanted].sort();
          if (lockIds.length > 0) {
            await tx.$queryRaw`SELECT id FROM transactions WHERE id IN (${Prisma.join(lockIds)}) ORDER BY id FOR UPDATE`;
          }
          const ctx = await loadMonthContext(tx, householdId, monthKey);

          // Plan every accepted decision; drop what cannot be applied, to a fixpoint (dependencies, collisions).
          let plans = new Map<string, Plan>();
          const doneIds = new Set<string>();
          for (const decision of accepted) {
            const planned = planDecision(decision, ctx, monthKey, accountIds);
            if (planned.kind === 'refused') skip(decision, planned.reason);
            else if (planned.kind === 'done') {
              doneIds.add(decision.id);
              outcomes.set(decision.id, { id: decision.id, status: 'already-applied', moved: 0, reason: null });
              guardMoved(decision);
            } else plans.set(decision.id, planned.plan);
          }
          const storedByRef = new Map(ctx.stored.map((s) => [s.ref, s]));
          const lineRefByRef = new Map(ctx.lineRefs.map((r) => [r.ref, r]));
          for (let changed = true; changed; ) {
            changed = false;
            const movingFrom = new Set<string>();
            for (const plan of plans.values()) for (const m of [...plan.moves, ...plan.followers, ...plan.lineRefs]) movingFrom.add(m.from);
            const landing = new Set<string>();
            for (const plan of plans.values()) {
              let reason: string | null = null;
              for (const dep of plan.decision.requires ?? []) {
                if (!plans.has(dep) && !doneIds.has(dep)) reason = `depende do bloco ${dep}, que não foi aplicado`;
              }
              for (const m of [...plan.moves, ...plan.followers, ...plan.lineRefs]) {
                if (landing.has(m.to)) reason = 'duas linhas cairiam na mesma referência';
                landing.add(m.to);
                const occupied = storedByRef.has(m.to) || lineRefByRef.has(m.to);
                if (occupied && !movingFrom.has(m.to)) reason = `a referência ${m.to} já está em uso por outro lançamento`;
              }
              if (reason) {
                skip(plan.decision, reason);
                plans.delete(plan.decision.id);
                changed = true;
                break;
              }
            }
          }
          plans = new Map(plans);

          // Two phases: everything to a temporary reference, then to the final one.
          const all: Array<{ table: 'tx' | 'ref'; id: string; to: string }> = [];
          for (const plan of plans.values()) {
            for (const m of [...plan.moves, ...plan.followers]) all.push({ table: 'tx', id: m.id, to: m.to });
            for (const m of plan.lineRefs) all.push({ table: 'ref', id: m.id, to: m.to });
          }
          const write = (item: (typeof all)[number], ref: string) =>
            item.table === 'tx'
              ? tx.transaction.update({ where: { id: item.id }, data: { sourceRef: ref } })
              : tx.transactionExternalRef.update({ where: { id: item.id }, data: { ref } });
          for (const item of all) await write(item, temporaryRef(item.to));
          for (const item of all) await write(item, item.to);

          for (const plan of plans.values()) {
            const moved = plan.moves.length + plan.followers.length;
            outcomes.set(plan.decision.id, { id: plan.decision.id, status: 'applied', moved, reason: null });
            result.realigned += moved;
            guardMoved(plan.decision);
          }
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Another confirm wrote one of the lines meanwhile: the database undid every move of this one.
      result.realigned = 0;
      for (const decision of accepted) skip(decision, 'outra importação gravou uma das linhas durante a confirmação');
    }
  }

  result.outcomes = decisions.map((d) => outcomes.get(d.id)!);
  return result;
}
