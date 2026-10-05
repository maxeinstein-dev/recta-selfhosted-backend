import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestError, ForbiddenError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { requireEditor } from '../../shared/middleware/authorization.middleware.js';
import { buildCardOfxPreview, confirmCardOfxImport, resolveCardAccount } from './card-ofx-import.service.js';
import { applyReviewActions, listReviewQueue } from './card-ofx-review.service.js';
import { cardOfxImportRoutes } from './card-ofx-import.routes.js';

vi.mock('../../shared/middleware/auth.middleware.js', () => ({
  authMiddleware: () => async () => undefined,
  getAuthUser: () => ({ uid: 'firebase-1', email: 'user@example.com' }),
}));
vi.mock('../../shared/middleware/authorization.middleware.js', () => ({
  requireEditor: vi.fn(),
  getUserByFirebaseUid: vi.fn(async () => ({ id: 'user-1' })),
}));
vi.mock('./card-ofx-import.service.js', () => ({
  MAX_CARD_OFX_LINES: 1000,
  resolveCardAccount: vi.fn(),
  buildCardOfxPreview: vi.fn(),
  confirmCardOfxImport: vi.fn(),
}));

vi.mock('./card-ofx-review.service.js', () => ({
  MAX_REVIEW_ACTIONS: 200,
  MAX_REVIEW_LIMIT: 500,
  listReviewQueue: vi.fn(),
  applyReviewActions: vi.fn(),
}));

const CARD_ID = '33333333-3333-4333-8333-333333333333';
const RESOLVED = { id: CARD_ID, householdId: 'household-1', type: 'CREDIT' };

const mockedRequireEditor = vi.mocked(requireEditor);
const mockedResolve = vi.mocked(resolveCardAccount);
const mockedPreview = vi.mocked(buildCardOfxPreview);
const mockedConfirm = vi.mocked(confirmCardOfxImport);

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });
  app.setErrorHandler(errorHandler);
  await app.register(cardOfxImportRoutes, { prefix: '/transactions' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockedRequireEditor.mockResolvedValue({} as never);
  // The real resolution authorizes the card's household before checking the account type; mimic that contract.
  mockedResolve.mockImplementation((async (_id: string, authorize?: (householdId: string) => Promise<unknown>) => {
    await authorize?.('household-1');
    return RESOLVED;
  }) as never);
  mockedPreview.mockResolvedValue({ lines: [] } as never);
  mockedConfirm.mockResolvedValue({ enriched: 1 } as never);
});

interface UploadFile {
  name: string;
  content: Buffer;
}

function multipartBody(fields: Record<string, string>, file?: UploadFile) {
  const boundary = `----vitest${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/x-ofx\r\n\r\n`,
      ),
      file.content,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

function preview(fields: Record<string, string>, file?: UploadFile) {
  const { payload, headers } = multipartBody(fields, file);
  return app.inject({ method: 'POST', url: '/transactions/import/card-ofx/preview', payload, headers });
}

const OFX: UploadFile = { name: 'Fatura_2026-11-09.ofx', content: Buffer.from('<OFX><CCSTMTRS></CCSTMTRS></OFX>') };

