import { createDb, getAppSqlClient, type Db } from '@sms/db';

let db: Db | undefined;

/**
 * The shared drizzle handle for `access.permission` - the one table in this
 * module with no RLS to satisfy (`@global`, see the `0400` migration). Same
 * reasoning and shape as `@sms/identity`'s `infrastructure/db.ts` /
 * `getIdentityDb()`: deliberately not `withTenantTx`/`withSystemTx`, since
 * this table has no tenant scoping for either to enforce, and `withSystemTx`
 * must never be reachable from request-handling code (`GET /access/
 * permissions` is exactly that).
 */
export function getAccessDb(): Db {
  db ??= createDb(getAppSqlClient());
  return db;
}
