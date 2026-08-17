import { ConflictError, ValidationError } from '@sms/kernel';

/**
 * Duplicated from `@sms/tenancy`'s `application/sql-errors.ts` rather than
 * imported: a package can only reach another workspace package's public
 * entrypoint (`@nx/enforce-module-boundaries` + each package's `exports`
 * field), never a sibling's internal `application/*` file, and this helper
 * is small enough that duplicating it is cheaper than promoting it to a
 * shared package for one caller apiece.
 *
 * Shape of the errors `postgres` (the driver `@sms/db` wraps) throws - see
 * `PostgresError` in the `postgres` package, which is `Object.assign`ed from
 * the wire-protocol error fields (`code`, `constraint_name`, `message`, ...).
 * Duck-typed rather than imported: this package does not depend on
 * `postgres` directly (only `@sms/db` may, per the `no-restricted-imports`
 * ESLint rule), so there is no type to import from here.
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

function isPostgresErrorLike(error: unknown): error is PostgresErrorLike {
  return typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code: unknown }).code === 'string';
}

/**
 * drizzle-orm wraps every driver error in its own `DrizzleQueryError`
 * (message "Failed query: ..."), preserving the original `postgres`
 * `PostgresError` - with the `code`/`constraint_name` fields this function
 * actually needs - on `.cause` (ES2022 error chaining) rather than at the
 * top level. Unwrap one level before duck-typing.
 */
function unwrapCause(error: unknown): unknown {
  return error instanceof Error && error.cause !== undefined ? error.cause : error;
}

/**
 * Translates the handful of Postgres constraint-violation error codes this
 * module's writes can hit (duplicate `(user_id, tenant_id)` membership, a
 * bad `status` check) into the `@sms/kernel` `DomainError` the REST layer
 * already knows how to map to a status code. Anything else is rethrown as-is
 * so it surfaces as a genuine 500 rather than being mislabelled.
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
      return new ConflictError(pgError.message ?? fallbackMessage, details);
    case CHECK_VIOLATION:
    case FOREIGN_KEY_VIOLATION:
    case NOT_NULL_VIOLATION:
      return new ValidationError(pgError.message ?? fallbackMessage, details);
    default:
      return error instanceof Error ? error : new Error(fallbackMessage);
  }
}
