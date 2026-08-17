import { createDb, getAppSqlClient, type Db } from '@sms/db';

let db: Db | undefined;

/**
 * The shared drizzle handle for Better Auth's global, non-RLS tables (see
 * the `0300_identity_auth.sql` header comment) plus `identity.session`
 * writes this module makes directly (`setActiveTenant`). Lazily created
 * over `@sms/db`'s pooled `sms_app` connection - the same connection every
 * other query in this codebase uses - and reused rather than constructing a
 * fresh drizzle wrapper per call.
 *
 * Deliberately not `withTenantTx`/`withSystemTx`: those exist to push
 * `app.tenant_id` etc. into the session for RLS, and these tables have no
 * RLS to satisfy (they are `@global` - identity is not tenant-scoped, only
 * `identity.membership` is, and that goes through `@sms/db` normally via
 * `MembershipService`).
 */
export function getIdentityDb(): Db {
  db ??= createDb(getAppSqlClient());
  return db;
}
