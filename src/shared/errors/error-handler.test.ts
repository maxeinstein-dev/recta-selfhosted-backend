import { describe, expect, it, vi } from 'vitest';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

import { BadRequestError } from './app-error.js';
import { errorHandler } from './error-handler.js';

function run(error: Error | FastifyError) {
  const send = vi.fn();
  const status = vi.fn(() => ({ send }));
  const reply = { status } as unknown as FastifyReply;
  const request = { log: { error: vi.fn() } } as unknown as FastifyRequest;
  errorHandler(error, request, reply);
  return { status, send };
}

function fastifyError(statusCode: number, code: string, message: string): FastifyError {
  return Object.assign(new Error(message), { statusCode, code }) as FastifyError;
}

describe('errorHandler', () => {
  it('reports an upload over the multipart limit as 413 instead of 500', () => {
    const { status, send } = run(fastifyError(413, 'FST_REQ_FILE_TOO_LARGE', 'request file too large'));

    expect(status).toHaveBeenCalledWith(413);
    expect(send).toHaveBeenCalledWith({
      success: false,
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'request file too large' },
    });
  });

  it('keeps other Fastify client errors as 4xx with the same envelope', () => {
    const { status, send } = run(fastifyError(415, 'FST_ERR_CTP_INVALID_MEDIA_TYPE', 'Unsupported Media Type'));

    expect(status).toHaveBeenCalledWith(415);
    expect(send).toHaveBeenCalledWith({
      success: false,
      error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported Media Type' },
    });
  });

  it('reports a rate limit as 429 TOO_MANY_REQUESTS', () => {
    const { status, send } = run(fastifyError(429, 'FST_ERR_RATE_LIMIT', 'Rate limit exceeded'));

    expect(status).toHaveBeenCalledWith(429);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ error: { code: 'TOO_MANY_REQUESTS' } });
  });

  it('reports a database unique violation (Prisma P2002) as a 409 conflict instead of a 500', () => {
    const violation = Object.assign(new Error('Unique constraint failed on transactions_household_id_source_ref_key'), {
      code: 'P2002',
    });

    const { status, send } = run(violation);

    expect(status).toHaveBeenCalledWith(409);
    expect(send).toHaveBeenCalledWith({
      success: false,
      error: { code: 'CONFLICT', message: 'A record with the same unique value already exists' },
    });
  });

  it('still answers application errors with their own status and code', () => {
    const { status, send } = run(new BadRequestError('nope'));

    expect(status).toHaveBeenCalledWith(400);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ success: false, error: { code: 'BAD_REQUEST', message: 'nope' } });
  });

  it('still answers unknown errors with 500', () => {
    const { status, send } = run(new Error('boom'));

    expect(status).toHaveBeenCalledWith(500);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });

  it('does not turn a 5xx Fastify error into a client error', () => {
    const { status } = run(fastifyError(503, 'FST_ERR_SOMETHING', 'unavailable'));

    expect(status).toHaveBeenCalledWith(500);
  });
});
