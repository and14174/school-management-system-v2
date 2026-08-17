import { ConflictError, ValidationError } from '@sms/kernel';

/**
 * Duplicated from `@sms/billing`'s `application/sql-errors.ts` (itself
 * duplicated from `@sms/records`'/`@sms/gradebook`'s/`@sms/attendance`'s/
 * `@sms/access`'s) rather than imported - a package can only reach another
 * workspace package's public entrypoint, never a sibling's internal
 * `application/*` file.
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
// plpgsql `raise exception` with no explicit SQLSTATE - this module's own
// triggers (trg_forbid_self_decision, trg_forbid_request_mutation,
// trg_forbid_decision_mutation) all raise this way. Only reachable here when
// something bypasses ApprovalsService's own app-level checks (which exist
// precisely so a caller sees a clean error before ever reaching the
// database) - see the `1700` migration header.
const RAISE_EXCEPTION = 'P0001';

function isPostgresErrorLike(error: unknown): error is PostgresErrorLike {
  return typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code: unknown }).code === 'string';
}

function unwrapCause(error: unknown): unknown {
  return error instanceof Error && error.cause !== undefined ? error.cause : error;
}

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
    case RAISE_EXCEPTION:
      return new ValidationError(pgError.message ?? fallbackMessage, details);
    default:
      return error instanceof Error ? error : new Error(fallbackMessage);
  }
}
