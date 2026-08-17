import { ConflictError, ValidationError } from '@sms/kernel';

/**
 * Duplicated from `@sms/tenancy`'s / `@sms/identity`'s `application/sql-
 * errors.ts` rather than imported - a package can only reach another
 * workspace package's public entrypoint, never a sibling's internal
 * `application/*` file, and this helper is small enough that duplicating it
 * is cheaper than promoting it to a shared package for three callers.
 *
 * Shape of the errors `postgres` (the driver `@sms/db` wraps) throws - see
 * `PostgresError` in the `postgres` package. Duck-typed rather than
 * imported: this package does not depend on `postgres` directly (only
 * `@sms/db` may, per the `no-restricted-imports` ESLint rule).
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

/**
 * drizzle-orm wraps every driver error in its own `DrizzleQueryError`,
 * preserving the original `postgres` `PostgresError` on `.cause`. Unwrap one
 * level before duck-typing.
 */
function unwrapCause(error: unknown): unknown {
  return error instanceof Error && error.cause !== undefined ? error.cause : error;
}

/**
 * Translates the Postgres constraint-violation error codes this module's
 * writes can hit - duplicate `(tenant_id, key)` role, the
 * `role_assignment_no_overlap` exclusion constraint, the
 * `impersonation_one_active_per_actor` partial unique index, the
 * `check_role_permission_tenant`/`check_role_assignment_tenant` trigger
 * checks - into the `@sms/kernel` `DomainError` the REST layer already knows
 * how to map to a status code.
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
