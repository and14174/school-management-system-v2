import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { requireEnv } from './env.js';

export type Sql = postgres.Sql;
export type Db = ReturnType<typeof drizzle>;
/** The transaction-bound handle drizzle hands to a `db.transaction()` callback. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Builds a fresh postgres.js client against `url`. Callers own its lifecycle (`sql.end()`). */
export function createSqlClient(url: string): Sql {
  // DATABASE_POOL_MAX is intentionally not in .env.example - it defaults to
  // postgres.js's own default (10) and only needs to be set to force
  // deterministic single-connection behaviour, which the withTenantTx
  // pooling-leak test relies on.
  const maxConnections = process.env.DATABASE_POOL_MAX ? Number(process.env.DATABASE_POOL_MAX) : undefined;

  return postgres(url, {
    max: maxConnections,
    // Silence NOTICE spam from the migration runner's IF NOT EXISTS / ON CONFLICT statements.
    onnotice: () => {},
  });
}

export function createDb(sql: Sql): Db {
  return drizzle(sql);
}

let appSql: Sql | undefined;

/**
 * The pooled client the API connects with, as `sms_app` (see `DATABASE_URL`
 * in `.env.example`) - no table ownership, `NOBYPASSRLS`. Lazily created
 * and reused; every tenant-scoped query MUST go through `withTenantTx` so
 * `app.tenant_id` etc. are set before RLS policies evaluate anything.
 */
export function getAppSqlClient(): Sql {
  appSql ??= createSqlClient(requireEnv('DATABASE_URL'));
  return appSql;
}

let migrationSql: Sql | undefined;

/**
 * The client used for schema migrations and other system-level work, as
 * `sms_owner` (see `DATABASE_MIGRATION_URL`). Table owners bypass RLS by
 * default in Postgres, which is exactly why this must never be used to
 * serve a tenant request.
 */
export function getMigrationSqlClient(): Sql {
  migrationSql ??= createSqlClient(requireEnv('DATABASE_MIGRATION_URL'));
  return migrationSql;
}

/** Closes both pooled clients, if they were ever created. For tests and graceful shutdown. */
export async function closeSqlClients(): Promise<void> {
  await Promise.all([appSql?.end({ timeout: 5 }), migrationSql?.end({ timeout: 5 })]);
  appSql = undefined;
  migrationSql = undefined;
}
