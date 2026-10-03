import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError, ValidationError } from './app-error.js';
import { isProduction } from '../config/env.js';

/** Codes for the Fastify/plugin client errors that carry no AppError code of their own. */
const CLIENT_ERROR_CODES: Record<number, string> = {
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'TOO_MANY_REQUESTS',
};

interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, string[]>;
    stack?: string;
  };
}

/**
 * Centralized error handler for Fastify
 * Converts all errors to a consistent format
 */
export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  // Log error for debugging
  request.log.error(error);

  // Handle JSON parsing errors (SyntaxError from JSON.parse)
  if (error.name === 'SyntaxError' && error.message.includes('JSON')) {
    const response: ErrorResponse = {
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'Invalid JSON in request body',
        ...(!isProduction && { 
          details: { 
            _root: [error.message] 
          } 
        }),
      },
    };
    reply.status(400).send(response);
    return;
  }

  // Handle Zod validation errors
  if (error instanceof ZodError) {
    const details = formatZodError(error);
    const response: ErrorResponse = {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details,
      },
    };
    reply.status(400).send(response);
    return;
  }

  // Handle custom AppError
  if (error instanceof AppError) {
    const response: ErrorResponse = {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error instanceof ValidationError && { details: error.details }),
        ...(!isProduction && { stack: error.stack }),
      },
    };
    reply.status(error.statusCode).send(response);
    return;
  }

  // Handle Fastify validation errors (from schema validation)
  if ('validation' in error && error.validation) {
    const response: ErrorResponse = {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: error.message || 'Validation failed',
      },
    };
    reply.status(400).send(response);
    return;
  }

  // Database unique violations (Prisma P2002), e.g. a repeated sourceRef sent to the transactions API, are
  // conflicts the client caused, not server errors.
  if ((error as { code?: unknown }).code === 'P2002') {
    const response: ErrorResponse = {
      success: false,
      error: { code: 'CONFLICT', message: 'A record with the same unique value already exists' },
    };
    reply.status(409).send(response);
    return;
  }

  // Handle Fastify's own client errors (e.g. FST_REQ_FILE_TOO_LARGE from @fastify/multipart, 415, 429)
  // instead of reporting them as 500s.
  const statusCode = (error as FastifyError).statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    const response: ErrorResponse = {
      success: false,
      error: {
        code: CLIENT_ERROR_CODES[statusCode] ?? 'BAD_REQUEST',
        message: error.message,
      },
    };
    reply.status(statusCode).send(response);
    return;
  }

  // Handle unknown errors (return generic message in production)
  const response: ErrorResponse = {
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: isProduction ? 'An unexpected error occurred' : error.message,
      ...(!isProduction && { stack: error.stack }),
    },
  };
  reply.status(500).send(response);
}

/**
 * Format Zod errors into a user-friendly structure
 */
function formatZodError(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_root';
    if (!details[path]) {
      details[path] = [];
    }
    details[path].push(issue.message);
  }

  return details;
}





