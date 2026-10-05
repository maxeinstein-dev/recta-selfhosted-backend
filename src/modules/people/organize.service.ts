import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError, ConflictError } from '../../shared/errors/app-error.js';
import { parseLocalDateString, storedDateString } from '../transactions/maxfin-import.helpers.js';
import type { ShareHint } from '../transactions/parsers/maxfin.types.js';
import {
  MAX_PEOPLE_PER_HOUSEHOLD,
  assertKeyUsable,
  buildKeyRows,
  capWarnings,
  chunks,
  cleanPersonName,
  decimalFromCents,
  labelKey,
  type Db,
} from './people.common.js';
import { buildFreeTextMatcher, classifyNote, reimbursementName, type NoteClass } from './organize.notes.js';
import type { OrganizeApplyInput, OrganizeOptions } from './organize.schema.js';
import { findPersonOrThrow } from './people.service.js';
import type {
  OrganizeApplyResult,
  OrganizePreview,
  ReviewLine,
  SettlementProposal,
  ShareDirection,
  ShareProposal,
} from './people.types.js';
import { fromCents, storedToCents, toCents } from './money.js';
import { computeSplit } from './split-strategies.js';

/**
 * "Organize splits": turns the notes the sheet import kept on transactions into shares, and the incomes named
 * after a person into settlements. `computeOrganize` reads everything from the database and is the single source
 * of truth: the preview shows it and `apply` recomputes it (never trusting ids, amounts or people sent by the
 * client for proposals), so applying twice creates nothing the second time.
 */

/** Transactions read per run: a safety cap far above a household's year of data. */
export const MAX_ORGANIZE_TRANSACTIONS = 20_000;
/** sourceRef prefix of the MaxFin sheet importer (`onlyImported`). */
const IMPORTER_REF_PREFIX = 'maxfin:';
const SETTLEMENT_ID_PREFIX = 'settlement:';

interface TxFacts {
  id: string;
  type: 'INCOME' | 'EXPENSE';
  description: string;
  date: string;
  amountCents: number;
  notes: string | null;
}

interface InternalShare extends ShareProposal {
  amountCents: number;
}

interface InternalSettlement extends SettlementProposal {
  amountCents: number;
}

interface Computation {
  preview: OrganizePreview;
  shares: InternalShare[];
  settlements: InternalSettlement[];
}

function shareProposalId(transactionId: string, personName: string, direction: ShareDirection): string {
  return `${transactionId}:${labelKey(personName)}:${direction}`;
}

/** The share a standard note asks for: who owes whom, how much, and the percent of the transaction it stands for. */
function shareFor(
  hint: Exclude<ShareHint, { kind: 'reimbursable' }>,
  totalCents: number,
): { direction: ShareDirection; amountCents: number; percent: number } {
  switch (hint.kind) {
    case 'split': {
      // Half and half; an odd cent goes to the other person, as in the equal split.
      const split = computeSplit({ totalCents, strategy: 'equal', entries: [{ personId: 'other' }] });
      return { direction: 'THEY_OWE_ME', amountCents: split.parts[0]!.amountCents, percent: 50 };
    }
    case 'owed_to_me':
      return { direction: 'THEY_OWE_ME', amountCents: totalCents, percent: 100 };
    case 'owed_by_me':
      return { direction: 'I_OWE_THEM', amountCents: totalCents, percent: 100 };
  }
}

function dayRange(options: OrganizeOptions): { gte?: Date; lte?: Date } | undefined {
  if (options.startDate && options.endDate && options.startDate > options.endDate) {
    throw new BadRequestError('startDate must not be after endDate');
  }
  if (!options.startDate && !options.endDate) return undefined;
  return {
    ...(options.startDate ? { gte: parseLocalDateString(options.startDate) } : {}),
    ...(options.endDate ? { lte: parseLocalDateString(options.endDate) } : {}),
  };
}

