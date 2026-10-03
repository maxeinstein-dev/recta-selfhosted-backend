import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { requireEditor } from '../../shared/middleware/authorization.middleware.js';
import { buildMaxFinPreview, confirmMaxFinImport, resolveMaxFinAccounts } from './maxfin-import.service.js';
import { maxfinImportRoutes } from './maxfin-import.routes.js';

vi.mock('../../shared/middleware/auth.middleware.js', () => ({
  authMiddleware: () => async () => undefined,
  getAuthUser: () => ({ uid: 'firebase-1', email: 'user@example.com' }),
}));
vi.mock('../../shared/middleware/authorization.middleware.js', () => ({
  requireEditor: vi.fn(),
  getUserByFirebaseUid: vi.fn(async () => ({ id: 'user-1' })),
}));
vi.mock('./maxfin-import.service.js', () => ({
  resolveMaxFinAccounts: vi.fn(),
  buildMaxFinPreview: vi.fn(),
  confirmMaxFinImport: vi.fn(),
}));

const ACCOUNTS = {
  income: '11111111-1111-4111-8111-111111111111',
  bills: '22222222-2222-4222-8222-222222222222',
  credit: '33333333-3333-4333-8333-333333333333',
  debit: '44444444-4444-4444-8444-444444444444',
};
const RESOLVED = { householdId: 'household-1' };

const mockedRequireEditor = vi.mocked(requireEditor);
const mockedResolve = vi.mocked(resolveMaxFinAccounts);
const mockedPreview = vi.mocked(buildMaxFinPreview);
const mockedConfirm = vi.mocked(confirmMaxFinImport);

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });
  app.setErrorHandler(errorHandler);
  await app.register(maxfinImportRoutes, { prefix: '/transactions' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockedRequireEditor.mockResolvedValue({} as never);
  // The real resolution authorizes every household involved; mimic that contract.
  mockedResolve.mockImplementation((async (_accounts: unknown, authorize?: (householdId: string) => Promise<unknown>) => {
    await authorize?.('household-1');
    return RESOLVED;
  }) as never);
  mockedPreview.mockResolvedValue({ rows: [] } as never);
  mockedConfirm.mockResolvedValue({ imported: 1 } as never);
});

function multipartBody(fields: Record<string, string>, file?: { name: string; content: Buffer }) {
  const boundary = `----vitest${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: text/csv\r\n\r\n`,
      ),
      file.content,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

function preview(fields: Record<string, string>, file?: { name: string; content: Buffer }) {
  const { payload, headers } = multipartBody(fields, file);
  return app.inject({ method: 'POST', url: '/transactions/import/maxfin/preview', payload, headers });
}

const CSV = { name: 'sheet.csv', content: Buffer.from('a,b\n1,2\n') };

describe('POST /transactions/import/maxfin/preview', () => {
  it('authorizes the household while resolving the accounts and before building the preview', async () => {
    const res = await preview({ accounts: JSON.stringify(ACCOUNTS) }, CSV);

    expect(res.statusCode).toBe(200);
    expect(mockedResolve).toHaveBeenCalledTimes(1);
    expect(mockedRequireEditor).toHaveBeenCalledWith(expect.anything(), 'household-1');
    expect(mockedRequireEditor.mock.invocationCallOrder[0]!).toBeLessThan(
      mockedPreview.mock.invocationCallOrder[0]!,
    );
    expect(mockedPreview).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'sheet.csv', accounts: ACCOUNTS, resolved: RESOLVED }),
    );
  });

  it('answers 403 and never builds a preview when the caller cannot edit the household', async () => {
    mockedRequireEditor.mockRejectedValue(new ForbiddenError('not your household'));

    const res = await preview({ accounts: JSON.stringify(ACCOUNTS) }, CSV);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it('rejects a request without a file', async () => {
    const res = await preview({ accounts: JSON.stringify(ACCOUNTS) });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'BAD_REQUEST' } });
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it('rejects files that are not .csv', async () => {
    const res = await preview({ accounts: JSON.stringify(ACCOUNTS) }, { name: 'sheet.xlsx', content: CSV.content });

    expect(res.statusCode).toBe(400);
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it('rejects `accounts` that is not JSON with a 400, not a 500', async () => {
    const res = await preview({ accounts: '{not json' }, CSV);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'BAD_REQUEST' } });
  });

  it('rejects account ids that are not UUIDs', async () => {
    const res = await preview({ accounts: JSON.stringify({ ...ACCOUNTS, credit: 'abc' }) }, CSV);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it('answers 413 (not 500) when the file is over the 5 MB limit', async () => {
    const big = { name: 'big.csv', content: Buffer.alloc(5 * 1024 * 1024 + 4096, 97) };

    const res = await preview({ accounts: JSON.stringify(ACCOUNTS) }, big);

    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'PAYLOAD_TOO_LARGE' } });
    expect(mockedPreview).not.toHaveBeenCalled();
  });
});

