import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { requireEditor } from '../../shared/middleware/authorization.middleware.js';
import { getAccount } from '../accounts/accounts.service.js';
import { buildImportPreview } from './import.service.js';
import { importRoutes } from './import.routes.js';

vi.mock('../../shared/middleware/auth.middleware.js', () => ({
  authMiddleware: () => async () => undefined,
  getAuthUser: () => ({ uid: 'firebase-1', email: 'user@example.com' }),
}));
vi.mock('../../shared/middleware/authorization.middleware.js', () => ({
  requireEditor: vi.fn(),
  getUserByFirebaseUid: vi.fn(async () => ({ id: 'user-1' })),
}));
vi.mock('../accounts/accounts.service.js', () => ({ getAccount: vi.fn() }));
// The guard and the parser run for real; only the database-bound preview is replaced.
vi.mock('./import.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./import.service.js')>()),
  buildImportPreview: vi.fn(),
  confirmImport: vi.fn(),
}));

const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

const CARD_INVOICE = `OFXHEADER:100
DATA:OFXSGML
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261105<TRNAMT>-10.00<FITID>c1<MEMO>Padaria Exemplo
</STMTTRN>
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>
`;
const BANK_STATEMENT = `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261105<TRNAMT>-10.00<FITID>b1<MEMO>Padaria Exemplo
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>
`;

const mockedGetAccount = vi.mocked(getAccount);
const mockedRequireEditor = vi.mocked(requireEditor);
const mockedPreview = vi.mocked(buildImportPreview);

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });
  app.setErrorHandler(errorHandler);
  await app.register(importRoutes, { prefix: '/transactions' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockedRequireEditor.mockResolvedValue({} as never);
  mockedPreview.mockResolvedValue({ rows: [], total: 0, duplicateCount: 0, newCount: 0 });
});

function upload(type: string, filename: string, content: string) {
  mockedGetAccount.mockResolvedValue({ id: ACCOUNT_ID, householdId: 'household-1', type } as never);
  const boundary = '----vitestboundary';
  const payload = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="accountId"\r\n\r\n${ACCOUNT_ID}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/x-ofx\r\n\r\n` +
      `${content}\r\n--${boundary}--\r\n`,
  );
  return app.inject({
    method: 'POST',
    url: '/transactions/import/preview',
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
}

describe('POST /transactions/import/preview with a card invoice', () => {
  it('answers 400 pointing to the card importer for a CCSTMTRS file on a credit card', async () => {
    const res = await upload('CREDIT', 'Fatura_2026-11-09.ofx', CARD_INVOICE);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'BAD_REQUEST' } });
    expect(res.json().error.message).toContain('/transactions/import/card-ofx/preview');
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it('authorizes first: a caller outside the household gets 403, not the hint', async () => {
    mockedRequireEditor.mockRejectedValue(new ForbiddenError('not your household'));

    const res = await upload('CREDIT', 'fatura.ofx', CARD_INVOICE);

    expect(res.statusCode).toBe(403);
  });

  it('still imports bank statements on any account, and card files on non-card accounts', async () => {
    expect((await upload('CREDIT', 'extrato.ofx', BANK_STATEMENT)).statusCode).toBe(200);
    expect((await upload('CHECKING', 'fatura.ofx', CARD_INVOICE)).statusCode).toBe(200);
    expect(mockedPreview).toHaveBeenCalledTimes(2);
  });
});
