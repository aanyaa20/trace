import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { AppError, isAppError } from '../errors.js';

interface FastifyLikeError {
  code?: string;
  message?: string;
  statusCode?: number;
}

function asAppError(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error instanceof ZodError) {
    return new AppError(400, 'validation_failed', 'request failed schema validation', error.issues);
  }

  const candidate = error as FastifyLikeError;
  if (candidate?.code === 'FST_REQ_FILE_TOO_LARGE') {
    return new AppError(413, 'payload_too_large', 'file exceeds MAX_UPLOAD_BYTES');
  }
  if (candidate?.code === 'FST_ERR_VALIDATION') {
    return new AppError(400, 'validation_failed', candidate.message ?? 'invalid request');
  }
  // Any other framework error that already carries a client status — a
  // malformed or empty JSON body, an unsupported media type — is the client
  // being told no, not the server breaking. Reporting it as a 500 hid the
  // real cause behind "unhandled server error".
  if (
    typeof candidate?.statusCode === 'number' &&
    candidate.statusCode >= 400 &&
    candidate.statusCode < 500 &&
    candidate.code?.startsWith('FST_')
  ) {
    return new AppError(
      candidate.statusCode,
      'bad_request',
      candidate.message ?? 'invalid request',
    );
  }

  return new AppError(500, 'internal_error', 'unhandled server error');
}

export default fp(
  async (app) => {
    app.setErrorHandler((error, request, reply) => {
      const appError = asAppError(error);

      // 5xx means we broke something and the stack matters; 4xx is the client
      // being told no, which is routine.
      if (appError.statusCode >= 500) {
        request.log.error({ err: error, route: request.routeOptions.url }, appError.message);
      } else {
        request.log.warn({ code: appError.code, route: request.routeOptions.url }, appError.message);
      }

      void reply.status(appError.statusCode).send({
        code: appError.code,
        message: appError.message,
        ...(appError.details === undefined ? {} : { details: appError.details }),
      });
    });

    app.setNotFoundHandler((request, reply) => {
      void reply.status(404).send({
        code: 'not_found',
        message: `no route for ${request.method} ${request.url}`,
      });
    });
  },
  { name: 'trace-error-handler' },
);
