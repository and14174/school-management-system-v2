import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql as rawSql } from 'drizzle-orm';
// Test harness only: creates the sms_app role, applies the real migration
// SQL, and (for the RLS/grants check) opens a direct sms_app connection to
// prove it cannot write audit.record_history. This is exactly the pattern
// libs/shared/db's tx.spec.ts uses - the no-restricted-imports ban on
// importing 'postgres' outside @sms/db exists to stop application code
// bypassing withTenantTx, not to stop a test harness standing up its own
// fixtures against a disposable container.
// eslint-disable-next-line no-restricted-imports
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type PersonId, type TenantContext } from '@sms/kernel';
import { closeSqlClients, runWithContext, withTenantTx } from '@sms/db';
import { AuditService } from './application/audit.service.js';
import type { BulkOperationId } from './contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Applies the real, already-verified `0100_audit.sql` migration against a
 * disposable Postgres container and exercises the real `AuditService` (not
 * a reimplementation of it) - see tx.spec.ts for why this needs a genuine
 * Postgres rather than a mock: RLS, grants and the SECURITY DEFINER trigger
 * are exactly the things a hand-rolled fake would happily let slide.
 */
describe('audit module (real Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: postgres.Sql;
  let appSql: postgres.Sql;

  const auditService = new AuditService();
  const TENANT_A = newId() as TenantContext['tenantId'];

  function ctxFor(requestId: string): TenantContext {
    return { tenantId: TENANT_A, roles: [], requestId };
  }

  async function insertWidget(ctx: TenantContext, name: string): Promise<string> {
    return runWithContext(ctx, () =>
      withTenantTx(ctx, async (tx) => {
        const rows = (await tx.execute(
          rawSql`insert into widget (tenant_id, name) values (${ctx.tenantId}, ${name}) returning id`,
        )) as unknown as Array<{ id: string }>;
        return rows[0]!.id;
      }),
    );
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('sms_test')
      .withUsername('sms_owner')
      .withPassword('dev')
      .start();

    const ownerUrl = container.getConnectionUri();
    ownerSql = postgres(ownerUrl, { max: 1 });

    // Minimal stand-in for infra/postgres/init/01-roles-and-extensions.sql:
    // a non-owner app role, so table-owner RLS bypass can't mask a bug.
    await ownerSql`create role sms_app with login password 'dev' nobypassrls`;
    await ownerSql`grant connect on database sms_test to sms_app`;

    // Apply every migration this module owns, in filename order - the same way
    // the real migrator does. Reading the folder rather than naming one file
    // means a new migration is exercised by these tests automatically.
    const migrationsDir = join(__dirname, '..', 'migrations');
    const migrationFiles = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b, 'en'));

    for (const file of migrationFiles) {
      await ownerSql.unsafe(readFileSync(join(migrationsDir, file), 'utf8'));
    }

    // A minimal domain table standing in for a real one (e.g. `people.person`)
    // so the generic trigger has something to attach to - audit's own
    // tables are never themselves audited (see the @no-audit comments in
    // the migration).
    await ownerSql`
      create table widget (
        id uuid primary key default uuidv7(),
        tenant_id uuid not null,
        name text not null
      )
    `;
    await ownerSql`select audit.attach_history('widget')`;
    await ownerSql`grant usage on schema public to sms_app`;
    await ownerSql`grant select, insert, update, delete on widget to sms_app`;

    const appUrl = new URL(ownerUrl);
    appUrl.username = 'sms_app';
    appUrl.password = 'dev';

    // Points the real withTenantTx()/AuditService singleton at this
    // container, as sms_app - exactly what apps/api connects as in
    // production (DATABASE_URL in .env.example).
    process.env.DATABASE_URL = appUrl.toString();

    appSql = postgres(appUrl.toString(), { max: 1 });
  }, 180_000);

  afterAll(async () => {
    await closeSqlClients();
    await appSql?.end({ timeout: 1 });
    await ownerSql?.end({ timeout: 1 });
    await container?.stop();
  });

  it('withBulkOperation stamps bulk_operation_id onto history rows written inside it, and leaves rows written outside it unstamped', async () => {
    const ctx = ctxFor('req-bulk-1');

    const outsideId = await insertWidget(ctx, 'outside-bulk-op');

    const { insideId, gucSeenInsideTx } = await runWithContext(ctx, () =>
      auditService.withBulkOperation({ kind: 'test-import', summary: { note: 'seed' } }, async (tx) => {
        const gucRows = (await tx.execute(
          rawSql`select current_setting('app.bulk_operation_id', true) as id`,
        )) as unknown as Array<{ id: string | null }>;

        const rows = (await tx.execute(
          rawSql`insert into widget (tenant_id, name) values (${ctx.tenantId}, 'inside-bulk-op') returning id`,
        )) as unknown as Array<{ id: string }>;

        return { insideId: rows[0]!.id, gucSeenInsideTx: gucRows[0]!.id };
      }),
    );

    // The GUC withBulkOperation sets is a real, non-empty uuid visible to
    // fn's own transaction - this is what the history trigger reads.
    expect(gucSeenInsideTx).toBeTruthy();

    const [outsideHistory] = await ownerSql`
      select bulk_operation_id from audit.record_history where record_id = ${outsideId}
    `;
    const [insideHistory] = await ownerSql`
      select bulk_operation_id from audit.record_history where record_id = ${insideId}
    `;

    expect(outsideHistory?.bulk_operation_id).toBeNull();
    expect(insideHistory?.bulk_operation_id).toBe(gucSeenInsideTx);

    const operation = await runWithContext(ctx, () =>
      auditService.getBulkOperation(gucSeenInsideTx as BulkOperationId),
    );
    expect(operation?.kind).toBe('test-import');
    expect(operation?.status).toBe('completed');
  });

  it('withBulkOperation marks the operation failed when fn throws', async () => {
    const ctx = ctxFor('req-bulk-2');

    let capturedId: string | undefined;

    await expect(
      runWithContext(ctx, () =>
        auditService.withBulkOperation({ kind: 'test-import-failure' }, async (tx) => {
          const gucRows = (await tx.execute(
            rawSql`select current_setting('app.bulk_operation_id', true) as id`,
          )) as unknown as Array<{ id: string | null }>;
          capturedId = gucRows[0]!.id ?? undefined;
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');

    expect(capturedId).toBeTruthy();

    const operation = await runWithContext(ctx, () => auditService.getBulkOperation(capturedId as BulkOperationId));
    expect(operation?.status).toBe('failed');
  });

  it('recordAccess writes a row carrying the ambient tenantId and requestId', async () => {
    const ctx = ctxFor('req-access-1');
    const personId = newId() as PersonId;

    await runWithContext(ctx, () =>
      auditService.recordAccess({
        personId,
        resource: 'person.medical_notes',
        fieldNames: ['diagnosis', 'medication'],
        reason: 'nurse review',
      }),
    );

    const rows = await ownerSql`
      select tenant_id, request_id, person_id, resource, field_names, reason
      from audit.access_log
      where request_id = ${ctx.requestId}
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(ctx.tenantId);
    expect(rows[0]?.request_id).toBe(ctx.requestId);
    expect(rows[0]?.person_id).toBe(personId);
    expect(rows[0]?.resource).toBe('person.medical_notes');
    expect(rows[0]?.field_names).toEqual(['diagnosis', 'medication']);
    expect(rows[0]?.reason).toBe('nurse review');
  });

  it('getHistory returns entries newest-first with correct before/after images', async () => {
    const ctx = ctxFor('req-history-1');

    const widgetId = await insertWidget(ctx, 'v1');
    await delay(5);
    await runWithContext(ctx, () =>
      withTenantTx(ctx, (tx) => tx.execute(rawSql`update widget set name = 'v2' where id = ${widgetId}`)),
    );
    await delay(5);
    await runWithContext(ctx, () =>
      withTenantTx(ctx, (tx) => tx.execute(rawSql`update widget set name = 'v3' where id = ${widgetId}`)),
    );

    const history = await runWithContext(ctx, () =>
      auditService.getHistory({ tableSchema: 'public', tableName: 'widget', recordId: widgetId }),
    );

    expect(history.map((entry) => entry.operation)).toEqual(['update', 'update', 'insert']);

    expect(history[0]?.before).toMatchObject({ name: 'v2' });
    expect(history[0]?.after).toMatchObject({ name: 'v3' });

    expect(history[1]?.before).toMatchObject({ name: 'v1' });
    expect(history[1]?.after).toMatchObject({ name: 'v2' });

    expect(history[2]?.before).toBeUndefined();
    expect(history[2]?.after).toMatchObject({ name: 'v1' });

    // Newest first: each entry's occurred_at is >= the next one's.
    for (let i = 0; i < history.length - 1; i += 1) {
      expect(history[i]!.occurredAt.getTime()).toBeGreaterThanOrEqual(history[i + 1]!.occurredAt.getTime());
    }
  });

  it('sms_app cannot insert, update or delete audit.record_history directly - only the SECURITY DEFINER trigger can write it', async () => {
    const ctx = ctxFor('req-perm-1');
    const widgetId = await insertWidget(ctx, 'perm-check');

    const [historyRow] = await ownerSql`
      select id from audit.record_history where record_id = ${widgetId} limit 1
    `;
    expect(historyRow).toBeTruthy();

    await expect(
      appSql`
        insert into audit.record_history (table_schema, table_name, record_id, operation)
        values ('public', 'widget', 'forged', 'insert')
      `,
    ).rejects.toThrow(/permission denied/i);

    await expect(
      appSql`update audit.record_history set operation = 'delete' where id = ${historyRow!.id}`,
    ).rejects.toThrow(/permission denied/i);

    await expect(
      appSql`delete from audit.record_history where id = ${historyRow!.id}`,
    ).rejects.toThrow(/permission denied/i);
  });
});
