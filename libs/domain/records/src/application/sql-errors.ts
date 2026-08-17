import { ConflictError, ValidationError } from '@sms/kernel';

/**
 * Duplicated from `@sms/gradebook`'s `application/sql-errors.ts` rather than
 * imported - a package can only reach another workspace package's public
 * entrypoint, never a sibling's internal `application/*` file. See that copy
 * (and `@sms/attendance`'s / `@sms/access`'s) for the fuller reasoning; this
 * is the same helper.
 */
interface PostgresErrorLike {
  readonly code?: string;
  readonly constraint_name?: string;
  readonly message?: string;
}

// https://www.postgresql.org/docs/current/errcodes-appendix.html
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const NOT_NULL_VIOLATION = '23502';
const EXCLUSION_VIOLATION = '23P01';

function isPostgresErrorLike(error: unknown): error is PostgresErrorLike {
  return typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code: unknown }).code === 'string';
}

function unwrapCause(error: unknown): unknown {
  return error instanceof Error && error.cause !== undefined ? error.cause : error;
}

/**
 * Translates the Postgres constraint-violation error codes this module's
 * writes can hit - a duplicate run/idempotency key, a duplicate transcript
 * entry, an attempt to mutate an immutable version/append-only row - into the
 * `@sms/kernel` `DomainError` the REST layer already knows how to map to a
 * status code.
 */
export function toDomainError(error: unknown, fallbackMessage: string): Error {
  const cause = unwrapCause(error);
  if (!isPostgresErrorLike(cause)) {
    return error instanceof Error ? error : new Error(fallbackMessage);
  }
  const pgError = cause;

  const details = pgError.constraint_name ? { constraint: pgError.constraint_name } : undefined;

  switch (pgError.code) {
    case UNIQUE_VIOLATION:
    case EXCLUSION_VIOLATION:
      return new ConflictError(pgError.message ?? fallbackMessage, details);
    case CHECK_VIOLATION:
    case FOREIGN_KEY_VIOLATION:
    case NOT_NULL_VIOLATION:
      return new ValidationError(pgError.message ?? fallbackMessage, details);
    default:
      return error instanceof Error ? error : new Error(fallbackMessage);
  }
}
