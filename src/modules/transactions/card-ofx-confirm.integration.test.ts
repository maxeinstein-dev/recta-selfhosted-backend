import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../../shared/db/prisma.js';
import { confirmCardOfxImport } from './card-ofx-confirm.service.js';
import { buildCardOfxPreview, resolveCardAccount } from './card-ofx-import.service.js';
import type { CardOfxConfirmRequest, CardOfxPreviewResponse } from './card-ofx-import.types.js';

/**
 * The card invoice confirm against a real Postgres. Skipped unless IMPORT_DB_TEST_URL points at a SCRATCH database
 * that already has the migrations applied (see CONTRIBUTING). Dates are in 2025 so they are always in the past.
 */
const enabled = Boolean(process.env.IMPORT_DB_TEST_URL);

const trn = (date: string, amount: string, fitid: string, memo: string) =>
  `<STMTTRN><DTPOSTED>${date}<TRNAMT>${amount}<FITID>${fitid}<MEMO>${memo}</STMTTRN>`;
const ofx = (...trns: string[]) =>
  Buffer.from(
    `<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><BANKTRANLIST><DTSTART>20251102<DTEND>20251202${trns.join('')}</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`,
  );

const MARKET = trn('20251110', '-60.00', 'fit-market', 'Corner market');
const SHOES = trn('20251115', '-40.00', 'fit-shoes', 'Shoe store - Parcela 2/3');
const REFUND = trn('20251120', '10.00', 'fit-refund', 'Estorno de Corner market');
const PAYMENT = trn('20251103', '85.00', 'fit-pay', 'Pagamento recebido');
const FILE = ofx(MARKET, SHOES, REFUND, PAYMENT);