function confirmBody(overrides: Record<string, unknown> = {}) {
  return {
    month: { year: 2026, month: 3 },
    accounts: ACCOUNTS,
    options: { closedMonth: true, payInvoice: true, generateFutureInstallments: false },
    categoryMap: [],
    rows: [
      {
        sourceRef: 'maxfin:2026-03:debit:7',
        section: 'debit',
        type: 'EXPENSE',
        description: 'Pix Padaria',
        categoryKey: '',
        amount: 10,
        paid: true,
        date: '2026-03-01',
        notes: null,
        installment: null,
      },
    ],
    ...overrides,
  };
}

function confirm(body: unknown) {
  return app.inject({ method: 'POST', url: '/transactions/import/maxfin/confirm', payload: body as object });
}

function installment(overrides: Record<string, unknown> = {}) {
  return {
    number: 3,
    total: 10,
    prepaid: 0,
    baseDescription: 'Loja A',
    installmentId: 'maxfin:loja-a:10',
    futureCount: 7,
    ...overrides,
  };
}

describe('POST /transactions/import/maxfin/confirm', () => {
  it('passes the resolved accounts and the user to the service and answers 201', async () => {
    const res = await confirm(confirmBody());

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ success: true, data: { imported: 1 } });
    expect(mockedConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', resolved: RESOLVED }),
    );
  });

  it('answers 403 and never confirms when the caller cannot edit the household', async () => {
    mockedRequireEditor.mockRejectedValue(new ForbiddenError('not your household'));

    const res = await confirm(confirmBody());

    expect(res.statusCode).toBe(403);
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it('rejects out-of-range or malformed installments before the service runs', async () => {
    const tampered = [
      installment({ total: 100 }),
      installment({ number: 0 }),
      installment({ futureCount: 9999 }),
      installment({ installmentId: 'someone-elses-plan' }),
    ];
    for (const bad of tampered) {
      const body = confirmBody();
      (body.rows[0] as Record<string, unknown>).installment = bad;
      const res = await confirm(body);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it('rejects an amount above the cap, a non-positive amount and a malformed date', async () => {
    for (const patch of [{ amount: 1_000_000_001 }, { amount: 0 }, { amount: -5 }, { date: '01/03/2026' }]) {
      const body = confirmBody();
      Object.assign(body.rows[0] as Record<string, unknown>, patch);
      const res = await confirm(body);
      expect(res.statusCode, JSON.stringify(patch)).toBe(400);
    }
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it('rejects an empty rows array and more than 500 rows', async () => {
    expect((await confirm(confirmBody({ rows: [] }))).statusCode).toBe(400);
    const row = confirmBody().rows[0]!;
    const many = Array.from({ length: 501 }, (_, i) => ({ ...row, sourceRef: `maxfin:2026-03:debit:${i + 1}` }));
    expect((await confirm(confirmBody({ rows: many }))).statusCode).toBe(400);
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it('rejects unknown category-map target kinds', async () => {
    const res = await confirm(
      confirmBody({ categoryMap: [{ key: 'Casa', type: 'EXPENSE', target: { kind: 'steal' } }] }),
    );

    expect(res.statusCode).toBe(400);
    expect(mockedConfirm).not.toHaveBeenCalled();
  });
});
