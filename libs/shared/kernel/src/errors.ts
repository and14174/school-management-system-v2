/**
 * Base class for every expected, named failure mode in the system. Each
 * subclass carries a stable `code` string (never renamed - clients and the
 * `apps/api` exception filter key off it) and an optional `details` payload.
 * The filter in `apps/api/src/common/filters` maps these to HTTP responses.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    // Not available in every runtime (e.g. some edge workers), guard it.
    Error.captureStackTrace?.(this, new.target);
  }
}

export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
}

export class ConflictError extends DomainError {
  readonly code = 'CONFLICT';
}

export class ForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
}

export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';
}

export class PreconditionFailedError extends DomainError {
  readonly code = 'PRECONDITION_FAILED';
}
