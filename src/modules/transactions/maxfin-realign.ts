/**
 * Shifted rows of a monthly sheet (pure functions, no database).
 *
 * The `sourceRef` of an imported row is its line in the tab (`maxfin:<AAAA-MM>:<block>:<line>`). Inserting a row in the
 * middle of the tab moves every row below it by one line, and removing one moves them the other way: the preview then
 * compares each sheet row with the stored row of the same line, which is its neighbour. Here the shift is detected: a
 * run of consecutive sheet rows that are, by identity, the stored rows `d` lines above (d > 0, rows were inserted) or
 * below (d < 0, rows were removed) is explained by a constant shift and becomes one realignment proposal, instead of a
 * cascade of "changed" rows that would overwrite purchases with their neighbours.
 */
import { normalizeLabel } from './maxfin-import.helpers.js';
import type { MaxFinSectionKey } from './parsers/maxfin.types.js';

/** Largest shift (in lines) looked for. Real edits move a handful of lines. */
export const MAX_REALIGN_SHIFT = 60;
/** Rows whose identity must match for a run to count as a shift (the inserted or removed row itself is not one). */
export const MIN_VERIFIED_ROWS = 2;

export interface RealignInstallment {
  number: number;
  total: number;
}

/** What the sheet says about a row (the fields the importer reads from it). */
export interface RealignSheetRow {
  ref: string;
  section: MaxFinSectionKey;
  line: number;
  description: string;
  type: 'INCOME' | 'EXPENSE';
  amount: number;
  installment: RealignInstallment | null;
  accountId: string;
}

/** A stored transaction whose `sourceRef` belongs to the month (a sheet row or a generated future installment). */
export interface RealignStored {
  id: string;
  ref: string;
  section: MaxFinSectionKey;
  line: number;
  /** N of `<rowRef>:f<N>` (a generated future installment follows its row), null for a sheet row. */
  future: number | null;
  accountId: string | null;
  type: 'INCOME' | 'EXPENSE';
  amount: number;
  description: string | null;
  notes: string | null;
  installment: RealignInstallment | null;
  /** Reconciled with a card statement (carries an `ofx:` external reference). */
  linked: boolean;
  /** Absorbed other sheet rows (carries `maxfin:` external references): its description and amount are the bank's. */
  mergeTarget: boolean;
}

export type IdentityMatch = 'match' | 'neutral' | 'mismatch';

const REF_PATTERN = /^maxfin:(\d{4}-\d{2}):(income|bills|credit|debit):(\d+)(?::f(\d+))?$/;

export function parseSheetRef(ref: string): { monthKey: string; section: MaxFinSectionKey; line: number; future: number | null } | null {
  const match = REF_PATTERN.exec(ref);
  if (!match) return null;
  return {
    monthKey: match[1]!,
    section: match[2] as MaxFinSectionKey,
    line: Number(match[3]),
    future: match[4] === undefined ? null : Number(match[4]),
  };
}

export function buildSheetRef(monthKey: string, section: MaxFinSectionKey, line: number, future: number | null = null): string {
  return `maxfin:${monthKey}:${section}:${line}${future === null ? '' : `:f${future}`}`;
}

const cents = (value: number): number => Math.round(value * 100);

/** "Planilha: <description>" and "Planilha: <description> <amount>" notes the card statement import appends. */
export function planilhaNotes(notes: string | null): Array<{ description: string; amount: number | null }> {
  if (!notes) return [];
  const found: Array<{ description: string; amount: number | null }> = [];
  for (const part of notes.split(' · ')) {
    const text = part.trim();
    if (!text.startsWith('Planilha: ')) continue;
    const body = text.slice('Planilha: '.length).trim();
    if (!body) continue;
    found.push({ description: body, amount: null });
    const withAmount = /^(.*\S)\s+(\d{1,3}(?:\.\d{3})*,\d{2})$/.exec(body);
    if (withAmount) found.push({ description: withAmount[1]!, amount: Number(withAmount[2]!.replace(/\./g, '').replace(',', '.')) });
  }
  return found;
}

/** "Planilha (soma de N linhas): <desc> <amount>; <desc> <amount>": the first part, the sheet row that stayed. */
export function mergeNoteFirstPart(notes: string | null): { description: string; amount: number } | null {
  if (!notes) return null;
  const note = /Planilha \(soma de \d+ linhas\): (.*)$/.exec(notes.split(' · ').find((part) => part.startsWith('Planilha (soma de')) ?? '');
  if (!note) return null;
  const first = note[1]!.split('; ')[0]!.trim();
  const parts = /^(.*\S)\s+(\d{1,3}(?:\.\d{3})*,\d{2})$/.exec(first);
  return parts ? { description: parts[1]!, amount: Number(parts[2]!.replace(/\./g, '').replace(',', '.')) } : null;
}

