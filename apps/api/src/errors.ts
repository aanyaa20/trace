/**
 * Every error crossing a route boundary is one of these. Status and stable
 * code travel with the error, so the handler never guesses what was thrown.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError(400, 'bad_request', message, details);

export const unauthorized = (message = 'authentication required'): AppError =>
  new AppError(401, 'unauthorized', message);

export const forbidden = (message = 'not permitted'): AppError =>
  new AppError(403, 'forbidden', message);

export const notFound = (what: string): AppError =>
  new AppError(404, 'not_found', `${what} not found`);

export const conflict = (message: string): AppError => new AppError(409, 'conflict', message);

export const payloadTooLarge = (message: string): AppError =>
  new AppError(413, 'payload_too_large', message);

export const unsupportedMedia = (mime: string): AppError =>
  new AppError(415, 'unsupported_media_type', `unsupported file type: ${mime}`);

export const upstreamFailure = (service: string, message: string): AppError =>
  new AppError(502, 'upstream_failure', `${service}: ${message}`);

export const internal = (message: string, details?: unknown): AppError =>
  new AppError(500, 'internal_error', message, details);

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Narrows an unknown catch binding without discarding the original stack. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : JSON.stringify(value));
}