describe('POST /transactions/import/card-ofx/preview', () => {
  it('authorizes the card household before building the preview, and passes the file and options', async () => {
    const options = { monthOverride: { year: 2026, month: 11 } };

    const res = await preview({ accountId: CARD_ID, options: JSON.stringify(options) }, OFX);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { lines: [] } });
    expect(mockedResolve).toHaveBeenCalledWith(CARD_ID, expect.any(Function));
    expect(mockedRequireEditor).toHaveBeenCalledWith(expect.anything(), 'household-1');
    expect(mockedRequireEditor.mock.invocationCallOrder[0]!).toBeLessThan(mockedPreview.mock.invocationCallOrder[0]!);
    expect(mockedPreview).toHaveBeenCalledWith({ account: RESOLVED, buffer: OFX.content, options });
  });

  it('passes empty options when the field is absent and accepts the extension in any case', async () => {
    const res = await preview({ accountId: CARD_ID }, { ...OFX, name: 'FATURA.OFX' });

    expect(res.statusCode).toBe(200);
    expect(mockedPreview).toHaveBeenCalledWith(expect.objectContaining({ options: {} }));
  });

  it('answers 403 and never reads the invoice when the caller cannot edit the household', async () => {
    mockedRequireEditor.mockRejectedValue(new ForbiddenError('not your household'));

    const res = await preview({ accountId: CARD_ID }, OFX);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it('answers 400 when the account is not a credit card', async () => {
    mockedResolve.mockRejectedValue(new BadRequestError('Account "Conta" is not a credit card'));

    const res = await preview({ accountId: CARD_ID }, OFX);

    expect(res.statusCode).toBe(400);
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it('rejects a request without a file before touching the account', async () => {
    const res = await preview({ accountId: CARD_ID });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'BAD_REQUEST' } });
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it('rejects files that are not .ofx', async () => {
    const res = await preview({ accountId: CARD_ID }, { name: 'fatura.csv', content: OFX.content });

    expect(res.statusCode).toBe(400);
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it('rejects a missing or malformed accountId', async () => {
    const cases: Array<Record<string, string>> = [{}, { accountId: 'abc' }];
    for (const fields of cases) {
      const res = await preview(fields, OFX);
      expect(res.statusCode, JSON.stringify(fields)).toBe(400);
      expect(res.json()).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    }
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it.each<[string, string]>([
    ['not JSON', '{month'],
    ['a month out of range', JSON.stringify({ monthOverride: { year: 2026, month: 13 } })],
    ['a year out of range', JSON.stringify({ monthOverride: { year: 1999, month: 1 } })],
  ])('rejects options that are %s before resolving anything', async (_label, options) => {
    const res = await preview({ accountId: CARD_ID, options }, OFX);

    expect(res.statusCode).toBe(400);
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it('answers 413 (not 500) when the file is over the 5 MB limit', async () => {
    const big = { name: 'big.ofx', content: Buffer.alloc(5 * 1024 * 1024 + 4096, 97) };

    const res = await preview({ accountId: CARD_ID }, big);

    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'PAYLOAD_TOO_LARGE' } });
    expect(mockedPreview).not.toHaveBeenCalled();
  });
});

const LINE = {
  ref: 'ofx:fit-1:0a1b2c3d',
  fitid: 'fit-1',
  date: '2026-11-03',
  amount: 50,
  type: 'EXPENSE',
  kind: 'purchase',
  memo: 'Loja Alfa - Parcela 4/10',
  merchant: 'Loja Alfa',
  installment: { number: 4, total: 10 },
};

function confirmBody(overrides: Record<string, unknown> = {}) {
  return {
    accountId: CARD_ID,
    monthKey: '2026-11',
    lines: [LINE],
    selectedGroups: [`create|${LINE.ref}|`],
    categoryMap: [{ key: 'Loja Alfa', type: 'EXPENSE', target: { kind: 'system', categoryName: 'FOOD' } }],
    payment: { apply: true, sourceAccountId: '22222222-2222-4222-8222-222222222222' },
    ...overrides,
  };
}

function confirm(body: unknown) {
  return app.inject({ method: 'POST', url: '/transactions/import/card-ofx/confirm', payload: body as object });
}

describe('POST /transactions/import/card-ofx/confirm', () => {
  it('authorizes the card household, then confirms with the user and answers 201', async () => {
    const res = await confirm(confirmBody());

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ success: true, data: { enriched: 1 } });
    expect(mockedRequireEditor.mock.invocationCallOrder[0]!).toBeLessThan(mockedConfirm.mock.invocationCallOrder[0]!);
    expect(mockedConfirm).toHaveBeenCalledWith({ request: confirmBody(), account: RESOLVED, userId: 'user-1' });
  });

  it('accepts a null payment decision', async () => {
    expect((await confirm(confirmBody({ payment: null }))).statusCode).toBe(201);
  });

  it('answers 403 and never confirms when the caller cannot edit the household', async () => {
    mockedRequireEditor.mockRejectedValue(new ForbiddenError('not your household'));

    const res = await confirm(confirmBody());

    expect(res.statusCode).toBe(403);
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ['no lines', { lines: [] }],
    ['more than 1000 lines', { lines: Array.from({ length: 1001 }, (_, i) => ({ ...LINE, ref: `ofx:f${i}:0a1b2c3d` })) }],
    ['more than 1000 selected groups', { selectedGroups: Array.from({ length: 1001 }, (_, i) => `create|ofx:f${i}:0a1b2c3d|`) }],
    ['a group id over 16000 characters', { selectedGroups: ['x'.repeat(16_001)] }],
    ['a malformed month key', { monthKey: '2026-1' }],
    ['an accountId that is not a UUID', { accountId: 'abc' }],
    ['a payment source that is not a UUID', { payment: { apply: true, sourceAccountId: 'abc' } }],
    ['a payment without apply', { payment: { sourceAccountId: '22222222-2222-4222-8222-222222222222' } }],
    ['an unknown category target', { categoryMap: [{ key: 'Loja', type: 'EXPENSE', target: { kind: 'steal' } }] }],
    ['a missing payment field', { payment: undefined }],
  ])('rejects %s before the service runs', async (_label, overrides) => {
    const res = await confirm(confirmBody(overrides));

    expect(res.statusCode).toBe(400);
    expect(mockedResolve).not.toHaveBeenCalled();
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ['a ref over 120 characters', { ref: `ofx:${'a'.repeat(120)}:0a1b2c3d` }],
    ['a memo over 255 characters', { memo: 'm'.repeat(256) }],
    ['a non-positive amount', { amount: 0 }],
    ['an amount above the cap', { amount: 1_000_000_001 }],
    ['a malformed date', { date: '03/11/2026' }],
    ['an unknown kind', { kind: 'cashback' }],
    ['an installment above 99', { installment: { number: 1, total: 100 } }],
  ])('rejects a line with %s', async (_label, patch) => {
    const res = await confirm(confirmBody({ lines: [{ ...LINE, ...patch }] }));

    expect(res.statusCode).toBe(400);
    expect(mockedConfirm).not.toHaveBeenCalled();
  });
});

describe('card review queue routes', () => {
  const TX_ID = '44444444-4444-4444-8444-444444444444';
  const mockedList = vi.mocked(listReviewQueue);
  const mockedApply = vi.mocked(applyReviewActions);

  beforeEach(() => {
    mockedList.mockResolvedValue({ items: [] } as never);
    mockedApply.mockResolvedValue({ done: 1 } as never);
  });

  it('GET authorizes the card household as editor and passes month and limit', async () => {
    const res = await app.inject({ method: 'GET', url: `/transactions/import/card-ofx/review-queue?accountId=${CARD_ID}&monthKey=2026-01&limit=50` });

    expect(res.statusCode).toBe(200);
    expect(mockedRequireEditor).toHaveBeenCalledWith(expect.anything(), 'household-1');
    expect(mockedList).toHaveBeenCalledWith({ account: RESOLVED, monthKey: '2026-01', limit: 50 });
  });

  it('GET passes the view (queue or kept) and rejects any other', async () => {
    const res = await app.inject({ method: 'GET', url: `/transactions/import/card-ofx/review-queue?accountId=${CARD_ID}&view=kept` });
    expect(res.statusCode).toBe(200);
    expect(mockedList).toHaveBeenCalledWith(expect.objectContaining({ view: 'kept' }));

    const bad = await app.inject({ method: 'GET', url: `/transactions/import/card-ofx/review-queue?accountId=${CARD_ID}&view=all` });
    expect(bad.statusCode).toBe(400);
  });

  it('POST accepts unkeep', async () => {
    const actions = [{ transactionId: TX_ID, action: 'unkeep' }];

    const res = await app.inject({ method: 'POST', url: '/transactions/import/card-ofx/review-queue/actions', payload: { accountId: CARD_ID, actions } });

    expect(res.statusCode).toBe(200);
    expect(mockedApply).toHaveBeenCalledWith({ account: RESOLVED, actions });
  });

  it('GET answers 403 without reading the queue when the caller cannot edit the household', async () => {
    mockedRequireEditor.mockRejectedValue(new ForbiddenError('not your household'));

    const res = await app.inject({ method: 'GET', url: `/transactions/import/card-ofx/review-queue?accountId=${CARD_ID}` });

    expect(res.statusCode).toBe(403);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('GET rejects a bad account id, month or limit', async () => {
    for (const query of ['accountId=nope', `accountId=${CARD_ID}&monthKey=2026-13`, `accountId=${CARD_ID}&limit=501`]) {
      const res = await app.inject({ method: 'GET', url: `/transactions/import/card-ofx/review-queue?${query}` });
      expect(res.statusCode, query).toBe(400);
    }
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('POST authorizes the card and applies the actions', async () => {
    const actions = [{ transactionId: TX_ID, action: 'keep' }];

    const res = await app.inject({ method: 'POST', url: '/transactions/import/card-ofx/review-queue/actions', payload: { accountId: CARD_ID, actions } });

    expect(res.statusCode).toBe(200);
    expect(mockedRequireEditor).toHaveBeenCalledWith(expect.anything(), 'household-1');
    expect(mockedApply).toHaveBeenCalledWith({ account: RESOLVED, actions });
  });

  it('POST answers 403 and writes nothing for a viewer', async () => {
    mockedRequireEditor.mockRejectedValue(new ForbiddenError('not your household'));

    const res = await app.inject({
      method: 'POST',
      url: '/transactions/import/card-ofx/review-queue/actions',
      payload: { accountId: CARD_ID, actions: [{ transactionId: TX_ID, action: 'delete' }] },
    });

    expect(res.statusCode).toBe(403);
    expect(mockedApply).not.toHaveBeenCalled();
  });

  it('POST rejects an empty list, an unknown action, a non-uuid id and more than 200 actions', async () => {
    const post = (actions: unknown) =>
      app.inject({ method: 'POST', url: '/transactions/import/card-ofx/review-queue/actions', payload: { accountId: CARD_ID, actions } });

    expect((await post([])).statusCode).toBe(400);
    expect((await post([{ transactionId: TX_ID, action: 'archive' }])).statusCode).toBe(400);
    expect((await post([{ transactionId: 'x', action: 'keep' }])).statusCode).toBe(400);
    expect((await post(Array.from({ length: 201 }, () => ({ transactionId: TX_ID, action: 'keep' })))).statusCode).toBe(400);
    expect(mockedApply).not.toHaveBeenCalled();
  });
});