/**
 * Is the stored row the one the sheet row describes? Exact on what the sheet carries: description (normalised), type,
 * amount and installment (the date is the first of the month for every sheet row, so it says nothing). A row the card
 * statement import reconciled has the bank's description and, sometimes, amount: its sheet description survives in the
 * "Planilha: ..." note (with the sheet amount when the amounts differed) and that is what is compared instead.
 * 'neutral' = cannot be compared safely (it absorbed other rows, or reconciled with no note to read): never proof of
 * a shift on its own, it may only travel with a run its neighbours already prove.
 */
export function compareIdentity(sheet: RealignSheetRow, stored: RealignStored): IdentityMatch {
  if (stored.accountId !== sheet.accountId || stored.type !== sheet.type) return 'mismatch';
  const key = normalizeLabel(sheet.description);
  if (stored.mergeTarget) {
    // The row that stays after a merge keeps the first absorbed row's description and amount in its note.
    const first = mergeNoteFirstPart(stored.notes);
    return first && normalizeLabel(first.description) === key && cents(first.amount) === cents(sheet.amount) ? 'match' : 'neutral';
  }
  const sameInstallment =
    (stored.installment === null && sheet.installment === null) ||
    (stored.installment !== null &&
      sheet.installment !== null &&
      stored.installment.number === sheet.installment.number &&
      stored.installment.total === sheet.installment.total);
  const direct = normalizeLabel(stored.description ?? '') === key && cents(stored.amount) === cents(sheet.amount);
  if (!stored.linked) return direct && sameInstallment ? 'match' : 'mismatch';
  if (direct) return 'match';
  const notes = planilhaNotes(stored.notes);
  if (notes.length === 0) return 'neutral';
  for (const note of notes) {
    if (normalizeLabel(note.description) !== key) continue;
    // Without an amount in the note the bank amount was the sheet amount (exact match).
    if (note.amount === null ? cents(stored.amount) === cents(sheet.amount) : cents(note.amount) === cents(sheet.amount)) return 'match';
  }
  return 'mismatch';
}

/** Identity of a sheet row for "are these two rows alike?" (ambiguity), not for matching against stored rows. */
function sheetKey(row: RealignSheetRow): string {
  const inst = row.installment ? `${row.installment.number}/${row.installment.total}` : '-';
  return `${normalizeLabel(row.description)}|${row.type}|${cents(row.amount)}|${inst}`;
}

export interface RealignMove {
  transactionId: string;
  from: string;
  to: string;
}

export interface RealignRowMove extends RealignMove {
  sheetLine: number;
  /** Identity was compared; false = travels with its neighbours (see compareIdentity). */
  verified: boolean;
  sheet: { description: string; type: 'INCOME' | 'EXPENSE'; amount: number; installment: RealignInstallment | null } | null;
  storedDescription: string | null;
  storedAmount: number;
}

export interface RealignBlock {
  id: string;
  section: MaxFinSectionKey;
  /** Lines the rows moved: > 0 rows were inserted above them, < 0 rows were removed above them. */
  shift: number;
  kind: 'insertion' | 'removal';
  /** First and last sheet line of the block's rows. */
  firstLine: number;
  lastLine: number;
  rows: RealignRowMove[];
  /** Generated future installments of the moved rows, which carry the row's line in their own reference. */
  followers: RealignMove[];
  /** Removed rows (shift < 0): their stored transaction stays, and takes a line the block vacates. */
  removed: Array<RealignMove & { description: string | null; amount: number }>;
  /** Sheet refs of the rows that are new because of the insertion (their line is free once the block moves). */
  insertedRefs: string[];
  /** Ids of blocks that must be applied together (this block lands on lines those blocks vacate). */
  requires: string[];
  ambiguous: boolean;
  reason: string | null;
}

export interface RealignInput {
  monthKey: string;
  sheetRows: RealignSheetRow[];
  stored: RealignStored[];
  /** Lines that carry an external reference of a sheet row (`maxfin:` or `deleted:maxfin:`): absorbed rows. */
  tombstones: Array<{ section: MaxFinSectionKey; line: number }>;
}

