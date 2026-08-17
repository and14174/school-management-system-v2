import { sql } from 'drizzle-orm';
import type { TenantContext } from '@sms/kernel';
import { createDb, getAppSqlClient, getMigrationSqlClient, type Tx } from './client.js';

/**
 * Runs `fn` inside a transaction opened as `sms_app`, with the tenant's
 * request-scoped identifiers pushed into the Postgres session so row-level
 * security policies can see them. This is the single most important
 * function in the codebase - it is the only legal way to touch the
 * database for a tenant request (enforced by the `no-restricted-imports`
 * ESLint rule banning direct `postgres` imports outside this package).
 *
 * THE BUG THAT ENDS THE COMPANY: this uses `set_config(name, value, true)`
 * - the third argument, `is_local = true`, is what makes Postgres treat
 * this as `SET LOCAL` instead of plain `SET`. `SET LOCAL` is scoped to the
 * current transaction and is automatically unset at COMMIT/ROLLBACK. Plain
 * `SET` is scoped to the *session* (the physical connection) - and
 * connections are drawn from a pool and reused across requests. If this
 * ever used plain `SET`, tenant A's `app.tenant_id` could still be set on
 * the pooled connection when it's handed to tenant B's next request, and
 * every RLS policy that trusts `app.tenant_id` would silently leak tenant
 * A's rows into tenant B's response. Never change `true` to `false` here,
 * and never build this string by interpolating values directly into SQL -
 * `set_config` is called with bound parameters for the same reason every
 * other query is: this is user-influenced data (tenant/campus/person ids
 * ultimately trace back to a session), and string interpolation here would
 * be a SQL injection vector on top of the leakage risk.
 */
export async function withTenantTx<T>(ctx: TenantContext, fn: (db: Tx) => Promise<T>): Promise<T> {
  const db = createDb(getAppSqlClient());

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${ctx.tenantId}, true)`);
    await tx.execute(sql`select set_config('app.person_id', ${ctx.personId ?? ''}, true)`);
    await tx.execute(sql`select set_config('app.campus_id', ${ctx.campusId ?? ''}, true)`);
    await tx.execute(sql`select set_config('app.request_id', ${ctx.requestId}, true)`);
    // The REAL human, not the impersonation target - this is what audit stamps
    // as changed_by. Falls back to the effective user so an ordinary request
    // (where the two are the same) is never left unattributed.
    await tx.execute(
      sql`select set_config('app.actor_user_id', ${ctx.actorUserId ?? ctx.userId ?? ''}, true)`,
    );

    return fn(tx);
  });
}

/**
 * Runs `fn` inside a transaction opened as `sms_owner` (see
 * `DATABASE_MIGRATION_URL`) - for schema migrations and system jobs that
 * legitimately have no tenant, ever. Table owners bypass row-level
 * security in Postgres by default, so this deliberately bypasses tenant
 * scoping entirely. It must never be reachable from request-handling code;
 * only migration scripts and system-level background jobs (see
 * `SystemContext` in `@sms/kernel`) may call it.
 */
export async function withSystemTx<T>(fn: (db: Tx) => Promise<T>): Promise<T> {
  const db = createDb(getMigrationSqlClient());

  return db.transaction(async (tx) => fn(tx));
}

/**
 * Runs `fn` as `sms_app` with ONLY `app.user_id` set - no tenant.
 *
 * Authentication has a bootstrapping problem: to resolve which tenant a request
 * belongs to, the system must first look up the signed-in user's memberships,
 * which happens before any tenant is known. The obvious shortcut is
 * `withSystemTx`, but that connects as the table owner and therefore bypasses
 * every row-level security policy in the database - putting the single most
 * security-sensitive path in the product outside all tenant isolation. Its own
 * documentation says it must never be reachable from request handling; this
 * exists so that stays true.
 *
 * RLS policies are permissive (OR-ed together), so the self-read policy this
 * enables does not widen tenant isolation: it exposes only rows belonging to
 * this user, and only on tables that explicitly opt in by writing a policy
 * against `app.user_id`. Everything else remains invisible, because no
 * `app.tenant_id` is set.
 */
export async function withAuthTx<T>(userId: string, fn: (db: Tx) => Promise<T>): Promise<T> {
  const db = createDb(getAppSqlClient());

  return db.transaction(async (tx) => {
    // `is_local = true` for exactly the reason spelled out on withTenantTx:
    // pooled connections are reused across requests.
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);

    return fn(tx);
  });
}