async function loadTransactions(db: Db, options: OrganizeOptions, warnings: string[]): Promise<TxFacts[]> {
  const range = dayRange(options);
  const rows = await db.transaction.findMany({
    where: {
      householdId: options.householdId,
      type: { in: ['INCOME', 'EXPENSE'] },
      OR: [{ notes: { not: null } }, { type: 'INCOME' }],
      ...(options.onlyImported ? { sourceRef: { startsWith: IMPORTER_REF_PREFIX } } : {}),
      ...(range ? { date: range } : {}),
    },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_ORGANIZE_TRANSACTIONS + 1,
    select: { id: true, type: true, description: true, date: true, amount: true, notes: true },
  });
  if (rows.length > MAX_ORGANIZE_TRANSACTIONS) {
    warnings.push(`Mais de ${MAX_ORGANIZE_TRANSACTIONS} transações no filtro: só as primeiras foram lidas; use um período menor.`);
  }
  return rows
    .slice(0, MAX_ORGANIZE_TRANSACTIONS)
    .map((row) => ({
      id: row.id,
      type: row.type as 'INCOME' | 'EXPENSE',
      description: row.description ?? '',
      date: storedDateString(row.date),
      amountCents: storedToCents(row.amount),
      notes: row.notes,
    }))
    .filter((tx) => tx.amountCents >= 1); // an amount that is not positive cannot be split or settled
}

