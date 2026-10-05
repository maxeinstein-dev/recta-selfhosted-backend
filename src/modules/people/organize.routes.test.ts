import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError, InsufficientRoleError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { organizeRoutes } from './organize.routes.js';
import { applyOrganize, previewOrganize } from './organize.service.js';

vi.mock('../../shared/middleware/auth.middleware.js', () => ({
  authMiddleware: () => async (request: { headers: Record<string, string | undefined> }) => {
    if (!request.headers.authorization) throw new (await import('../../shared/errors/app-error.js')).UnauthorizedError();
  },
  getAuthUser: () => ({ uid: 'firebase-1', email: 'user@example.com' }),
}));
vi.mock('../../shared/middleware/authorization.middleware.js', () => ({
  requireEditor: vi.fn(),
  requireHouseholdMember: vi.fn(),
}));
vi.mock('./organize.service.js', () => ({ previewOrganize: vi.fn(), applyOrganize: vi.fn() }));

const HH = '11111111-1111-4111-8111-111111111111';
const PERSON = '22222222-2222-4222-8222-222222222222';
const TX = '33333333-3333-4333-8333-333333333333';
const AUTH = { authorization: 'Bearer test' };

const mockedEditor = vi.mocked(requireEditor);
const mockedMember = vi.mocked(requireHouseholdMember);
const mockedPreview = vi.mocked(previewOrganize);
const mockedApply = vi.mocked(applyOrganize);

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  await app.register(organizeRoutes, { prefix: '/people' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.resetAllMocks();
  mockedEditor.mockResolvedValue({} as never);
  mockedMember.mockResolvedValue({} as never);
  mockedPreview.mockResolvedValue({ proposals: [] } as never);
  mockedApply.mockResolvedValue({ peopleCreated: 0 } as never);
});

const post = (url: string, payload: unknown, headers: Record<string, string> = AUTH) =>
  app.inject({ method: 'POST', url, payload: payload as never, headers });

const applyBody = { householdId: HH, people: [], proposalIds: [], settlementIds: [], manual: [] };

describe('POST /people/organize/preview', () => {
  it('needs membership of the household, then answers { success, data }', async () => {
    const res = await post('/people/organize/preview', { householdId: HH, startDate: '2026-10-01', endDate: '2026-10-31', onlyImported: true });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { proposals: [] } });
    expect(mockedMember).toHaveBeenCalledWith(expect.anything(), HH);
    expect(mockedEditor).not.toHaveBeenCalled();
    expect(mockedPreview).toHaveBeenCalledWith({ householdId: HH, startDate: '2026-10-01', endDate: '2026-10-31', onlyImported: true });
  });

  it('is 401 without credentials and 403 for a non-member, before anything is read', async () => {
    expect((await post('/people/organize/preview', { householdId: HH }, {})).statusCode).toBe(401);
    mockedMember.mockRejectedValue(new ForbiddenError());
    expect((await post('/people/organize/preview', { householdId: HH })).statusCode).toBe(403);
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it.each([
    ['no household', {}],
    ['household not a uuid', { householdId: 'x' }],
    ['a day that does not exist', { householdId: HH, startDate: '2026-13-01' }],
    ['a date in another format', { householdId: HH, endDate: '31/10/2026' }],
    ['onlyImported not a boolean', { householdId: HH, onlyImported: 'yes' }],
  ])('rejects %s (400)', async (_name, body) => {
    const res = await post('/people/organize/preview', body);
    expect(res.statusCode).toBe(400);
    expect(mockedPreview).not.toHaveBeenCalled();
  });
});

