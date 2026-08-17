import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql as rawSql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '@sms/kernel';
import { closeSqlClients, getAppSqlClient } from './client.js';
import { withTenantTx } from './tx.js';

/**
 * This is the guard against the pooling bug described in `tx.ts`: it proves
 * `withTenantTx` really uses `SET LOCAL` (via `set_config(..., true)`) and
 * not plain `SET`. A real Postgres is required - a hand-rolled fake `SET`
 * implementation would happily pass, which is exactly the failure mode
 * this exists to catch. Exercises the real `withTenantTx` export, not a
 * reimplementation of it.
 */
describe('withTenantTx (real Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: postgres.Sql;

  const tenantId = (value: string) => value as TenantContext['tenantId'];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('sms_test')
      .withUsername('sms_owner')
      .withPassword('dev')
      .start();

    const ownerUrl = container.getConnectionUri();
    ownerSql = postgres(ownerUrl, { max: 1 });

    // Minimal stand-in for infra/postgres/init/01-roles-and-extensions.sql:
    // a non-owner app role, so table-owner RLS bypass can't mask a bug here.
    await ownerSql`create role sms_app with login password 'dev' nobypassrls`;
    await ownerSql`grant connect on database sms_test to sms_app`;
    await ownerSql`grant usage on schema public to sms_app`;
    await ownerSql`
      create table probe (
        id serial primary key,
        seen_tenant_id text not null
      )
    `;
    await ownerSql`grant select, insert on probe to sms_app`;
    await ownerSql`grant usage, select on all sequences in schema public to sms_app`;

    const appUrl = new URL(ownerUrl);
    appUrl.username = 'sms_app';
    appUrl.password = 'dev';

    // Point the real withTenantTx() singleton at this container, and force
    // a single-connection pool so sequential calls are guaranteed to reuse
    // the exact same physical connection - the scenario the pooling bug
    // (plain SET leaking across pooled connections) depends on.
    process.env.DATABASE_URL = appUrl.toString();
    process.env.DATABASE_POOL_MAX = '1';
  }, 120_000);

  afterAll(async () => {
    await closeSqlClients();
    await ownerSql?.end({ timeout: 1 });
    await container?.stop();
    delete process.env.DATABASE_POOL_MAX;
  });

  it('sets app.tenant_id inside the transaction', async () => {
    const ctx: TenantContext = { tenantId: tenantId('tenant-a'), roles: [], requestId: 'req-1' };

    const seenInsideTx = await withTenantTx(ctx, async (db) => {
      const rows = (await db.execute(
        rawSql`select current_setting('app.tenant_id', true) as tenant_id`,
      )) as unknown as Array<{ tenant_id: string | null }>;
      return rows[0]?.tenant_id ?? null;
    });

    expect(seenInsideTx).toBe('tenant-a');
  });

  it('is NOT visible on the same pooled connection after commit - proves it is SET LOCAL, not SET', async () => {
    const ctx: TenantContext = { tenantId: tenantId('tenant-b'), roles: [], requestId: 'req-2' };

    await withTenantTx(ctx, async (db) => {
      await db.execute(rawSql`select 1`); // just needs a transaction to have happened and committed
    });

    // Pool is forced to max:1, so this reuses the exact connection the
    // transaction above ran on. If withTenantTx used plain SET instead of
    // SET LOCAL, app.tenant_id would still read 'tenant-b' here.
    //
    // Note on the exact value: Postgres represents "this custom GUC was
    // never set at session scope" as NULL only the very first time a
    // placeholder is touched in a backend session; once SET LOCAL has
    // created the placeholder (as an earlier test in this file already
    // did), its post-commit reset value is '' rather than NULL. Either way
    // it is falsy and, critically, NOT the value the transaction set - so
    // assert on that rather than a specific null/'' representation.
    const sql = getAppSqlClient();
    const after = await sql`select current_setting('app.tenant_id', true) as tenant_id`;
    expect(after[0]?.tenant_id).not.toBe('tenant-b');
    expect(Boolean(after[0]?.tenant_id)).toBe(false);
  });

  it('never lets one tenant transaction observe another tenant context on a reused connection', async () => {
    await withTenantTx({ tenantId: tenantId('tenant-a'), roles: [], requestId: 'r1' }, async (db) => {
      await db.execute(rawSql`insert into probe (seen_tenant_id) values (current_setting('app.tenant_id', true))`);
    });

    await withTenantTx({ tenantId: tenantId('tenant-b'), roles: [], requestId: 'r2' }, async (db) => {
      await db.execute(rawSql`insert into probe (seen_tenant_id) values (current_setting('app.tenant_id', true))`);
    });

    const rows = await ownerSql`select seen_tenant_id from probe order by id`;
    expect(rows.map((r) => r.seen_tenant_id)).toEqual(['tenant-a', 'tenant-b']);
  });
});