export async function computeOrganize(db: Db, options: OrganizeOptions): Promise<Computation> {
  const { householdId } = options;
  const warnings: string[] = [];
  const transactions = await loadTransactions(db, options, warnings);

  const [people, aliasRows, existingShares, linkedSettlements] = await Promise.all([
    db.person.findMany({ where: { householdId }, select: { id: true, name: true, isActive: true } }),
    db.personAlias.findMany({ where: { householdId }, select: { personId: true, key: true } }),
    db.transactionShare.findMany({
      where: { householdId },
      select: { transactionId: true, personId: true, direction: true, amount: true },
    }),
    db.settlement.findMany({ where: { householdId, transactionId: { not: null } }, select: { transactionId: true } }),
  ]);

  const personById = new Map(people.map((p) => [p.id, p]));
  const aliasIndex = new Map(aliasRows.map((r) => [r.key, r.personId]));
  const shareKeys = new Set(existingShares.map((s) => `${s.transactionId}|${s.personId}|${s.direction}`));
  const sharedTransactions = new Set(existingShares.map((s) => s.transactionId));
  const sharedCents = new Map<string, number>();
  for (const s of existingShares) {
    const key = `${s.transactionId}|${s.direction}`;
    sharedCents.set(key, (sharedCents.get(key) ?? 0) + storedToCents(s.amount));
  }
  const linkedTransactions = new Set(linkedSettlements.map((s) => s.transactionId));

  let alreadyDone = 0;
  const proposals: InternalShare[] = [];
  const review: ReviewLine[] = [];
  const settlements: InternalSettlement[] = [];
  /** People the notes name that do not exist yet (normalized name -> name as first written). */
  const newPeople = new Map<string, string>();

  const reviewLine = (tx: TxFacts, reason: string, suggestedPersonId: string | null = null): void => {
    review.push({
      transactionId: tx.id,
      description: tx.description,
      date: tx.date,
      transactionAmount: fromCents(tx.amountCents),
      note: tx.notes ?? '',
      reason,
      suggestedPersonId,
    });
  };

  // Pass 1: standard notes on expenses become proposals.
  const classes = new Map<string, NoteClass>();
  for (const tx of transactions) {
    if (tx.notes === null) continue;
    const noteClass = classifyNote(tx.notes);
    classes.set(tx.id, noteClass);
    if (noteClass.kind !== 'hint' || tx.type !== 'EXPENSE') continue;

    const { direction, amountCents, percent } = shareFor(noteClass.hint, tx.amountCents);
    const key = labelKey(noteClass.person);
    const personId = aliasIndex.get(key) ?? null;
    const person = personId ? personById.get(personId) : undefined;

    if (personId && shareKeys.has(`${tx.id}|${personId}|${direction}`)) {
      alreadyDone += 1;
      continue;
    }
    if (person && !person.isActive) {
      warnings.push(`"${noteClass.person}" é ${person.name}, que está inativa: reative a pessoa para dividir "${tx.description}" (${tx.date}).`);
      continue;
    }
    if ((sharedCents.get(`${tx.id}|${direction}`) ?? 0) + amountCents > tx.amountCents) {
      warnings.push(`"${tx.description}" (${tx.date}) já tem partes que, somadas à da nota, passam do valor; ajuste à mão.`);
      continue;
    }
    if (!personId && !newPeople.has(key)) newPeople.set(key, noteClass.person);

    proposals.push({
      id: shareProposalId(tx.id, noteClass.person, direction),
      transactionId: tx.id,
      description: tx.description,
      date: tx.date,
      transactionAmount: fromCents(tx.amountCents),
      note: noteClass.segment,
      person: { id: personId, name: person?.name ?? noteClass.person },
      direction,
      amount: fromCents(amountCents),
      amountCents,
      percent,
      // Creating a person is a decision for the user; proposals for people already registered are safe to pre-select
      defaultSelected: personId !== null,
    });
  }

  // Pass 2: everything that needs a human look goes to review.
  // Names an income introduces ("Reembolso - Ana") are known before any note is read, whatever the order of the rows.
  for (const tx of transactions) {
    if (tx.type !== 'INCOME' || linkedTransactions.has(tx.id)) continue;
    const name = reimbursementName(tx.description);
    const key = name === null ? '' : labelKey(name);
    if (name !== null && key !== '' && !aliasIndex.has(key) && !newPeople.has(key)) newPeople.set(key, cleanPersonName(name));
  }

  const matcher = buildFreeTextMatcher([...aliasIndex.keys(), ...newPeople.keys()]);
  for (const tx of transactions) {
    const noteClass = classes.get(tx.id);
    if (!noteClass || noteClass.kind === 'none') continue;
    if (noteClass.kind === 'hint' && tx.type === 'EXPENSE') continue; // handled in pass 1

    let reason: string;
    let suggested: string | null = null;
    if (noteClass.kind === 'hint') {
      reason = 'Nota de divisão numa receita';
    } else if (noteClass.kind === 'reimbursable') {
      reason = 'Reembolsável, sem pessoa informada';
    } else if (noteClass.reason) {
      reason = noteClass.reason;
    } else {
      const reading = matcher.read(noteClass.text);
      if (reading.mentionedKeys.length === 0 && reading.sharingWord === null) continue;
      const parts: string[] = [];
      const personIds = [...new Set(reading.mentionedKeys.flatMap((k) => (aliasIndex.has(k) ? [aliasIndex.get(k)!] : [])))];
      const names = [...new Set(reading.mentionedKeys.map((k) => personById.get(aliasIndex.get(k) ?? '')?.name ?? newPeople.get(k) ?? k))];
      if (names.length > 0) parts.push(`cita ${names.join(', ')}`);
      if (reading.sharingWord !== null) parts.push(`fala em "${reading.sharingWord}"`);
      reason = `Texto livre ${parts.join(' e ')}`;
      if (personIds.length === 1 && names.length === 1) suggested = personIds[0]!;
    }

    if (sharedTransactions.has(tx.id)) {
      alreadyDone += 1; // somebody already split this transaction
      continue;
    }
    reviewLine(tx, reason, suggested);
  }

  // Pass 3: incomes named after a person are settlements. By now every name an income or a note introduces is in
  // `newPeople`, so the result does not depend on the order of the rows.
  for (const tx of transactions) {
    if (tx.type !== 'INCOME') continue;
    const name = reimbursementName(tx.description) ?? tx.description.trim();
    const key = labelKey(name);
    if (key === '') continue;
    const personId = aliasIndex.get(key) ?? null;
    if (!personId && !newPeople.has(key)) continue;

    if (linkedTransactions.has(tx.id)) {
      alreadyDone += 1;
      continue;
    }
    const cleaned = cleanPersonName(name);
    settlements.push({
      id: `${SETTLEMENT_ID_PREFIX}${tx.id}`,
      transactionId: tx.id,
      description: tx.description,
      date: tx.date,
      amount: fromCents(tx.amountCents),
      amountCents: tx.amountCents,
      person: { id: personId, name: personId ? (personById.get(personId)?.name ?? cleaned) : cleaned },
      direction: 'RECEIVED',
      defaultSelected: personId !== null,
    });
  }

  const preview: OrganizePreview = {
    proposals: proposals.map(({ amountCents: _cents, ...proposal }) => proposal),
    review,
    settlements: settlements.map(({ amountCents: _cents, ...proposal }) => proposal),
    newPeople: [...newPeople.values()].map((name) => ({ name, aliases: [] })),
    alreadyDone,
    warnings: capWarnings(warnings),
  };
  return { preview, shares: proposals, settlements };
}

