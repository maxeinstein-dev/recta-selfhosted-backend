import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../../shared/db/prisma.js';
import { buildImportPreview, confirmImport, flagDuplicates, parseImportBuffer } from './import.service.js';

/**
 * Statement import against a real Postgres. Skipped unless IMPORT_DB_TEST_URL points at a SCRATCH database that
 * already has the migrations applied (vitest.config.ts hands that URL to the app's Prisma client):
 *
 *   createdb up_s6 && DATABASE_URL=postgresql://.../up_s6 npx prisma migrate deploy
 *   IMPORT_DB_TEST_URL=postgresql://.../up_s6 npx vitest run src/modules/transactions/import.integration.test.ts
 *
 * Never point it at a database you care about: it creates a household and removes it afterwards, but it does write.
 */
const enabled = Boolean(process.env.IMPORT_DB_TEST_URL);

const ofx = (entries: Array<[string, string, string, string]>) =>
  Buffer.from(
    `OFXHEADER:100\nDATA:OFXSGML\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>\n` +
      entries
        .map(([id, date, amount, memo]) => `<STMTTRN><DTPOSTED>${date}\n<TRNAMT>${amount}\n<FITID>${id}\n<MEMO>${memo}\n</STMTTRN>\n`)
        .join('') +
      `</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>\n`,
  );

describe.skipIf(!enabled)('statement import on Postgres', () => {
  let householdId: string;
  const newAccount = async (name: string) =>
    (await prisma.account.create({ data: { householdId, name, type: 'CHECKING' } })).id;
  const countRows = (accountId: string) => prisma.transaction.count({ where: { accountId } });
  const balance = async (accountId: string) => (await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).balance.toNumber();

  beforeAll(async () => {
    householdId = (await prisma.household.create({ data: { name: 'Import test' } })).id;
  });

  afterAll(async () => {
    if (householdId) await prisma.household.delete({ where: { id: householdId } });
    await prisma.$disconnect();
  });

  it('keeps two identical entries of one file and agrees between preview, confirm and a second run', async () => {
    const accountId = await newAccount('Two coffees');
    const parsed = parseImportBuffer('a.ofx', ofx([['a1', '20261105', '-10.00', 'Coffee'], ['a2', '20261105', '-10.00', 'Coffee']]));

    const preview = await buildImportPreview(accountId, householdId, parsed);
    expect(preview).toMatchObject({ newCount: 2, duplicateCount: 0 });
    expect(await countRows(accountId)).toBe(0);

    expect(await confirmImport(accountId, householdId, parsed.rows)).toMatchObject({ imported: 2, skipped: 0 });
    expect(await countRows(accountId)).toBe(2);
    expect(await balance(accountId)).toBe(-20);

    expect(await buildImportPreview(accountId, householdId, parsed)).toMatchObject({ newCount: 0, duplicateCount: 2 });
    expect(await confirmImport(accountId, householdId, parsed.rows)).toMatchObject({ imported: 0, skipped: 2 });
    expect(await countRows(accountId)).toBe(2);
  });

  it('stores the day the bank printed, whatever the time and the server zone', async () => {
    const accountId = await newAccount('Late night');
    const parsed = parseImportBuffer('a.ofx', ofx([['n1', '20261105235959', '-1.00', 'Late']]));

    await confirmImport(accountId, householdId, parsed.rows);

    const [stored] = await prisma.$queryRaw<Array<{ day: string }>>`SELECT date::text AS day FROM transactions WHERE account_id = ${accountId}::uuid`;
    expect(stored?.day).toBe('2026-11-05');
  });

  it('imports a file once when two confirms run at the same time', async () => {
    const accountId = await newAccount('Parallel');
    const parsed = parseImportBuffer(
      'a.ofx',
      ofx([['p1', '20261105', '-10.00', 'Coffee'], ['p2', '20261105', '-10.00', 'Coffee'], ['p3', '20261106', '-4.50', 'Bus']]),
    );

    const results = await Promise.all([
      confirmImport(accountId, householdId, parsed.rows),
      confirmImport(accountId, householdId, parsed.rows),
      confirmImport(accountId, householdId, parsed.rows),
    ]);

    expect(results.reduce((sum, r) => sum + r.imported, 0)).toBe(3);
    expect(await countRows(accountId)).toBe(3);
    expect(await balance(accountId)).toBe(-24.5);
  });

  it('flags a 5000-row file against an account that already holds it in a single pass', async () => {
    const accountId = await newAccount('Big');
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      date: new Date(Date.UTC(2026, i % 12, 1 + (i % 28))),
      description: `Row ${i}`,
      amount: 1 + (i % 50),
      type: 'EXPENSE' as const,
    }));
    await prisma.transaction.createMany({
      data: rows.map((r) => ({ householdId, accountId, type: 'EXPENSE', categoryName: 'OTHER_EXPENSES', amount: r.amount, description: r.description, date: r.date })),
    });

    const started = Date.now();
    const flags = await flagDuplicates(accountId, householdId, rows);

    expect(flags.every(Boolean)).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
