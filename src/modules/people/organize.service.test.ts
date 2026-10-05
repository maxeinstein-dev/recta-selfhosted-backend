import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fakePrisma,
  resetStore,
  rowsOf,
  seedPerson,
  seedSettlement,
  seedShare,
  seedTransaction,
  type SeedTransaction,
} from './__fixtures__/people-fake-db.js';
import { applyOrganize, previewOrganize } from './organize.service.js';
import type { OrganizeApplyInput } from './organize.schema.js';
import type { OrganizePreview } from './people.types.js';

vi.mock('../../shared/db/prisma.js', async () => ({
  prisma: (await import('./__fixtures__/people-fake-db.js')).fakePrisma,
}));

// Invented data only: names, amounts and ids below are fictitious.

const HH = 'hh-1';
const OTHER = 'hh-2';

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
});

function expense(over: Partial<SeedTransaction> & { notes?: string | null } = {}) {
  return seedTransaction({ householdId: HH, type: 'EXPENSE', amount: 100, description: 'Compra', date: '2026-10-01', ...over });
}

function income(over: Partial<SeedTransaction> = {}) {
  return seedTransaction({ householdId: HH, type: 'INCOME', amount: 300, description: 'Entrada', date: '2026-10-02', ...over });
}

const preview = (over: Record<string, unknown> = {}) => previewOrganize({ householdId: HH, ...over });

function apply(over: Partial<OrganizeApplyInput> = {}) {
  return applyOrganize({ householdId: HH, people: [], proposalIds: [], settlementIds: [], manual: [], ...over });
}

/** Applies everything the preview selects by default, creating the new people as they came. */
async function applyAll(p: OrganizePreview, over: Partial<OrganizeApplyInput> = {}) {
  return apply({
    people: p.newPeople.map((n) => ({ name: n.name, aliases: n.aliases })),
    proposalIds: p.proposals.filter((x) => x.defaultSelected).map((x) => x.id),
    settlementIds: p.settlements.filter((x) => x.defaultSelected).map((x) => x.id),
    ...over,
  });
}