describe('POST /people/organize/apply', () => {
  it('needs an editor, answers 201 and passes the validated body', async () => {
    const res = await post('/people/organize/apply', applyBody);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ success: true, data: { peopleCreated: 0 } });
    expect(mockedEditor).toHaveBeenCalledWith(expect.anything(), HH);
    expect(mockedEditor.mock.invocationCallOrder[0]!).toBeLessThan(mockedApply.mock.invocationCallOrder[0]!);
    expect(mockedApply).toHaveBeenCalledWith(applyBody);
  });

  it('is 401 without credentials, and 403 for a viewer or non-member, before anything is written', async () => {
    expect((await post('/people/organize/apply', applyBody, {})).statusCode).toBe(401);
    mockedEditor.mockRejectedValue(new InsufficientRoleError());
    const viewer = await post('/people/organize/apply', applyBody);
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json()).toMatchObject({ error: { code: 'INSUFFICIENT_ROLE' } });
    mockedEditor.mockRejectedValue(new ForbiddenError());
    expect((await post('/people/organize/apply', applyBody)).statusCode).toBe(403);
    expect(mockedApply).not.toHaveBeenCalled();
  });

  it('defaults the lists to empty', async () => {
    await post('/people/organize/apply', { householdId: HH });
    expect(mockedApply).toHaveBeenCalledWith(applyBody);
  });

  it('accepts bodies at the caps', async () => {
    const res = await post('/people/organize/apply', {
      ...applyBody,
      people: Array.from({ length: 200 }, (_, i) => ({ name: `p${i}` })),
      proposalIds: Array.from({ length: 10_000 }, (_, i) => `p${i}`),
      settlementIds: Array.from({ length: 10_000 }, (_, i) => `s${i}`),
      manual: Array.from({ length: 2_000 }, () => ({ transactionId: TX, personId: PERSON, direction: 'THEY_OWE_ME', amount: 1 })),
    });
    expect(res.statusCode).toBe(201);
  });

  it.each([
    ['too many proposal ids', { ...applyBody, proposalIds: Array.from({ length: 10_001 }, (_, i) => `p${i}`) }],
    ['too many settlement ids', { ...applyBody, settlementIds: Array.from({ length: 10_001 }, (_, i) => `s${i}`) }],
    ['a proposal id that is too long', { ...applyBody, proposalIds: ['x'.repeat(301)] }],
    ['an empty proposal id', { ...applyBody, proposalIds: [''] }],
    ['too many manual lines', { ...applyBody, manual: Array.from({ length: 2_001 }, () => ({ transactionId: TX, personId: PERSON, direction: 'THEY_OWE_ME', amount: 1 })) }],
    ['a manual line without a person', { ...applyBody, manual: [{ transactionId: TX, direction: 'THEY_OWE_ME', amount: 1 }] }],
    ['a manual line with a bad direction', { ...applyBody, manual: [{ transactionId: TX, personId: PERSON, direction: 'MAYBE', amount: 1 }] }],
    ['a manual amount of zero', { ...applyBody, manual: [{ transactionId: TX, personId: PERSON, direction: 'THEY_OWE_ME', amount: 0 }] }],
    ['a manual amount above the cap', { ...applyBody, manual: [{ transactionId: TX, personId: PERSON, direction: 'THEY_OWE_ME', amount: 1_000_000_001 }] }],
    ['a manual transaction that is not a uuid', { ...applyBody, manual: [{ transactionId: 'x', personId: PERSON, direction: 'THEY_OWE_ME', amount: 1 }] }],
    ['too many people', { ...applyBody, people: Array.from({ length: 201 }, (_, i) => ({ name: `p${i}` })) }],
    ['a person name that is too long', { ...applyBody, people: [{ name: 'x'.repeat(101) }] }],
    ['too many aliases', { ...applyBody, people: [{ name: 'Bia', aliases: Array.from({ length: 21 }, (_, i) => `a${i}`) }] }],
    ['an existingId that is not a uuid', { ...applyBody, people: [{ name: 'Bia', existingId: 'x' }] }],
    ['a period that does not exist', { ...applyBody, endDate: '2026-02-30' }],
  ])('rejects %s (400) without calling the service', async (_name, body) => {
    const res = await post('/people/organize/apply', body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    expect(mockedApply).not.toHaveBeenCalled();
  });
});