describe.skipIf(!enabled)('card invoice confirm on Postgres', { timeout: 60_000 }, () => {
  const households: string[] = [];
  const newHousehold = async () => {
    const id = (await prisma.household.create({ data: { name: 'Card confirm test' } })).id;
    households.push(id);
    return id;
  };
  const newCard = async (householdId: string) =>
    (await prisma.account.create({ data: { householdId, name: 'Card', type: 'CREDIT', dueDay: 9 } })).id;
  const typed = (householdId: string, accountId: string, amount: number, date: string, extra: Record<string, unknown> = {}) =>
    prisma.transaction.create({
      data: { householdId, accountId, type: 'EXPENSE', categoryName: 'OTHER_EXPENSES', amount, date: new Date(`${date}T00:00:00Z`), description: 'typed', ...extra },
    });

  async function setup(file: Buffer = FILE) {
    const householdId = await newHousehold();
    const cardId = await newCard(householdId);
    const account = await resolveCardAccount(cardId);
    return { householdId, cardId, account, file };
  }

  const preview = (account: Awaited<ReturnType<typeof resolveCardAccount>>, buffer: Buffer) => buildCardOfxPreview({ account, buffer });
  const requestFrom = (p: CardOfxPreviewResponse, over: Partial<CardOfxConfirmRequest> = {}): CardOfxConfirmRequest => ({
    accountId: p.accountId,
    lines: p.lines.map(({ status: _s, possibleDuplicate: _d, ...line }) => line),
    selectedRefs: p.lines.filter((l) => l.status === 'new').map((l) => l.ref),
    createDespiteDuplicate: [],
    links: [],
    categoryMap: [],
    ...over,
  });
  const confirm = (account: Awaited<ReturnType<typeof resolveCardAccount>>, request: CardOfxConfirmRequest) =>
    confirmCardOfxImport({ account, request });
  const rows = (accountId: string) => prisma.transaction.findMany({ where: { accountId, sourceRef: { not: null } }, orderBy: { date: 'asc' } });

  afterAll(async () => {
    for (const id of households) await prisma.household.delete({ where: { id } });
    await prisma.$disconnect();
  });
  beforeAll(() => {
    expect(process.env.DATABASE_URL).toBe(process.env.IMPORT_DB_TEST_URL);
  });

  it('creates the selected lines with their ref, installment and category, never the payment, and is idempotent', async () => {
    const { account, cardId } = await setup();
    const p = await preview(account, FILE);
    const refs = Object.fromEntries(p.lines.map((l) => [l.memo, l.ref]));

    const result = await confirm(
      account,
      requestFrom(p, { categoryMap: [{ merchant: 'Corner market', type: 'EXPENSE', categoryName: 'GROCERIES' }] }),
    );

    expect(result).toMatchObject({ created: 3, linked: 0, skipped: [] });
    const stored = await rows(cardId);
    expect(stored.map((t) => [t.sourceRef, t.type, t.amount.toNumber(), t.categoryName, t.paid])).toEqual([
      [refs['Corner market'], 'EXPENSE', 60, 'GROCERIES', true],
      [refs['Shoe store - Parcela 2/3'], 'EXPENSE', 40, 'OTHER_EXPENSES', true],
      [refs['Estorno de Corner market'], 'INCOME', 10, 'OTHER_INCOME', true],
    ]);
    expect(stored[1]).toMatchObject({ installmentNumber: 2, totalInstallments: 3, installmentId: 'ofx:fit-shoes', description: 'Shoe store - Parcela 2/3' });
    expect(stored[0]!.date.toISOString().slice(0, 10)).toBe('2025-11-10');
    expect(await prisma.transaction.count({ where: { accountId: cardId } })).toBe(3);

    // The same request again, and the preview of the same file, find everything already there.
    const again = await confirm(account, requestFrom(p, { selectedRefs: p.lines.filter((l) => l.kind !== 'payment').map((l) => l.ref) }));
    expect(again).toMatchObject({ created: 0, linked: 0 });
    expect(again.skipped.map((s) => s.cause)).toEqual(['already-imported', 'already-imported', 'already-imported']);
    expect(await prisma.transaction.count({ where: { accountId: cardId } })).toBe(3);
    expect((await preview(account, FILE)).lines.map((l) => l.status)).toEqual(['reconciled', 'reconciled', 'reconciled', 'payment']);
  });

  it('creates each line once when the same confirm runs three times in parallel', async () => {
    const { account, cardId } = await setup();
    const request = requestFrom(await preview(account, FILE));

    const results = await Promise.all([confirm(account, request), confirm(account, request), confirm(account, request)]);

    expect(results.reduce((total, r) => total + r.created, 0)).toBe(3);
    expect(await prisma.transaction.count({ where: { accountId: cardId } })).toBe(3);
  });

  it('keeps identical lines of one file apart, each with its own ref', async () => {
    const twin = trn('20251110', '-15.00', 'fit-twin', 'Garage');
    const { account, cardId } = await setup();
    const p = await preview(account, ofx(twin, twin, twin));

    expect(await confirm(account, requestFrom(p))).toMatchObject({ created: 3 });
    expect(new Set((await rows(cardId)).map((t) => t.sourceRef)).size).toBe(3);
    expect(await confirm(account, requestFrom(p))).toMatchObject({ created: 0 });
  });

  it('refuses payment lines, unknown refs and tampered lines without writing anything', async () => {
    const { account, cardId } = await setup();
    const p = await preview(account, FILE);
    const payment = p.lines.find((l) => l.kind === 'payment')!;
    const lines = requestFrom(p).lines;

    await expect(confirm(account, requestFrom(p, { selectedRefs: [payment.ref] }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(confirm(account, requestFrom(p, { selectedRefs: ['ofx:nope:00000000'] }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(confirm(account, requestFrom(p, { lines: lines.map((l, i) => (i === 0 ? { ...l, amount: 1 } : l)) }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      confirm(account, requestFrom(p, { categoryMap: [{ merchant: 'Corner market', type: 'EXPENSE', categoryName: 'SALARY' }] })),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      confirm(account, requestFrom(p, { categoryMap: [{ merchant: 'Corner market', type: 'EXPENSE', categoryName: 'CUSTOM:00000000-0000-4000-8000-000000000000' }] })),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await prisma.transaction.count({ where: { accountId: cardId } })).toBe(0);
  });

  it('skips lines another importer or an earlier run already holds, by ref, also when the client says they are new', async () => {
    const { account, cardId, householdId } = await setup();
    const p = await preview(account, FILE);
    const market = p.lines.find((l) => l.memo === 'Corner market')!;
    await typed(householdId, cardId, 1, '2025-11-01', { sourceRef: market.ref });

    const result = await confirm(account, requestFrom(p));

    expect(result.created).toBe(2);
    expect(result.skipped).toEqual([{ ref: market.ref, cause: 'already-imported' }]);
  });

  describe('transactions typed by hand', () => {
    it('flags a look-alike in the preview, leaves it out unless told otherwise, and creates it when told', async () => {
      const { account, cardId, householdId } = await setup();
      const hand = await typed(householdId, cardId, 60, '2025-11-12');
      const p = await preview(account, FILE);
      const market = p.lines.find((l) => l.memo === 'Corner market')!;

      expect(market.status).toBe('new');
      expect(market.possibleDuplicate).toEqual({ transactionId: hand.id, description: 'typed', date: '2025-11-12' });
      expect(p.totals.possibleDuplicates).toBe(1);
      expect(p.warnings).toContain('possible-duplicates');
      expect(p.lines.filter((l) => l.possibleDuplicate).length).toBe(1);

      const skipped = await confirm(account, requestFrom(p));
      expect(skipped).toMatchObject({ created: 2, skipped: [{ ref: market.ref, cause: 'possible-duplicate' }] });

      const forced = await confirm(account, requestFrom(p, { selectedRefs: [market.ref], createDespiteDuplicate: [market.ref] }));
      expect(forced).toMatchObject({ created: 1, skipped: [] });
      expect(await prisma.transaction.count({ where: { accountId: cardId, amount: 60 } })).toBe(2);
    });

    it('links a line to the look-alike: nothing is created, the line counts as reconciled, the row is not offered again', async () => {
      const { account, cardId, householdId } = await setup();
      const hand = await typed(householdId, cardId, 60, '2025-11-12');
      const p = await preview(account, FILE);
      const market = p.lines.find((l) => l.memo === 'Corner market')!;

      const result = await confirm(
        account,
        requestFrom(p, { selectedRefs: [], links: [{ ref: market.ref, transactionId: hand.id }] }),
      );

      expect(result).toMatchObject({ created: 0, linked: 1, skipped: [] });
      expect(await prisma.transactionExternalRef.findMany({ where: { householdId }, select: { ref: true, transactionId: true } })).toEqual([
        { ref: market.ref, transactionId: hand.id },
      ]);
      const after = await preview(account, FILE);
      expect(after.lines.find((l) => l.ref === market.ref)).toMatchObject({ status: 'reconciled', possibleDuplicate: null });
      // Linking again is a no-op, not an error.
      expect(await confirm(account, requestFrom(p, { selectedRefs: [], links: [{ ref: market.ref, transactionId: hand.id }] }))).toMatchObject({
        linked: 0,
        skipped: [{ ref: market.ref, cause: 'already-imported' }],
      });
    });

    it('refuses a link to a transaction that is not the one offered, or that changed since', async () => {
      const { account, cardId, householdId } = await setup();
      const hand = await typed(householdId, cardId, 60, '2025-11-12');
      const unrelated = await typed(householdId, cardId, 99, '2025-11-12');
      const p = await preview(account, FILE);
      const market = p.lines.find((l) => l.memo === 'Corner market')!;
      const link = (transactionId: string) => confirm(account, requestFrom(p, { selectedRefs: [], links: [{ ref: market.ref, transactionId }] }));

      expect((await link(unrelated.id)).skipped).toEqual([{ ref: market.ref, cause: 'link-refused' }]);
      await prisma.transaction.update({ where: { id: hand.id }, data: { amount: 61 } });
      expect((await link(hand.id)).skipped).toEqual([{ ref: market.ref, cause: 'link-refused' }]);
      expect(await prisma.transactionExternalRef.count({ where: { householdId } })).toBe(0);
    });

    it('rejects a line both created and linked, and one transaction linked to two lines', async () => {
      const { account, cardId, householdId } = await setup();
      const hand = await typed(householdId, cardId, 60, '2025-11-12');
      const p = await preview(account, FILE);
      const [a, b] = p.lines;

      await expect(confirm(account, requestFrom(p, { selectedRefs: [a!.ref], links: [{ ref: a!.ref, transactionId: hand.id }] }))).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        confirm(account, requestFrom(p, { selectedRefs: [], links: [{ ref: a!.ref, transactionId: hand.id }, { ref: b!.ref, transactionId: hand.id }] })),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('offers a hand-typed row to one line only, the closest by date, and ignores what does not fit', async () => {
      const twin = trn('20251110', '-15.00', 'fit-twin', 'Garage');
      const { account, cardId, householdId } = await setup();
      const other = await newHousehold();
      const otherCard = await newCard(other);
      const near = await typed(householdId, cardId, 15, '2025-11-11');
      await typed(householdId, cardId, 15, '2025-11-14'); // 4 days: outside the window
      await typed(householdId, cardId, 16, '2025-11-10'); // other amount
      await typed(householdId, cardId, 15, '2025-11-10', { sourceRef: 'ofx:other:00000001' }); // already an import
      await typed(other, otherCard, 15, '2025-11-10'); // another household
      await prisma.transaction.create({
        data: { householdId, accountId: cardId, type: 'INCOME', categoryName: 'OTHER_INCOME', amount: 15, date: new Date('2025-11-10T00:00:00Z') },
      }); // other direction

      const p = await preview(account, ofx(twin, twin));

      expect(p.lines.map((l) => l.possibleDuplicate?.transactionId ?? null)).toEqual([near.id, null]);
    });
  });

  it('suggests the category the household last gave a merchant, but not "other" nor a deleted custom one', async () => {
    const { account, cardId, householdId } = await setup();
    await typed(householdId, cardId, 5, '2025-10-01', { description: 'Corner market', categoryName: 'GROCERIES' });
    await typed(householdId, cardId, 5, '2025-10-20', { description: 'Corner market - Parcela 1/2', categoryName: 'FOOD' });
    await typed(householdId, cardId, 5, '2025-10-02', { description: 'Shoe store', categoryName: 'OTHER_EXPENSES' });
    const gone = '00000000-0000-4000-8000-0000000000aa';
    await typed(householdId, cardId, 5, '2025-10-03', { description: 'Estorno de Corner market', type: 'INCOME', categoryName: `CUSTOM:${gone}` });

    const p = await preview(account, FILE);

    expect(p.categorySuggestions).toEqual([{ merchant: 'Corner market', type: 'EXPENSE', categoryName: 'FOOD' }]);
  });
});
