import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authMiddleware } from '../../shared/middleware/auth.middleware.js';
import { ensurePersonalHousehold, requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { NotFoundError } from '../../shared/errors/index.js';
import { assignCategorySchema, createGroupSchema, groupIdParamSchema, listGroupsQuerySchema, updateGroupSchema } from './category-groups.schema.js';
import * as service from './category-groups.service.js';

const envelope = { 200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true } } } };

/**
 * Spending groups above the expense categories (Casa, Pessoal, Dia a dia...). Reading is for any member; the defaults
 * are created on the first use. Writing (groups and the category -> group mapping) is for editors.
 */
export async function categoryGroupRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware());

  const editorOfGroup = async (request: FastifyRequest, groupId: string): Promise<string> => {
    const householdId = await service.findGroupHousehold(groupId);
    if (!householdId) throw new NotFoundError('Category group');
    await requireEditor(request, householdId);
    return householdId;
  };

  app.get('/', {
    schema: { description: 'Spending groups of a household with their categories, and the ungrouped expense categories', tags: ['Category groups'], security: [{ bearerAuth: [] }], response: envelope },
  }, async (request, reply) => {
    const query = listGroupsQuerySchema.parse(request.query);
    const householdId = query.householdId || (await ensurePersonalHousehold(request));
    await requireHouseholdMember(request, householdId);
    return reply.send({ success: true, data: await service.listGroups(householdId) });
  });

  app.post('/', {
    schema: { description: 'Create a spending group (EDITOR+)', tags: ['Category groups'], security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { householdId: given, ...body } = createGroupSchema.parse(request.body);
    const householdId = given || (await ensurePersonalHousehold(request));
    await requireEditor(request, householdId);
    return reply.status(201).send({ success: true, data: await service.createGroup(householdId, body) });
  });

  app.put('/assignments', {
    schema: { description: 'Put an expense category in a group, or back in "Outros" with groupId null (EDITOR+)', tags: ['Category groups'], security: [{ bearerAuth: [] }], response: envelope },
  }, async (request, reply) => {
    const body = assignCategorySchema.parse(request.body);
    const householdId = body.householdId || (await ensurePersonalHousehold(request));
    await requireEditor(request, householdId);
    return reply.send({ success: true, data: await service.assignCategory(householdId, body.categoryName, body.groupId) });
  });

  app.patch<{ Params: { groupId: string } }>('/:groupId', {
    schema: { description: 'Rename, recolor, reorder or mark a group as housing (EDITOR+)', tags: ['Category groups'], security: [{ bearerAuth: [] }], response: envelope },
  }, async (request, reply) => {
    const { groupId } = groupIdParamSchema.parse(request.params);
    const body = updateGroupSchema.parse(request.body);
    const householdId = await editorOfGroup(request, groupId);
    return reply.send({ success: true, data: await service.updateGroup(groupId, householdId, body) });
  });

  app.delete<{ Params: { groupId: string } }>('/:groupId', {
    schema: { description: 'Delete a group; its categories go back to "Outros" (EDITOR+)', tags: ['Category groups'], security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { groupId } = groupIdParamSchema.parse(request.params);
    const householdId = await editorOfGroup(request, groupId);
    await service.deleteGroup(groupId, householdId);
    return reply.send({ success: true });
  });
}