function error(statusCode: number, message?: string | RegExp) {
  return expect.objectContaining({
    statusCode,
    ...(message ? { message: typeof message === 'string' ? expect.stringContaining(message) : expect.stringMatching(message) } : {}),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Preview: standard notes
// ---------------------------------------------------------------------------------------------------------------

describe('organize preview: standard notes', () => {
  it('"*Dividir com X" is half of the amount, with the odd cent going to the other person', async () => {
    const tx = expense({ amount: 120.01, description: 'Cinema', notes: '*Dividir com Bia' });

    const result = await preview();

    expect(result.proposals).toEqual([
      {
        id: `${tx.id}:bia:THEY_OWE_ME`,
        transactionId: tx.id,
        description: 'Cinema',
        date: '2026-10-01',
        transactionAmount: 120.01,
        note: '*Dividir com Bia',
        person: { id: null, name: 'Bia' },
        direction: 'THEY_OWE_ME',
        amount: 60.01,
        percent: 50,
        defaultSelected: true,
      },
    ]);
    expect(result.newPeople).toEqual([{ name: 'Bia', aliases: [] }]);
  });

  it('"*X" is the whole amount owed to me, "Pagar a X" is the whole amount I owe', async () => {
    const a = expense({ amount: 80, notes: '*Caio' });
    const b = expense({ amount: 45.5, notes: 'Pagar a Dora', date: '2026-10-02' });

    const result = await preview();

    expect(result.proposals.map((p) => [p.transactionId, p.person.name, p.direction, p.amount, p.percent])).toEqual([
      [a.id, 'Caio', 'THEY_OWE_ME', 80, 100],
      [b.id, 'Dora', 'I_OWE_THEM', 45.5, 100],
    ]);
    expect(result.newPeople.map((p) => p.name)).toEqual(['Caio', 'Dora']);
  });

  it('reads the typo "Divivir", a leading "*" in the name and the remarks the importer appends', async () => {
    const typo = expense({ notes: '*Divivir com Bia' });
    const star = expense({ notes: '*Dividir com *Caio', date: '2026-10-02' });
    const joined = expense({ notes: '*Dividir com Dora · previsto R$ 300,00 · antecipou 2 parcelas (3..4)', date: '2026-10-03' });

    const result = await preview();

    expect(result.proposals.map((p) => [p.transactionId, p.person.name, p.amount, p.note])).toEqual([
      [typo.id, 'Bia', 50, '*Divivir com Bia'],
      [star.id, 'Caio', 50, '*Dividir com *Caio'],
      [joined.id, 'Dora', 50, '*Dividir com Dora'],
    ]);
    expect(result.review).toEqual([]);
  });

  it('is case and accent insensitive for names, and lists a new person once', async () => {
    expense({ notes: '*Dividir com José' });
    expense({ notes: '*dividir com JOSE', date: '2026-10-02' });

    const result = await preview();

    expect(result.proposals).toHaveLength(2);
    expect(result.newPeople).toEqual([{ name: 'José', aliases: [] }]);
    // each proposal has its own deterministic id
    expect(new Set(result.proposals.map((p) => p.id)).size).toBe(2);
  });

  it('a reimbursable note without a person, or "*Dividir" alone, goes to review (never to a person called "Dividir")', async () => {
    const reimb = expense({ notes: '*Reembolsar' });
    const alone = expense({ notes: '*Dividir', date: '2026-10-02' });

    const result = await preview();

    expect(result.proposals).toEqual([]);
    expect(result.newPeople).toEqual([]);
    expect(result.review.map((r) => [r.transactionId, r.reason])).toEqual([
      [reimb.id, 'Reembolsável, sem pessoa informada'],
      [alone.id, expect.stringContaining('Texto livre')],
    ]);
  });

  it('a split note on an income is a review line, not a share', async () => {
    const tx = income({ notes: '*Dividir com Bia' });
    const result = await preview();
    expect(result.proposals).toEqual([]);
    expect(result.review).toEqual([expect.objectContaining({ transactionId: tx.id, reason: 'Nota de divisão numa receita' })]);
  });

  it('ignores transactions without a note and notes that talk about nothing shared', async () => {
    expense();
    expense({ notes: 'comprado na promoção', date: '2026-10-02' });
    const result = await preview();
    expect(result).toMatchObject({ proposals: [], review: [], settlements: [], newPeople: [], alreadyDone: 0, warnings: [] });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Preview: free text, aliases, filters
// ---------------------------------------------------------------------------------------------------------------

describe('organize preview: free text and known people', () => {
  it('sends free text that talks about sharing to review, with the reason', async () => {
    const all = expense({ notes: 'Dividido com todo mundo' });
    const typo = expense({ notes: 'Divivir com alguém', date: '2026-10-02' });
    const refund = expense({ notes: 'cliente vai reembolsar', date: '2026-10-03' });
    const pay = expense({ notes: 'preciso pagar depois', date: '2026-10-04' });

    const result = await preview();

    expect(result.proposals).toEqual([]);
    expect(result.review.map((r) => [r.transactionId, r.note, r.reason, r.suggestedPersonId])).toEqual([
      [all.id, 'Dividido com todo mundo', 'Texto livre fala em "dividido"', null],
      [typo.id, 'Divivir com alguém', 'Texto livre fala em "divivir"', null],
      [refund.id, 'cliente vai reembolsar', 'Texto livre fala em "reembolso"', null],
      [pay.id, 'preciso pagar depois', 'Texto livre fala em "pagar"', null],
    ]);
  });

  it('a free text that mentions a known person (by alias) suggests that person', async () => {
    const lucia = seedPerson({ householdId: HH, name: 'Lúcia', aliases: ['Lulu'] });
    const tx = expense({ notes: 'Divivir com Lulu' });
    const mention = expense({ notes: 'Jantar do Lúcia e eu', date: '2026-10-02' });

    const result = await preview();

    expect(result.review).toEqual([
      expect.objectContaining({ transactionId: tx.id, reason: 'Texto livre cita Lúcia e fala em "divivir"', suggestedPersonId: lucia.id }),
      expect.objectContaining({ transactionId: mention.id, reason: 'Texto livre cita Lúcia', suggestedPersonId: lucia.id }),
    ]);
  });

  it('matches whole words only: "Biancamente" is not Bia', async () => {
    seedPerson({ householdId: HH, name: 'Bia' });
    expense({ notes: 'Biancamente delicioso' });
    expect((await preview()).review).toEqual([]);
  });

  it('suggests nobody when the text mentions two known people', async () => {
    seedPerson({ householdId: HH, name: 'Bia' });
    seedPerson({ householdId: HH, name: 'Caio' });
    expense({ notes: 'Bia e Caio vão pagar' });
    const [line] = (await preview()).review;
    expect(line).toMatchObject({ reason: 'Texto livre cita Bia, Caio e fala em "pagar"', suggestedPersonId: null });
  });

  it('resolves a note name through the aliases: one person with several nicknames, no new person', async () => {
    const lucia = seedPerson({ householdId: HH, name: 'Lúcia', aliases: ['Lulu'] });
    expense({ notes: '*Dividir com Lulu' });
    expense({ notes: '*dividir com lucia', date: '2026-10-02' });

    const result = await preview();

    expect(result.newPeople).toEqual([]);
    expect(result.proposals.map((p) => p.person)).toEqual([
      { id: lucia.id, name: 'Lúcia' },
      { id: lucia.id, name: 'Lúcia' },
    ]);
  });

  it('warns instead of proposing for an inactive person', async () => {
    seedPerson({ householdId: HH, name: 'Bia', isActive: false });
    expense({ description: 'Cinema', notes: '*Bia' });
    const result = await preview();
    expect(result.proposals).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining('inativa')]);
  });

  it('filters by period and by imported rows, and never reads another household', async () => {
    const inside = expense({ notes: '*Bia', date: '2026-10-10', sourceRef: 'maxfin:2026-10:credit:3' });
    expense({ notes: '*Bia', date: '2026-09-30', sourceRef: 'maxfin:2026-09:credit:3' });
    const manual = expense({ notes: '*Caio', date: '2026-10-11' });
    seedTransaction({ householdId: OTHER, type: 'EXPENSE', amount: 10, date: '2026-10-10', notes: '*Dora' });

    expect((await preview()).proposals).toHaveLength(3);
    const period = await preview({ startDate: '2026-10-01', endDate: '2026-10-31' });
    expect(period.proposals.map((p) => p.transactionId)).toEqual([inside.id, manual.id]);
    const imported = await preview({ startDate: '2026-10-01', endDate: '2026-10-31', onlyImported: true });
    expect(imported.proposals.map((p) => p.transactionId)).toEqual([inside.id]);
    expect((await preview()).newPeople.map((p) => p.name)).toEqual(['Bia', 'Caio']);
  });

  it('rejects an inverted period', async () => {
    await expect(preview({ startDate: '2026-11-01', endDate: '2026-10-01' })).rejects.toEqual(error(400, 'startDate'));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Preview: settlements
// ---------------------------------------------------------------------------------------------------------------

describe('organize preview: settlements', () => {
  it('proposes a received settlement for an income named after a known person or alias', async () => {
    const lucia = seedPerson({ householdId: HH, name: 'Lúcia', aliases: ['Lulu'] });
    const a = income({ description: 'Lulu', amount: 800.5 });
    const b = income({ description: 'LÚCIA', amount: 100, date: '2026-10-05' });
    income({ description: 'Salário' });

    const result = await preview();

    expect(result.settlements).toEqual([
      { id: `settlement:${a.id}`, transactionId: a.id, description: 'Lulu', date: '2026-10-02', amount: 800.5, person: { id: lucia.id, name: 'Lúcia' }, direction: 'RECEIVED', defaultSelected: true },
      expect.objectContaining({ id: `settlement:${b.id}`, amount: 100 }),
    ]);
    expect(result.newPeople).toEqual([]);
  });

  it('"Reembolso - Nome" proposes a settlement, creating the person when unknown', async () => {
    const tx = income({ description: 'Reembolso - Otto', amount: 55 });
    const result = await preview();
    expect(result.settlements).toEqual([expect.objectContaining({ transactionId: tx.id, person: { id: null, name: 'Otto' }, amount: 55 })]);
    expect(result.newPeople).toEqual([{ name: 'Otto', aliases: [] }]);
  });

  it('an income named after a person the notes introduce is a settlement of that new person', async () => {
    expense({ notes: '*Dividir com Lulu' });
    const tx = income({ description: 'Lulu', amount: 50 });
    const result = await preview();
    expect(result.newPeople).toEqual([{ name: 'Lulu', aliases: [] }]);
    expect(result.settlements).toEqual([expect.objectContaining({ transactionId: tx.id, person: { id: null, name: 'Lulu' } })]);
  });

  it('does not propose an income a settlement already uses, and counts it as done', async () => {
    const bia = seedPerson({ householdId: HH, name: 'Bia' });
    const tx = income({ description: 'Bia' });
    seedSettlement({ householdId: HH, personId: bia.id, amount: 300, transactionId: tx.id });
    const result = await preview();
    expect(result.settlements).toEqual([]);
    expect(result.alreadyDone).toBe(1);
  });

  it('never proposes a settlement for an expense', async () => {
    seedPerson({ householdId: HH, name: 'Bia' });
    expense({ description: 'Bia' });
    expect((await preview()).settlements).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Preview: already done
// ---------------------------------------------------------------------------------------------------------------

describe('organize preview: what is already done', () => {
  it('skips a share that exists for the same transaction, person and direction, and counts it', async () => {
    const bia = seedPerson({ householdId: HH, name: 'Bia' });
    const done = expense({ notes: '*Dividir com Bia' });
    seedShare({ householdId: HH, transactionId: done.id, personId: bia.id, amount: 50 });
    const open = expense({ notes: '*Dividir com Bia', date: '2026-10-02' });

    const result = await preview();

    expect(result.alreadyDone).toBe(1);
    expect(result.proposals.map((p) => p.transactionId)).toEqual([open.id]);
  });

  it('a share in the other direction does not count as done', async () => {
    const bia = seedPerson({ householdId: HH, name: 'Bia' });
    const tx = expense({ notes: '*Dividir com Bia' });
    seedShare({ householdId: HH, transactionId: tx.id, personId: bia.id, amount: 10, direction: 'I_OWE_THEM' });
    const result = await preview();
    expect(result.alreadyDone).toBe(0);
    expect(result.proposals).toHaveLength(1);
  });

  it('does not queue for review a free text whose transaction somebody already split', async () => {
    const bia = seedPerson({ householdId: HH, name: 'Bia' });
    const tx = expense({ notes: 'Dividido com a Bia' });
    seedShare({ householdId: HH, transactionId: tx.id, personId: bia.id, amount: 50 });
    const result = await preview();
    expect(result.review).toEqual([]);
    expect(result.alreadyDone).toBe(1);
  });

  it('warns and proposes nothing when the existing parts plus the note would pass the amount', async () => {
    const caio = seedPerson({ householdId: HH, name: 'Caio' });
    const tx = expense({ amount: 100, description: 'Mercado', notes: '*Dividir com Bia' });
    seedShare({ householdId: HH, transactionId: tx.id, personId: caio.id, amount: 70 });
    const result = await preview();
    expect(result.proposals).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining('Mercado')]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------------------------------------------

describe('organize apply', () => {
  it('creates the people, the shares and the settlements the preview selected', async () => {
    const a = expense({ amount: 120.01, notes: '*Dividir com Lulu' });
    const b = expense({ amount: 45.5, notes: 'Pagar a Dora', date: '2026-10-02' });
    const r = income({ description: 'Lulu', amount: 60 });
    const p = await preview();

    const result = await applyAll(p);

    expect(result).toEqual({ peopleCreated: 2, sharesCreated: 2, settlementsCreated: 1, skipped: 0, warnings: [] });
    const people = rowsOf('person');
    expect(people.map((x) => x.name)).toEqual(['Lulu', 'Dora']);
    const shares = rowsOf('transactionShare');
    expect(shares.map((s) => [s.transactionId, s.direction, s.amount, s.source, s.note])).toEqual([
      [a.id, 'THEY_OWE_ME', 60.01, 'import', '*Dividir com Lulu'],
      [b.id, 'I_OWE_THEM', 45.5, 'import', 'Pagar a Dora'],
    ]);
    expect(shares[0]!.personId).toBe(people[0]!.id);
    expect(rowsOf('settlement')).toEqual([
      expect.objectContaining({ personId: people[0]!.id, direction: 'RECEIVED', amount: 60, transactionId: r.id, date: '2026-10-02' }),
    ]);
  });

  it('merges names into one person: "Lúcia" with the alias "Lulu" gets the proposals of both', async () => {
    const a = expense({ notes: '*Dividir com Lúcia' });
    const b = expense({ notes: '*Dividir com Lulu', date: '2026-10-02' });
    const r = income({ description: 'Lulu', amount: 77 });
    const p = await preview();
    expect(p.newPeople.map((n) => n.name)).toEqual(['Lúcia', 'Lulu']);

    const result = await applyAll(p, { people: [{ name: 'Lúcia', aliases: ['Lulu'] }] });

    expect(result).toMatchObject({ peopleCreated: 1, sharesCreated: 2, settlementsCreated: 1, skipped: 0 });
    const [person] = rowsOf('person');
    expect(rowsOf('person')).toHaveLength(1);
    expect(rowsOf('personAlias').map((x) => [x.label, x.isName])).toEqual([['Lúcia', true], ['Lulu', false]]);
    expect(rowsOf('transactionShare').map((s) => [s.transactionId, s.personId])).toEqual([[a.id, person!.id], [b.id, person!.id]]);
    expect(rowsOf('settlement')[0]).toMatchObject({ personId: person!.id, transactionId: r.id });
  });

  it('merges a new name into an existing person through existingId, adding the alias', async () => {
    const lucia = seedPerson({ householdId: HH, name: 'Lúcia' });
    expense({ notes: '*Dividir com Lulu' });
    const p = await preview();
    expect(p.newPeople.map((n) => n.name)).toEqual(['Lulu']);

    const result = await applyAll(p, { people: [{ name: 'Lulu', existingId: lucia.id }] });

    expect(result).toMatchObject({ peopleCreated: 0, sharesCreated: 1 });
    expect(rowsOf('person')).toHaveLength(1);
    expect(rowsOf('personAlias').map((x) => x.label)).toEqual(['Lúcia', 'Lulu']);
    expect(rowsOf('transactionShare')[0]!.personId).toBe(lucia.id);
    // the next preview recognizes the nickname
    expect((await preview()).newPeople).toEqual([]);
  });

  it('reuses a person whose name the user listed again instead of creating a duplicate', async () => {
    seedPerson({ householdId: HH, name: 'Bia', aliases: ['Biazinha'] });
    expense({ notes: '*Dividir com Biazinha' });
    const p = await preview();
    const result = await applyAll(p, { people: [{ name: 'bia', aliases: ['Bi'] }] });
    expect(result.peopleCreated).toBe(0);
    expect(rowsOf('person')).toHaveLength(1);
    expect(rowsOf('personAlias').map((x) => x.label)).toEqual(['Bia', 'Biazinha', 'Bi']);
  });

  it('answers 409 when the user maps a name onto an alias that belongs to somebody else, changing nothing', async () => {
    seedPerson({ householdId: HH, name: 'Bia' });
    const caio = seedPerson({ householdId: HH, name: 'Caio' });
    expense({ notes: '*Dividir com Dora' });
    const p = await preview();

    await expect(applyAll(p, { people: [{ name: 'Dora', aliases: ['Bia'], existingId: caio.id }] })).rejects.toEqual(error(409, 'Bia'));
    expect(rowsOf('transactionShare')).toHaveLength(0);
    expect(rowsOf('personAlias')).toHaveLength(2);
  });

  it('is idempotent: applying again creates nothing and the preview shows it as done', async () => {
    expense({ amount: 90, notes: '*Dividir com Bia' });
    income({ description: 'Bia', amount: 45 });
    const p = await preview();
    await applyAll(p);

    const again = await applyAll(p, { people: [] });

    expect(again).toMatchObject({ peopleCreated: 0, sharesCreated: 0, settlementsCreated: 0, skipped: 2 });
    expect(rowsOf('transactionShare')).toHaveLength(1);
    expect(rowsOf('settlement')).toHaveLength(1);
    const next = await preview();
    expect(next).toMatchObject({ proposals: [], settlements: [], newPeople: [], alreadyDone: 2 });
  });

  it('applies only the ids it was given', async () => {
    const a = expense({ notes: '*Bia' });
    const b = expense({ notes: '*Caio', date: '2026-10-02' });
    const p = await preview();
    const only = p.proposals.find((x) => x.transactionId === b.id)!;

    const result = await apply({ people: [{ name: 'Caio' }], proposalIds: [only.id] });

    expect(result).toMatchObject({ sharesCreated: 1, skipped: 0, peopleCreated: 1 });
    expect(rowsOf('transactionShare').map((s) => s.transactionId)).toEqual([b.id]);
    expect(a.id).not.toBe(b.id);
  });

  it('recomputes on the server: made-up ids are skipped and amounts come from the database, not the client', async () => {
    const tx = expense({ amount: 100, notes: '*Dividir com Bia' });
    const p = await preview();
    // the transaction is edited between the preview and the confirmation
    const row = rowsOf('transaction').find((t) => t.id === tx.id)!;
    row.amount = 80;

    const result = await apply({
      people: [{ name: 'Bia' }],
      proposalIds: [p.proposals[0]!.id, `${tx.id}:bia:I_OWE_THEM`, 'nonsense', `${tx.id}:caio:THEY_OWE_ME`],
      settlementIds: ['settlement:not-a-transaction'],
    });

    expect(result).toMatchObject({ sharesCreated: 1, skipped: 4 });
    expect(rowsOf('transactionShare')[0]!.amount).toBe(40); // half of 80, whatever the preview said (50)
  });

  it('creates only what the ids name: an unknown id never falls back to another proposal', async () => {
    expense({ notes: '*Bia' });
    const second = expense({ notes: '*Caio', date: '2026-10-02' });
    const p = await preview();
    const caio = p.proposals.find((x) => x.transactionId === second.id)!;

    const result = await apply({ people: [{ name: 'Bia' }, { name: 'Caio' }], proposalIds: [caio.id, 'nonsense', `${second.id}:bia:THEY_OWE_ME`] });

    expect(result).toMatchObject({ sharesCreated: 1, skipped: 2 });
    expect(rowsOf('transactionShare').map((x) => x.transactionId)).toEqual([second.id]);
    expect(rowsOf('transactionShare')[0]!.personId).toBe(rowsOf('person').find((x) => x.name === 'Caio')!.id);
  });

  it('counts a proposal that vanished (transaction deleted, note edited) as skipped', async () => {
    const gone = expense({ notes: '*Dividir com Bia' });
    const edited = expense({ notes: '*Dividir com Bia', date: '2026-10-02' });
    const p = await preview();
    rowsOf('transaction').splice(rowsOf('transaction').findIndex((t) => t.id === gone.id), 1);
    rowsOf('transaction').find((t) => t.id === edited.id)!.notes = 'sem divisão';

    const result = await applyAll(p);

    expect(result).toMatchObject({ sharesCreated: 0, skipped: 2 });
  });

  it('skips with a warning the proposals of a person the user did not pick', async () => {
    const a = expense({ description: 'Cinema', notes: '*Dividir com Bia' });
    expense({ notes: '*Dividir com Caio', date: '2026-10-02' });
    const p = await preview();

    const result = await applyAll(p, { people: [{ name: 'Caio' }] });

    expect(result).toMatchObject({ peopleCreated: 1, sharesCreated: 1, skipped: 1 });
    expect(result.warnings).toEqual([expect.stringContaining('Bia')]);
    expect(rowsOf('transactionShare').map((s) => s.transactionId)).not.toContain(a.id);
  });

  it('applies the period filter again: a proposal outside it is skipped', async () => {
    const tx = expense({ notes: '*Bia', date: '2026-09-15' });
    const p = await preview();
    const result = await apply({ people: [{ name: 'Bia' }], proposalIds: p.proposals.map((x) => x.id), startDate: '2026-10-01' });
    expect(result).toMatchObject({ sharesCreated: 0, skipped: 1 });
    expect(tx.id).toBeDefined();
  });

  it('never touches another household, even with its ids', async () => {
    const foreign = seedTransaction({ householdId: OTHER, type: 'EXPENSE', amount: 100, notes: '*Dora' });
    const result = await apply({ people: [{ name: 'Dora' }], proposalIds: [`${foreign.id}:dora:THEY_OWE_ME`] });
    expect(result).toMatchObject({ sharesCreated: 0, skipped: 1 });
    expect(rowsOf('transactionShare')).toHaveLength(0);
  });

  it('is atomic: a failure after the people were created rolls everything back', async () => {
    expense({ notes: '*Dividir com Bia' });
    income({ description: 'Reembolso - Bia', amount: 20 });
    const p = await preview();
    fakePrisma.settlement.createMany.mockRejectedValueOnce(new Error('connection lost'));

    await expect(applyAll(p)).rejects.toThrow('connection lost');

    expect(rowsOf('person')).toHaveLength(0);
    expect(rowsOf('personAlias')).toHaveLength(0);
    expect(rowsOf('transactionShare')).toHaveLength(0);
    expect(rowsOf('settlement')).toHaveLength(0);
  });

  it('counts a race on the unique key as skipped instead of failing (createMany skips duplicates)', async () => {
    const tx = expense({ notes: '*Dividir com Bia' });
    const p = await preview();
    const bia = seedPerson({ householdId: HH, name: 'Bia' });
    // another request records the same share between the recompute and the insert
    const real = fakePrisma.transactionShare.createMany.getMockImplementation()!;
    fakePrisma.transactionShare.createMany.mockImplementationOnce(async (args) => {
      seedShare({ householdId: HH, transactionId: tx.id, personId: bia.id, amount: 50 });
      return real(args);
    });

    const result = await apply({ people: [], proposalIds: p.proposals.map((x) => x.id) });

    expect(result).toMatchObject({ sharesCreated: 0, skipped: 1 });
    expect(rowsOf('transactionShare')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Apply: manual lines (the review screen)
// ---------------------------------------------------------------------------------------------------------------

describe('organize apply: manual lines', () => {
  it('creates a share resolved by hand, by person id or by name, as a manual share', async () => {
    const bia = seedPerson({ householdId: HH, name: 'Bia', aliases: ['Biazinha'] });
    const a = expense({ amount: 100, notes: 'Dividido com a Bia' });
    const b = expense({ amount: 60, notes: 'Divivir com Biazinha', date: '2026-10-02' });

    const result = await apply({
      manual: [
        { transactionId: a.id, personId: bia.id, direction: 'THEY_OWE_ME', amount: 33.33 },
        { transactionId: b.id, personName: 'biazinha', direction: 'THEY_OWE_ME', amount: 30 },
      ],
    });

    expect(result).toMatchObject({ sharesCreated: 2, skipped: 0 });
    expect(rowsOf('transactionShare').map((s) => [s.transactionId, s.personId, s.amount, s.source])).toEqual([
      [a.id, bia.id, 33.33, 'manual'],
      [b.id, bia.id, 30, 'manual'],
    ]);
    // the review lines are gone from the next preview
    const next = await preview();
    expect(next.review).toEqual([]);
    expect(next.alreadyDone).toBe(2);
  });

  it('resolves a person name against the people created in the same request', async () => {
    const tx = expense({ amount: 100, notes: 'racha com o Caio' });
    const result = await apply({
      people: [{ name: 'Caio' }],
      manual: [{ transactionId: tx.id, personName: '*Caio', direction: 'THEY_OWE_ME', amount: 25 }],
    });
    expect(result).toMatchObject({ peopleCreated: 1, sharesCreated: 1 });
  });

  it('validates like a PUT: amount above the transaction, parts that add up too high, duplicates, inactive or unknown people', async () => {
    const bia = seedPerson({ householdId: HH, name: 'Bia' });
    const caio = seedPerson({ householdId: HH, name: 'Caio' });
    const inactive = seedPerson({ householdId: HH, name: 'Dora', isActive: false });
    const tx = expense({ amount: 100 });
    const line = (over: Record<string, unknown>) => ({ transactionId: tx.id, personId: bia.id, direction: 'THEY_OWE_ME' as const, amount: 10, ...over });

    await expect(apply({ manual: [line({ amount: 100.01 })] })).rejects.toEqual(error(400, /add up to more/));
    await expect(apply({ manual: [line({ amount: 60 }), line({ personId: caio.id, amount: 40.01 })] })).rejects.toEqual(error(400, /add up to more/));
    await expect(apply({ manual: [line({}), line({ amount: 5 })] })).rejects.toEqual(error(400, /twice/));
    await expect(apply({ manual: [line({ personId: inactive.id })] })).rejects.toEqual(error(400, /inactive/));
    await expect(apply({ manual: [line({ personId: undefined, personName: 'Ninguém' })] })).rejects.toEqual(error(400, /person not found/));
    await expect(apply({ manual: [line({ amount: 10.005 })] })).rejects.toEqual(error(400, /2 decimal/));
    expect(rowsOf('transactionShare')).toHaveLength(0);
  });

  it('rejects a transaction or person of another household', async () => {
    const stranger = seedPerson({ householdId: OTHER, name: 'Estranha' });
    const mine = expense({ amount: 100 });
    const foreign = seedTransaction({ householdId: OTHER, type: 'EXPENSE', amount: 100 });
    const bia = seedPerson({ householdId: HH, name: 'Bia' });

    await expect(apply({ manual: [{ transactionId: foreign.id, personId: bia.id, direction: 'THEY_OWE_ME', amount: 10 }] })).rejects.toEqual(error(400, /transaction not found/));
    await expect(apply({ manual: [{ transactionId: mine.id, personId: stranger.id, direction: 'THEY_OWE_ME', amount: 10 }] })).rejects.toEqual(error(400, /person not found/));
  });

  it('rejects a transfer', async () => {
    const bia = seedPerson({ householdId: HH, name: 'Bia' });
    const transfer = seedTransaction({ householdId: HH, type: 'TRANSFER', amount: 50 });
    await expect(apply({ manual: [{ transactionId: transfer.id, personId: bia.id, direction: 'THEY_OWE_ME', amount: 10 }] })).rejects.toEqual(error(400, /income and expense/));
  });

  it('counts a line that already exists as skipped and keeps what was there', async () => {
    const bia = seedPerson({ householdId: HH, name: 'Bia' });
    const tx = expense({ amount: 100 });
    seedShare({ householdId: HH, transactionId: tx.id, personId: bia.id, amount: 50 });

    const result = await apply({ manual: [{ transactionId: tx.id, personId: bia.id, direction: 'THEY_OWE_ME', amount: 70 }] });

    expect(result).toMatchObject({ sharesCreated: 0, skipped: 1 });
    expect(result.warnings).toHaveLength(1);
    expect(rowsOf('transactionShare').map((s) => s.amount)).toEqual([50]);
  });

  it('is atomic with the proposals: one invalid manual line leaves nothing behind', async () => {
    const tx = expense({ notes: '*Dividir com Bia' });
    const p = await preview();
    await expect(
      applyAll(p, { manual: [{ transactionId: tx.id, personName: 'Bia', direction: 'I_OWE_THEM', amount: 1000 }] }),
    ).rejects.toEqual(error(400));
    expect(rowsOf('person')).toHaveLength(0);
    expect(rowsOf('transactionShare')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Volume and odd data
// ---------------------------------------------------------------------------------------------------------------

describe('organize: volume and odd data', () => {
  it('inserts in chunks, so a year of proposals never exceeds the statement parameter limit', async () => {
    for (let i = 0; i < 2500; i++) expense({ amount: 10 + i, description: `Compra ${i}`, notes: '*Dividir com Bia', date: '2026-10-01' });
    const p = await preview();
    expect(p.proposals).toHaveLength(2500);

    const result = await applyAll(p);

    expect(result).toMatchObject({ peopleCreated: 1, sharesCreated: 2500, skipped: 0 });
    const sizes = fakePrisma.transactionShare.createMany.mock.calls.map(([args]) => (args as { data: unknown[] }).data.length);
    expect(sizes).toEqual([1000, 1000, 500]);
    expect(rowsOf('transactionShare')).toHaveLength(2500);
  });

  it('ignores transactions whose amount is not positive instead of failing', async () => {
    expense({ amount: 0, notes: '*Bia' });
    expense({ amount: -20, notes: '*Bia' });
    income({ amount: -5, description: 'Bia' });
    const ok = expense({ amount: 0.01, notes: '*Dividir com Bia' });

    const result = await preview();

    expect(result.proposals.map((x) => [x.transactionId, x.amount])).toEqual([[ok.id, 0.01]]);
    expect(result.settlements).toEqual([]);
  });
});