/** What `POST /people/organize/preview` answers; nothing is written. */
export async function previewOrganize(options: OrganizeOptions): Promise<OrganizePreview> {
  return (await computeOrganize(prisma, options)).preview;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Adds a name and aliases to a person, 409 when one already belongs to somebody else. Keys the person already owns are
 * left alone. Updates the in-memory index with what it adds.
 */
async function addAliases(
  tx: Db,
  householdId: string,
  personId: string,
  labels: string[],
  index: Map<string, string>,
): Promise<void> {
  const rows: Array<{ householdId: string; personId: string; label: string; key: string; isName: boolean }> = [];
  for (const raw of labels) {
    const label = raw.trim();
    const key = assertKeyUsable(label, false);
    if (key === '') continue;
    const owner = index.get(key);
    if (owner === personId) continue;
    if (owner !== undefined) throw new ConflictError(`"${label}" is already used by another person`);
    index.set(key, personId);
    rows.push({ householdId, personId, label, key, isName: false });
  }
  if (rows.length > 0) await tx.personAlias.createMany({ data: rows });
}

/** Creates the people the user chose (or merges them into existing ones); returns how many were created. */
async function applyPeople(tx: Db, input: OrganizeApplyInput, index: Map<string, string>): Promise<number> {
  const { householdId } = input;
  let created = 0;
  let known: number | null = null;
  for (const entry of input.people) {
    const name = cleanPersonName(entry.name);
    // Validates the name (and every key's length) before anything is written for this entry
    const rows = buildKeyRows(name, (entry.aliases ?? []).map(cleanPersonName));
    const labels = rows.map((r) => r.label);

    if (entry.existingId) {
      await findPersonOrThrow(tx, householdId, entry.existingId);
      await addAliases(tx, householdId, entry.existingId, labels, index);
      continue;
    }
    const existing = index.get(rows[0]!.key);
    if (existing) {
      await addAliases(tx, householdId, existing, labels, index);
      continue;
    }
    known ??= await tx.person.count({ where: { householdId } });
    if (known + created >= MAX_PEOPLE_PER_HOUSEHOLD) {
      throw new BadRequestError(`A household can have at most ${MAX_PEOPLE_PER_HOUSEHOLD} people`);
    }
    const person = await tx.person.create({ data: { householdId, name: rows[0]!.label } });
    index.set(rows[0]!.key, person.id);
    await tx.personAlias.createMany({ data: [{ householdId, personId: person.id, label: rows[0]!.label, key: rows[0]!.key, isName: true }] });
    await addAliases(tx, householdId, person.id, labels.slice(1), index);
    created += 1;
  }
  return created;
}

/** Manual lines are validated like PutShares: real transaction of the household, usable person, sums within the amount. */
async function applyManual(
  tx: Db,
  input: OrganizeApplyInput,
  index: Map<string, string>,
  warnings: string[],
  selectedKeys: ReadonlySet<string>,
): Promise<{ created: number; skipped: number }> {
  const { householdId } = input;
  if (input.manual.length === 0) return { created: 0, skipped: 0 };

  const transactionIds = [...new Set(input.manual.map((l) => l.transactionId))];
  const transactions = await tx.transaction.findMany({
    where: { householdId, id: { in: transactionIds } },
    select: { id: true, type: true, amount: true },
  });
  const txById = new Map(transactions.map((t) => [t.id, t]));
  const people = await tx.person.findMany({ where: { householdId }, select: { id: true, name: true, isActive: true } });
  const personById = new Map(people.map((p) => [p.id, p]));
  const existing = await tx.transactionShare.findMany({
    where: { householdId, transactionId: { in: transactionIds } },
    select: { transactionId: true, personId: true, direction: true, amount: true },
  });
  const existingKeys = new Set(existing.map((s) => `${s.transactionId}|${s.personId}|${s.direction}`));
  const sums = new Map<string, number>();
  for (const s of existing) {
    const key = `${s.transactionId}|${s.direction}`;
    sums.set(key, (sums.get(key) ?? 0) + storedToCents(s.amount));
  }

  const seen = new Set<string>();
  const toCreate: Array<{ transactionId: string; personId: string; direction: ShareDirection; amountCents: number }> = [];
  let skipped = 0;

  input.manual.forEach((line, position) => {
    const where = `Manual line ${position + 1}`;
    const transaction = txById.get(line.transactionId);
    if (!transaction) throw new BadRequestError(`${where}: transaction not found in this household`);
    if (transaction.type !== 'INCOME' && transaction.type !== 'EXPENSE') {
      throw new BadRequestError(`${where}: only income and expense transactions can be shared`);
    }
    const personId = line.personId ?? index.get(labelKey(cleanPersonName(line.personName ?? '')));
    const person = personId ? personById.get(personId) : undefined;
    if (!person) throw new BadRequestError(`${where}: person not found in this household`);
    if (!person.isActive) throw new BadRequestError(`${where}: ${person.name} is inactive`);
    const amountCents = toCents(line.amount, `${where}: amount`);
    if (amountCents < 1) throw new BadRequestError(`${where}: amount must be at least 0.01`);

    const key = `${line.transactionId}|${person.id}|${line.direction}`;
    if (selectedKeys.has(key)) {
      // A selected proposal and a manual line for the same share would be a silent double: the client must pick one.
      throw new BadRequestError(`${where}: the selected proposal for this transaction, person and direction already covers it; unselect the proposal to adjust the amount by hand`);
    }
    if (seen.has(key)) throw new BadRequestError(`${where}: the same person and direction appear twice for this transaction`);
    seen.add(key);
    if (existingKeys.has(key)) {
      skipped += 1;
      warnings.push(`${where}: ${person.name} já tem uma parte nesta transação; mantida como estava.`);
      return;
    }
    const sumKey = `${line.transactionId}|${line.direction}`;
    const total = (sums.get(sumKey) ?? 0) + amountCents;
    if (total > storedToCents(transaction.amount)) {
      throw new BadRequestError(`${where}: the parts of this transaction would add up to more than its amount`);
    }
    sums.set(sumKey, total);
    toCreate.push({ transactionId: line.transactionId, personId: person.id, direction: line.direction, amountCents });
  });

  let created = 0;
  for (const rows of chunks(toCreate)) {
    const result = await tx.transactionShare.createMany({
      data: rows.map((s) => ({
        householdId,
        transactionId: s.transactionId,
        personId: s.personId,
        direction: s.direction,
        amount: decimalFromCents(s.amountCents),
        source: 'manual',
      })),
      skipDuplicates: true,
    });
    created += result.count;
    skipped += rows.length - result.count;
  }
  return { created, skipped };
}

/**
 * Applies the chosen proposals. Everything runs in one database transaction on a fresh recompute: proposals that no
 * longer exist (already done, edited since the preview) count as skipped, and a proposal whose person was not chosen
 * in `people` is skipped with a warning.
 */
export async function applyOrganize(input: OrganizeApplyInput): Promise<OrganizeApplyResult> {
  const { householdId } = input;
  return prisma.$transaction(
    async (tx) => {
      const warnings: string[] = [];
      let skipped = 0;

      const aliasRows = await tx.personAlias.findMany({ where: { householdId }, select: { personId: true, key: true } });
      const index = new Map(aliasRows.map((r) => [r.key, r.personId]));
      const peopleCreated = await applyPeople(tx, input, index);

      const { shares, settlements } = await computeOrganize(tx, input);
      const sharesById = new Map(shares.map((s) => [s.id, s]));
      const settlementsById = new Map(settlements.map((s) => [s.id, s]));

      // Shares from the chosen proposals
      const shareRows: Array<{ proposal: InternalShare; personId: string }> = [];
      for (const id of new Set(input.proposalIds)) {
        const proposal = sharesById.get(id);
        if (!proposal) {
          skipped += 1;
          continue;
        }
        const personId = proposal.person.id ?? index.get(labelKey(proposal.person.name));
        if (!personId) {
          skipped += 1;
          warnings.push(`"${proposal.person.name}" não foi escolhida em "pessoas": a divisão de "${proposal.description}" (${proposal.date}) foi ignorada.`);
          continue;
        }
        shareRows.push({ proposal, personId });
      }
      let sharesCreated = 0;
      for (const rows of chunks(shareRows)) {
        const result = await tx.transactionShare.createMany({
          data: rows.map(({ proposal, personId }) => ({
            householdId,
            transactionId: proposal.transactionId,
            personId,
            direction: proposal.direction,
            amount: decimalFromCents(proposal.amountCents),
            source: 'import',
            note: proposal.note.slice(0, 500),
          })),
          skipDuplicates: true,
        });
        sharesCreated += result.count;
        skipped += rows.length - result.count;
      }

      // Settlements from the chosen proposals
      const settlementRows: Array<{ proposal: InternalSettlement; personId: string }> = [];
      for (const id of new Set(input.settlementIds)) {
        const proposal = settlementsById.get(id);
        if (!proposal) {
          skipped += 1;
          continue;
        }
        const personId = proposal.person.id ?? index.get(labelKey(proposal.person.name));
        if (!personId) {
          skipped += 1;
          warnings.push(`"${proposal.person.name}" não foi escolhida em "pessoas": o acerto de "${proposal.description}" (${proposal.date}) foi ignorado.`);
          continue;
        }
        settlementRows.push({ proposal, personId });
      }
      let settlementsCreated = 0;
      for (const rows of chunks(settlementRows)) {
        const result = await tx.settlement.createMany({
          data: rows.map(({ proposal, personId }) => ({
            householdId,
            personId,
            direction: proposal.direction,
            amount: decimalFromCents(proposal.amountCents),
            date: parseLocalDateString(proposal.date),
            transactionId: proposal.transactionId,
          })),
          skipDuplicates: true,
        });
        settlementsCreated += result.count;
        skipped += rows.length - result.count;
      }

      // Lines the user resolved by hand
      const selectedKeys = new Set(shareRows.map(({ proposal, personId }) => `${proposal.transactionId}|${personId}|${proposal.direction}`));
      const manual = await applyManual(tx, input, index, warnings, selectedKeys);
      sharesCreated += manual.created;
      skipped += manual.skipped;

      return { peopleCreated, sharesCreated, settlementsCreated, skipped, warnings: capWarnings(warnings) };
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}
