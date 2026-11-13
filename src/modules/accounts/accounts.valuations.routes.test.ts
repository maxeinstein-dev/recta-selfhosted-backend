import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorHandler } from '../../shared/errors/error-handler.js';
import { ForbiddenError } from '../../shared/errors/app-error.js';
import { requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { accountRoutes } from './accounts.routes.js';
import * as accountsService from './accounts.service.js';
import * as valuations from './account-valuations.js';

vi.mock('../../shared/middleware/auth.middleware.js', () => ({
  authMiddleware: () => async () => undefined,
  getAuthUser: () => ({ uid: 'firebase-1', email: 'user@example.com' }),
}));
vi.mock('../../shared/middleware/authorization.middleware.js', () => ({
  requireEditor: vi.fn(),
  requireHouseholdMember: vi.fn(),
  ensurePersonalHousehold: vi.fn(),
  getUserByFirebaseUid: vi.fn(),
}));
vi.mock('./accounts.service.js', () => ({ getAccount: vi.fn() }));
vi.mock('./account-valuations.js', async (orig) => ({
  ...(await orig<typeof import('./account-valuations.js')>()),
  listValuations: vi.fn(),
  saveValuation: vi.fn(),
  deleteValuation: vi.fn(),
}));

// Invented data only.
const ACC = '11111111-1111-4111-8111-111111111111';
const VAL = '22222222-2222-4222-8222-222222222222';
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  app.setErrorHandler(errorHandler);
  await app.register(accountRoutes, { prefix: '/accounts' });
  await app.ready();
});
afterAll(() => app.close());
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(accountsService.getAccount).mockResolvedValue({ id: ACC, householdId: 'hh-1' } as never);
  vi.mocked(valuations.saveValuation).mockResolvedValue({ id: VAL, accountId: ACC, date: '2026-09-30', amount: 100 });
  vi.mocked(valuations.listValuations).mockResolvedValue([]);
});

const put = (payload: unknown) => app.inject({ method: 'PUT', url: `/accounts/${ACC}/valuations`, payload: payload as object });

describe('market value routes', () => {
  it('lists for a member without needing the editor role', async () => {
    const res = await app.inject({ method: 'GET', url: `/accounts/${ACC}/valuations` });
    expect(res.statusCode).toBe(200);
    expect(requireHouseholdMember).toHaveBeenCalledWith(expect.anything(), 'hh-1');
    expect(requireEditor).not.toHaveBeenCalled();
  });

  // The response schema once turned the array into {"0": {...}}: the list must reach the client as a real array.
  it('answers the list as a JSON array', async () => {
    vi.mocked(valuations.listValuations).mockResolvedValue([
      { id: VAL, accountId: ACC, date: '2026-10-31', amount: 1620 },
      { id: 'v0', accountId: ACC, date: '2026-09-30', amount: 1050 },
    ]);
    const body = (await app.inject({ method: 'GET', url: `/accounts/${ACC}/valuations` })).json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.map((v: { amount: number }) => v.amount)).toEqual([1620, 1050]);
  });

  it('saving needs the editor role of the account household and uses that household', async () => {
    const res = await put({ date: '2026-09-30', amount: 100 });
    expect(res.statusCode).toBe(200);
    expect(requireEditor).toHaveBeenCalledWith(expect.anything(), 'hh-1');
    expect(valuations.saveValuation).toHaveBeenCalledWith(ACC, 'hh-1', { date: '2026-09-30', amount: 100 });
  });

  it('a viewer cannot save', async () => {
    vi.mocked(requireEditor).mockRejectedValueOnce(new ForbiddenError('no'));
    const res = await put({ date: '2026-09-30', amount: 100 });
    expect(res.statusCode).toBe(403);
    expect(valuations.saveValuation).not.toHaveBeenCalled();
  });

  it.each([[null], [false], [true], ['0x10'], ['']])('rejects amount %s instead of storing a zero', async (amount) => {
    const res = await put({ date: '2026-09-30', amount });
    expect(res.statusCode).toBe(400);
    expect(valuations.saveValuation).not.toHaveBeenCalled();
  });

  it('delete needs the editor role', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/accounts/${ACC}/valuations/${VAL}` });
    expect(res.statusCode).toBe(200);
    expect(requireEditor).toHaveBeenCalledWith(expect.anything(), 'hh-1');
    expect(valuations.deleteValuation).toHaveBeenCalledWith(ACC, 'hh-1', VAL);
  });
});