interface Candidate {
  d: number;
  start: number;
  end: number;
  verified: number;
}

interface SectionContext {
  rows: RealignSheetRow[];
  main: Map<number, RealignStored>;
  futures: Map<number, RealignStored[]>;
  tombs: Set<number>;
}

function statusAt(ctx: SectionContext, index: number, d: number): IdentityMatch | 'none' {
  const row = ctx.rows[index]!;
  const source = row.line - d;
  const stored = ctx.main.get(source);
  if (stored) return compareIdentity(row, stored);
  return ctx.tombs.has(source) ? 'neutral' : 'none';
}

function inPlace(ctx: SectionContext, index: number): boolean {
  const row = ctx.rows[index]!;
  const own = ctx.main.get(row.line);
  return !!own && compareIdentity(row, own) === 'match';
}

/** Runs of consecutive unclaimed rows explained by shift `d`, trimmed to start and end on a verified row. */
function runsFor(ctx: SectionContext, d: number, claimed: Set<number>): Candidate[] {
  const out: Candidate[] = [];
  let i = 0;
  const n = ctx.rows.length;
  while (i < n) {
    if (claimed.has(i) || statusAt(ctx, i, d) === 'none' || statusAt(ctx, i, d) === 'mismatch') {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < n && !claimed.has(j + 1) && ['match', 'neutral'].includes(statusAt(ctx, j + 1, d))) j += 1;
    let start = i;
    let end = j;
    while (start <= end && statusAt(ctx, start, d) !== 'match') start += 1;
    while (end >= start && statusAt(ctx, end, d) !== 'match') end -= 1;
    if (start <= end) {
      // Evidence is a row the stored row of its own line does not already explain: a sheet that did not change at all
      // (three equal purchases in a row) must never look like a shift.
      let verified = 0;
      for (let k = start; k <= end; k += 1) if (statusAt(ctx, k, d) === 'match' && !inPlace(ctx, k)) verified += 1;
      if (verified >= MIN_VERIFIED_ROWS && spanIsClean(ctx, d, start, end)) out.push({ d, start, end, verified });
    }
    i = j + 1;
  }
  return out;
}

/** No stored row sits, between the block's source lines, outside the rows the block accounts for. */
function spanIsClean(ctx: SectionContext, d: number, start: number, end: number): boolean {
  const first = ctx.rows[start]!.line - d;
  const last = ctx.rows[end]!.line - d;
  const owned = new Set<number>();
  for (let k = start; k <= end; k += 1) owned.add(ctx.rows[k]!.line - d);
  for (const line of ctx.main.keys()) {
    if (line >= first && line <= last && !owned.has(line)) return false;
  }
  return true;
}

function sectionContexts(input: RealignInput): Map<MaxFinSectionKey, SectionContext> {
  const out = new Map<MaxFinSectionKey, SectionContext>();
  const ctxOf = (section: MaxFinSectionKey): SectionContext => {
    let ctx = out.get(section);
    if (!ctx) {
      ctx = { rows: [], main: new Map(), futures: new Map(), tombs: new Set() };
      out.set(section, ctx);
    }
    return ctx;
  };
  for (const row of input.sheetRows) ctxOf(row.section).rows.push(row);
  for (const stored of input.stored) {
    const ctx = ctxOf(stored.section);
    if (stored.future === null) ctx.main.set(stored.line, stored);
    else ctx.futures.set(stored.line, [...(ctx.futures.get(stored.line) ?? []), stored]);
  }
  for (const tomb of input.tombstones) ctxOf(tomb.section).tombs.add(tomb.line);
  for (const ctx of out.values()) ctx.rows.sort((a, b) => a.line - b.line);
  return out;
}

interface DraftBlock {
  section: MaxFinSectionKey;
  ctx: SectionContext;
  d: number;
  start: number;
  end: number;
  rows: RealignRowMove[];
  followers: RealignMove[];
  removed: RealignBlock['removed'];
  insertedRefs: string[];
  ambiguous: boolean;
  reason: string | null;
}

