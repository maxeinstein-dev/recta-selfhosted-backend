import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { ensurePersonalHousehold, requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import * as service from './category-groups.service.js';
import { categoryGroupRoutes } from './category-groups.routes.js';

// Invented data only. The service is mocked: these tests pin who may call what, and what reaches the service.
vi.mock('../../shared/middleware/auth.middleware.js', () => ({
  authMiddleware: () => async (request: { headers: Record<string, string | undefined> }) => {
    if (!request.headers.authorization) throw new (await import('../../shared/errors/app-error.js')).UnauthorizedError();
  },
  getAuthUser: () => ({ uid: 'firebase-1', email: 'user@example.com' }),
}));
vi.mock('../../shared/middleware/authorization.middleware.js', () => ({
  requireHouseholdMember: vi.fn(),
  requireEditor: vi.fn(),
  ensurePersonalHousehold: vi.fn(),
}));
vi.mock('./category-groups.service.js', () => ({
  listGroups: vi.fn(),
  createGroup: vi.fn(),
  updateGroup: vi.fn(),
  deleteGroup: vi.fn(),
  assignCategory: vi.fn(),
  findGroupHousehold: vi.fn(),
}));

const HH = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const AUTH = { authorization: 'Bearer test' };
const m = {
  member: vi.mocked(requireHouseholdMember),
  editor: vi.mocked(requireEditor),
  personal: vi.mocked(ensurePersonalHousehold),
  list: vi.mocked(service.listGroups),
  create: vi.mocked(service.createGroup),
  update: vi.mocked(service.updateGroup),
  remove: vi.mocked(service.deleteGroup),
  assign: vi.mocked(service.assignCategory),
  owner: vi.mocked(service.findGroupHousehold),
};

describe('category group routes', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(categoryGroupRoutes, { prefix: '/category-groups' });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    m.member.mockResolvedValue({} as never);
    m.editor.mockResolvedValue({} as never);
    m.personal.mockResolvedValue(HH);
    m.list.mockResolvedValue({ groups: [], ungrouped: [] } as never);
    m.create.mockResolvedValue({ id: GROUP } as never);
    m.update.mockResolvedValue({ id: GROUP } as never);
    m.remove.mockResolvedValue(undefined as never);
    m.assign.mockResolvedValue({ categoryName: 'FOOD', groupId: GROUP } as never);
    m.owner.mockResolvedValue(HH);
  });
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = AUTH) =>
    app.inject({ method, url: `/category-groups${url}`, headers, ...(payload !== undefined && { payload: payload as object }) });

  it('answers 401 without credentials', async () => {
    expect((await call('GET', `?householdId=${HH}`, undefined, {})).statusCode).toBe(401);
    expect(m.list).not.toHaveBeenCalled();
  });

  it('lists the groups of a household for any member, falling back to the personal household', async () => {
    const res = await call('GET', `?householdId=${HH}`);
    expect(res.statusCode).toBe(200);
    expect(m.member).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.list).toHaveBeenCalledWith(HH);
    expect(res.json()).toEqual({ success: true, data: { groups: [], ungrouped: [] } });
    await call('GET', '');
    expect(m.list).toHaveBeenLastCalledWith(HH);
  });

  it('lists nothing for someone outside the household', async () => {
    m.member.mockRejectedValue(new ForbiddenError('no'));
    expect((await call('GET', `?householdId=${HH}`)).statusCode).toBe(403);
    expect(m.list).not.toHaveBeenCalled();
  });

  it('creates a group as an editor only, with a trimmed name', async () => {
    const res = await call('POST', '', { householdId: HH, name: '  Pets ', color: '#112233', isHousing: false });
    expect(res.statusCode).toBe(201);
    expect(m.editor).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.create).toHaveBeenCalledWith(HH, { name: 'Pets', color: '#112233', isHousing: false });
    m.editor.mockRejectedValue(new ForbiddenError('viewer'));
    expect((await call('POST', '', { householdId: HH, name: 'Outro' })).statusCode).toBe(403);
    expect(m.create).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty name, a bad color and the reserved name Outros', async () => {
    expect((await call('POST', '', { householdId: HH, name: '   ' })).statusCode).toBe(400);
    expect((await call('POST', '', { householdId: HH, name: 'X', color: 'red' })).statusCode).toBe(400);
    expect((await call('POST', '', { householdId: HH, name: 'outros' })).statusCode).toBe(400);
    expect((await call('PATCH', `/${GROUP}`, { name: 'Outros' })).statusCode).toBe(400);
    expect(m.create).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  it('updates and deletes a group after checking the editor role of the group own household', async () => {
    expect((await call('PATCH', `/${GROUP}`, { isHousing: true, sortOrder: 2 })).statusCode).toBe(200);
    expect(m.owner).toHaveBeenCalledWith(GROUP);
    expect(m.editor).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.update).toHaveBeenCalledWith(GROUP, HH, { isHousing: true, sortOrder: 2 });
    expect((await call('DELETE', `/${GROUP}`)).statusCode).toBe(200);
    expect(m.remove).toHaveBeenCalledWith(GROUP, HH);
  });

  it('answers 404 for a group that does not exist, before any write', async () => {
    m.owner.mockResolvedValue(null);
    expect((await call('PATCH', `/${GROUP}`, { name: 'X' })).statusCode).toBe(404);
    expect((await call('DELETE', `/${GROUP}`)).statusCode).toBe(404);
    expect(m.update).not.toHaveBeenCalled();
    expect(m.remove).not.toHaveBeenCalled();
  });

  it('assigns a category to a group, or back to Outros with a null group, as an editor', async () => {
    expect((await call('PUT', '/assignments', { householdId: HH, categoryName: 'FOOD', groupId: GROUP })).statusCode).toBe(200);
    expect(m.assign).toHaveBeenCalledWith(HH, 'FOOD', GROUP);
    expect((await call('PUT', '/assignments', { householdId: HH, categoryName: 'CUSTOM:33333333-3333-4333-8333-333333333333', groupId: null })).statusCode).toBe(200);
    expect(m.assign).toHaveBeenLastCalledWith(HH, 'CUSTOM:33333333-3333-4333-8333-333333333333', null);
    expect(m.editor).toHaveBeenCalledWith(expect.anything(), HH);
  });

  it('refuses a malformed category name or group id', async () => {
    expect((await call('PUT', '/assignments', { householdId: HH, categoryName: 'NOPE', groupId: GROUP })).statusCode).toBe(400);
    expect((await call('PUT', '/assignments', { householdId: HH, categoryName: 'FOOD', groupId: 'x' })).statusCode).toBe(400);
    expect((await call('PUT', '/assignments', { householdId: HH, categoryName: 'FOOD' })).statusCode).toBe(400);
    expect(m.assign).not.toHaveBeenCalled();
  });
});
