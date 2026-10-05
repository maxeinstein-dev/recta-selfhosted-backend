import type { FastifyInstance } from 'fastify';

import { authMiddleware } from '../../shared/middleware/auth.middleware.js';
import { requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { organizeApplySchema, organizeOptionsSchema } from './organize.schema.js';
import { applyOrganize, previewOrganize } from './organize.service.js';

const docs = (description: string) => ({
  description,
  tags: ['People'],
  security: [{ bearerAuth: [] }],
});

/** /people/organize: the "organize splits" assistant (registered under the /people prefix). */
export async function organizeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware());

  app.post('/organize/preview', { schema: docs('Preview the shares and settlements the transaction notes and incomes imply; writes nothing (read: member)') }, async (request, reply) => {
    const input = organizeOptionsSchema.parse(request.body);
    await requireHouseholdMember(request, input.householdId);
    const data = await previewOrganize(input);
    return reply.send({ success: true, data });
  });

  app.post('/organize/apply', { schema: docs('Apply the chosen proposals, recomputed on the server in one database transaction (EDITOR+)') }, async (request, reply) => {
    const input = organizeApplySchema.parse(request.body);
    await requireEditor(request, input.householdId);
    const data = await applyOrganize(input);
    return reply.status(201).send({ success: true, data });
  });
}