function draftBlock(monthKey: string, section: MaxFinSectionKey, ctx: SectionContext, c: Candidate, claimedOutside: Set<number>): DraftBlock {
  const { d } = c;
  const rows: RealignRowMove[] = [];
  const followers: RealignMove[] = [];
  const move = (stored: RealignStored, toLine: number): RealignMove => ({
    transactionId: stored.id,
    from: stored.ref,
    to: buildSheetRef(monthKey, section, toLine, stored.future),
  });
  for (let k = c.start; k <= c.end; k += 1) {
    const sheet = ctx.rows[k]!;
    const source = sheet.line - d;
    const stored = ctx.main.get(source);
    if (stored) {
      const verified = compareIdentity(sheet, stored) === 'match';
      rows.push({
        ...move(stored, sheet.line),
        sheetLine: sheet.line,
        verified,
        sheet: verified ? { description: sheet.description, type: sheet.type, amount: sheet.amount, installment: sheet.installment } : null,
        storedDescription: stored.description,
        storedAmount: stored.amount,
      });
      for (const future of ctx.futures.get(source) ?? []) followers.push(move(future, sheet.line));
    }
  }

  // Ambiguity: rows alike next to each other (the inserted row repeats its neighbour, two equal purchases in a row), or
  // a row that is also, by identity, the stored row of its own line: either explanation fits.
  let ambiguous = false;
  let reason: string | null = null;
  for (let k = Math.max(c.start - 1, 0); k < Math.min(c.end + 1, ctx.rows.length - 1); k += 1) {
    if (sheetKey(ctx.rows[k]!) === sheetKey(ctx.rows[k + 1]!)) {
      ambiguous = true;
      reason = 'há linhas iguais lado a lado (mesma descrição e valor): não dá para saber qual delas é a inserida ou a removida';
      break;
    }
  }
  if (!ambiguous) {
    for (let k = c.start; k <= c.end; k += 1) {
      const own = ctx.main.get(ctx.rows[k]!.line);
      if (own && compareIdentity(ctx.rows[k]!, own) === 'match') {
        ambiguous = true;
        reason = `a linha ${ctx.rows[k]!.line} também bate com o lançamento que já está nela: o deslocamento é uma entre duas explicações`;
        break;
      }
    }
  }

  const insertedRefs: string[] = [];
  const removed: RealignBlock['removed'] = [];
  const firstLine = ctx.rows[c.start]!.line;
  if (d > 0) {
    for (let k = 0; k < ctx.rows.length; k += 1) {
      const row = ctx.rows[k]!;
      if (k >= c.start && k <= c.end) continue;
      if (claimedOutside.has(k)) continue;
      const here = ctx.main.get(row.line);
      if (row.line >= firstLine - d && row.line < firstLine && here && rows.some((m) => m.from === here.ref)) insertedRefs.push(row.ref);
    }
  }
  return { section, ctx, d, start: c.start, end: c.end, rows, followers, removed, insertedRefs, ambiguous, reason };
}

/**
 * Detect the shifted blocks of a month. Blocks never share rows; a block is dropped when its rows would land on a
 * stored row that no block moves (the realignment would collide), or when a stored row it moves has two claimants.
 */
export function detectRealignments(input: RealignInput, options: { landing?: boolean } = {}): RealignBlock[] {
  const contexts = sectionContexts(input);
  const result: RealignBlock[] = [];
  for (const [section, ctx] of contexts) {
    if (ctx.rows.length < MIN_VERIFIED_ROWS || ctx.main.size === 0) continue;
    // Candidate shifts: those at which some sheet row matches a stored row.
    const shifts = new Set<number>();
    for (let i = 0; i < ctx.rows.length; i += 1) {
      for (const [line, stored] of ctx.main) {
        const d = ctx.rows[i]!.line - line;
        if (d !== 0 && Math.abs(d) <= MAX_REALIGN_SHIFT && compareIdentity(ctx.rows[i]!, stored) === 'match') shifts.add(d);
      }
    }
    if (shifts.size === 0) continue;

    const claimed = new Set<number>();
    const picked: Candidate[] = [];
    for (;;) {
      let best: Candidate | null = null;
      for (const d of shifts) {
        for (const c of runsFor(ctx, d, claimed)) {
          if (
            !best ||
            c.verified > best.verified ||
            (c.verified === best.verified && (Math.abs(c.d) < Math.abs(best.d) || (Math.abs(c.d) === Math.abs(best.d) && c.start < best.start)))
          ) {
            best = c;
          }
        }
      }
      if (!best) break;
      for (let k = best.start; k <= best.end; k += 1) claimed.add(k);
      picked.push(best);
    }

    // A stored row can be moved by one block only.
    let drafts = picked
      .sort((a, b) => a.start - b.start)
      .map((c) => draftBlock(input.monthKey, section, ctx, c, claimed));
    const usedSource = new Set<string>();
    drafts = drafts.filter((draft) => {
      const sources = [...draft.rows, ...draft.followers].map((m) => m.from);
      if (sources.some((s) => usedSource.has(s))) return false;
      for (const s of sources) usedSource.add(s);
      return true;
    });

    // Removed rows: what sits on the lines a removal block moves up into, is claimed by no block and is not in the sheet.
    for (const draft of drafts) {
      if (draft.d >= 0) continue;
      const moving = new Set(drafts.flatMap((x) => x.rows.map((r) => r.from)));
      const firstLine = ctx.rows[draft.start]!.line;
      const firstSource = firstLine - draft.d;
      const orphans = [...ctx.main.values()]
        .filter((s) => s.line >= firstLine && s.line < firstSource && !moving.has(s.ref))
        .sort((a, b) => a.line - b.line);
      const targets = new Set(draft.rows.map((r) => r.sheetLine));
      const vacated = draft.rows.map((r) => parseSheetRef(r.from)!.line).filter((line) => !targets.has(line)).sort((a, b) => a - b);
      if (orphans.length > vacated.length) {
        draft.rows = [];
        continue;
      }
      orphans.forEach((orphan, idx) => {
        const toLine = vacated[idx]!;
        draft.removed.push({
          transactionId: orphan.id,
          from: orphan.ref,
          to: buildSheetRef(input.monthKey, section, toLine),
          description: orphan.description,
          amount: orphan.amount,
        });
        for (const future of ctx.futures.get(orphan.line) ?? []) {
          draft.followers.push({ transactionId: future.id, from: future.ref, to: buildSheetRef(input.monthKey, section, toLine, future.future) });
        }
      });
    }
    drafts = drafts.filter((draft) => draft.rows.length > 0);

    // Landing check: every target is free, vacated by a block of the set, or the draft is dropped (to a fixpoint).
    const refsOfSection = new Map<string, RealignStored>();
    for (const stored of input.stored) if (stored.section === section) refsOfSection.set(stored.ref, stored);
    const movesOf = (draft: DraftBlock): RealignMove[] => [...draft.rows, ...draft.removed, ...draft.followers];
    // (Without the check, for guarding a confirm that only carries part of the sheet: the rows past the part sent are
    // unknown, so the blocks cannot be proven to land, but the shift they show is still evidence.)
    let changed = options.landing !== false;
    while (changed) {
      changed = false;
      const movingFrom = new Map<string, DraftBlock>();
      for (const draft of drafts) for (const m of movesOf(draft)) movingFrom.set(m.from, draft);
      const landing = new Map<string, DraftBlock>();
      for (const draft of drafts) {
        let ok = true;
        const needs = new Set<DraftBlock>();
        for (const m of movesOf(draft)) {
          if (landing.has(m.to) && landing.get(m.to) !== draft) ok = false;
          landing.set(m.to, draft);
          if (refsOfSection.has(m.to) && m.to !== m.from) {
            const owner = movingFrom.get(m.to);
            if (!owner) ok = false;
            else if (owner !== draft) needs.add(owner);
          }
        }
        if (!ok) {
          drafts = drafts.filter((x) => x !== draft);
          changed = true;
          break;
        }
        (draft as DraftBlock & { needs?: Set<DraftBlock> }).needs = needs;
      }
    }

    for (const draft of drafts) {
      const firstLine = ctx.rows[draft.start]!.line;
      const lastLine = ctx.rows[draft.end]!.line;
      const id = `${section}:${firstLine}:${draft.d}`;
      const needs = (draft as DraftBlock & { needs?: Set<DraftBlock> }).needs ?? new Set<DraftBlock>();
      result.push({
        id,
        section,
        shift: draft.d,
        kind: draft.d > 0 ? 'insertion' : 'removal',
        firstLine,
        lastLine,
        rows: draft.rows,
        followers: draft.followers,
        removed: draft.removed,
        insertedRefs: draft.insertedRefs,
        requires: [...needs].map((n) => `${section}:${ctx.rows[n.start]!.line}:${n.d}`),
        ambiguous: draft.ambiguous,
        reason: draft.reason,
      });
    }
  }
  return result.sort((a, b) => a.section.localeCompare(b.section) || a.firstLine - b.firstLine);
}

/**
 * Order-independent two-phase plan for a set of moves: every row first goes to a temporary reference, then to its final
 * one, so a chain (N -> N+1, N+1 -> N+2, ...) or a cycle never meets a unique constraint halfway.
 */
export function temporaryRef(finalRef: string): string {
  return `${finalRef}:mv`;
}
