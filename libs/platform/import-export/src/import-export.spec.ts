import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { err, newId, ok, type Result, type TenantContext, type TenantId, type UserId } from '@sms/kernel';
import { closeSqlClients, createSqlClient, getContext, runWithContext, withTenantTx, type Sql } from '@sms/db';
import { AUDIT_CONTRACT, AuditModule, type AuditContract } from '@sms/audit';
import { ImportExportService } from './application/import-export.service.js';
import { JobService } from './application/job.service.js';
import { PipelineService } from './application/pipeline.service.js';
import type { ImportTarget, ImportTargetRegistry, ImportTx } from './application/import-target-registry.js';
import type { ColumnMapping, ImportFieldSpec, RowError } from './domain/types.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// -----------------------------------------------------------------------------
// A fake ImportTarget writing to a scratch table (import_export_test.widget),
// same precedent as @sms/audit's own audit.spec.ts standing a `widget` table
// in for a real domain table. Proves this module's pipeline is correct
// without depending on @sms/people (a type:domain module this type:platform
// package must never import - see application/import-target-registry.ts).
// -----------------------------------------------------------------------------
interface WidgetRow {
  readonly key: string;
  readonly name: string;
  readonly email?: string;
}

const WIDGET_FIELDS: ImportFieldSpec[] = [
  { key: 'key', label: 'Key', required: true, type: 'text' },
  { key: 'name', label: 'Name', required: true, type: 'text' },
  { key: 'email', label: 'Email', required: false, type: 'text' },
];

function requireCtx(): TenantContext {
  const ctx = getContext();
  if (!ctx || 'kind' in ctx) throw new Error('widget target requires a tenant context');
  return ctx as TenantContext;
}

function get(raw: Record<string, string>, mapping: ColumnMapping, key: string): string | undefined {
  const header = mapping[key];
  if (!header) return undefined;
  const value = raw[header];
  return value === undefined ? undefined : value.trim();
}

const widgetTarget: ImportTarget<WidgetRow> = {
  entityType: 'test.widget',
  fields: WIDGET_FIELDS,

  async parseRow(raw, mapping): Promise<Result<WidgetRow, RowError[]>> {
    const key = get(raw, mapping, 'key');
    const name = get(raw, mapping, 'name');
    const errors: RowError[] = [];
    if (!key) errors.push({ field: 'key', message: 'key is required' });
    if (!name) errors.push({ field: 'name', message: 'name is required' });
    if (errors.length > 0) return err(errors);
    return ok({ key: key!, name: name!, email: get(raw, mapping, 'email') || undefined });
  },

  async findExisting(row, tx?: ImportTx) {
    const query = sql`select id from import_export_test.widget where key = ${row.key} limit 1`;
    const rows = tx
      ? ((await tx.execute(query)) as unknown as Array<{ id: string }>)
      : ((await withTenantTx(requireCtx(), (t) => t.execute(query))) as unknown as Array<{ id: string }>);
    const found = rows[0];
    return found ? { id: found.id } : null;
  },

  async create(row, tx: ImportTx) {
    const ctx = requireCtx();
    const id = newId();
    await tx.execute(
      sql`insert into import_export_test.widget (id, tenant_id, key, name, email) values (${id}, ${ctx.tenantId}, ${row.key}, ${row.name}, ${row.email ?? null})`,
    );
    return { id };
  },

  async update(id, row, tx: ImportTx) {
    await tx.execute(sql`update import_export_test.widget set name = ${row.name}, email = ${row.email ?? null} where id = ${id}`);
  },

  async *list() {
    const ctx = requireCtx();
    const rows = (await withTenantTx(ctx, (t) =>
      t.execute(sql`select key, name, email from import_export_test.widget where tenant_id = ${ctx.tenantId} order by key`),
    )) as unknown as Array<{ key: string; name: string; email: string | null }>;
    for (const row of rows) {
      yield { key: row.key, name: row.name, email: row.email ?? '' };
    }
  },
};

const registry: ImportTargetRegistry = {
  list: () => [{ entityType: widgetTarget.entityType, fields: widgetTarget.fields }],
  get: (entityType) => (entityType === widgetTarget.entityType ? (widgetTarget as ImportTarget<unknown>) : undefined),
};

/**
 * Applies the real `audit` + `tenancy` migrations (read, never edited) and
 * this module's own `0800` migration to a throwaway container, then proves -
 * through the real `JobService`/`PipelineService`/`ImportExportService`, not
 * a reimplementation of them - the properties this module exists for. Same
 * structure as `@sms/custom-fields`'s `custom-fields.spec.ts`.
 */
describe('import-export (real Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: Sql;
  let audit: AuditContract;
  let auditAppContext: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;

  let jobs: JobService;
  let pipeline: PipelineService;
  let importExport: ImportExportService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('sms_test')
      .withUsername('sms_owner')
      .withPassword('dev')
      .start();

    const ownerUrl = container.getConnectionUri();
    ownerSql = createSqlClient(ownerUrl);

    await ownerSql`create role sms_app with login password 'dev' nobypassrls`;
    await ownerSql`grant connect on database sms_test to sms_app`;

    const applyMigrations = async (dir: string): Promise<void> => {
      const files = readdirSync(dir)
        .filter((name) => name.endsWith('.sql'))
        .sort((a, b) => a.localeCompare(b, 'en'));
      for (const file of files) {
        await ownerSql.unsafe(readFileSync(join(dir, file), 'utf8'));
      }
    };

    await applyMigrations(join(__dirname, '..', '..', 'audit', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', 'tenancy', 'migrations'));
    await applyMigrations(join(__dirname, '..', 'migrations'));

    // The fake target's scratch table - same precedent as @sms/audit's own
    // audit.spec.ts standing a `widget` table in for a real domain table.
    await ownerSql`create schema import_export_test`;
    await ownerSql`
      create table import_export_test.widget (
        id uuid primary key default uuidv7(),
        tenant_id uuid not null,
        key text not null,
        name text not null,
        email text,
        unique (tenant_id, key)
      )
    `;
    await ownerSql`select audit.attach_history('import_export_test.widget')`;
    await ownerSql`alter table import_export_test.widget enable row level security`;
    await ownerSql`
      create policy widget_tenant_isolation on import_export_test.widget
        for all
        using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
        with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    `;
    await ownerSql`grant usage on schema import_export_test to sms_app`;
    await ownerSql`grant select, insert, update, delete on import_export_test.widget to sms_app`;

    const appUrl = new URL(ownerUrl);
    appUrl.username = 'sms_app';
    appUrl.password = 'dev';

    process.env.DATABASE_URL = appUrl.toString();
    process.env.DATABASE_MIGRATION_URL = ownerUrl;

    // A real AuditContract, obtained through @sms/audit's PUBLIC entrypoint
    // (AuditModule + AUDIT_CONTRACT) - this package may never import
    // @sms/audit's internal AuditService class directly (module boundary:
    // only a sibling's public entrypoint is reachable). NestFactory (not
    // @nestjs/testing, not a dependency of this package) is enough to
    // resolve one provider with no HTTP layer.
    auditAppContext = await NestFactory.createApplicationContext(AuditModule, { logger: false });
    audit = auditAppContext.get<AuditContract>(AUDIT_CONTRACT);

    jobs = new JobService(registry);
    pipeline = new PipelineService(audit, jobs, registry);
    importExport = new ImportExportService(jobs, pipeline, registry);
  }, 180_000);

  afterAll(async () => {
    await auditAppContext?.close();
    await closeSqlClients();
    await ownerSql?.end({ timeout: 1 });
    await container?.stop();
  });

  async function createTenant(slug: string, name: string): Promise<TenantId> {
    const rows = await ownerSql`insert into tenancy.tenant (slug, name) values (${slug}, ${name}) returning id`;
    return (rows[0] as { id: string }).id as TenantId;
  }

  function ctxFor(tenantId: TenantId, requestId: string): TenantContext {
    const userId = newId() as UserId;
    return { tenantId, roles: [], requestId, userId, actorUserId: userId };
  }

  const KEY_MAPPING: ColumnMapping = { key: 'Key', name: 'Name', email: 'Email' };

  async function widgetRows(tenantId: TenantId): Promise<Array<{ key: string; name: string; email: string | null }>> {
    return (await ownerSql`select key, name, email from import_export_test.widget where tenant_id = ${tenantId} order by key`) as unknown as Array<{
      key: string;
      name: string;
      email: string | null;
    }>;
  }

  it('dryRun validates every row, writes nothing to the target table, and dryRun/commit agree on counts', async () => {
    const tenantId = await createTenant('tenant-ie-agree', 'Tenant IE Agree');
    const ctx = ctxFor(tenantId, 'req-ie-agree');
    const csv = 'Key,Name,Email\nW1,Widget One,w1@example.com\nW2,Widget Two,\n,Missing Key,\n';

    const created = await runWithContext(ctx, () => importExport.createJob({ entityType: 'test.widget', filename: 'widgets.csv', csv }));
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;
    const jobId = created.value.job.id;
    expect(created.value.job.rowCount).toBe(3);
    // Fuzzy-matched off the exact header text.
    expect(created.value.suggestedMapping).toEqual({ key: 'Key', name: 'Name', email: 'Email' });

    const mapped = await runWithContext(ctx, () => importExport.setMapping(jobId, KEY_MAPPING));
    expect(mapped.ok).toBe(true);

    const dryRun = await runWithContext(ctx, () => importExport.dryRun(jobId));
    expect(dryRun.ok).toBe(true);
    if (!dryRun.ok) throw dryRun.error;
    expect(dryRun.value.validCount).toBe(2);
    expect(dryRun.value.errorCount).toBe(1);
    expect(dryRun.value.firstErrors).toHaveLength(1);
    expect(dryRun.value.firstErrors[0]?.rowNumber).toBe(3);
    expect(dryRun.value.predictedCreateCount).toBe(2);
    expect(dryRun.value.predictedUpdateCount).toBe(0);

    // dryRun must write NOTHING to the target table.
    expect(await widgetRows(tenantId)).toHaveLength(0);

    // But it DOES persist per-row outcomes/errors.
    const rowsAfterDryRun = await runWithContext(ctx, () => importExport.listRows(jobId));
    const byRowNumber = new Map(rowsAfterDryRun.items.map((r) => [r.rowNumber, r]));
    expect(byRowNumber.get(1)?.outcome).toBe('valid');
    expect(byRowNumber.get(2)?.outcome).toBe('valid');
    expect(byRowNumber.get(3)?.outcome).toBe('error');
    expect(byRowNumber.get(3)?.errors).toEqual([{ field: 'key', message: 'key is required' }]);

    const commit = await runWithContext(ctx, () => importExport.commit(jobId));
    expect(commit.ok).toBe(true);
    if (!commit.ok) throw commit.error;

    // dryRun and commit MUST agree.
    expect(commit.value.createdCount).toBe(dryRun.value.predictedCreateCount);
    expect(commit.value.updatedCount).toBe(dryRun.value.predictedUpdateCount);
    expect(commit.value.errorCount).toBe(dryRun.value.errorCount);
    expect(commit.value.createdCount + commit.value.updatedCount).toBe(dryRun.value.validCount);

    const rows = await widgetRows(tenantId);
    expect(rows.map((r) => r.key)).toEqual(['W1', 'W2']);
  });

  it('commit stamps every row it writes with the SAME bulk_operation_id, visible in audit.record_history', async () => {
    const tenantId = await createTenant('tenant-ie-bulk', 'Tenant IE Bulk');
    const ctx = ctxFor(tenantId, 'req-ie-bulk');
    const csv = 'Key,Name\nB1,Bulk One\nB2,Bulk Two\n';

    const created = await runWithContext(ctx, () => importExport.createJob({ entityType: 'test.widget', filename: 'bulk.csv', csv }));
    if (!created.ok) throw created.error;
    const jobId = created.value.job.id;

    await runWithContext(ctx, () => importExport.setMapping(jobId, { key: 'Key', name: 'Name' }));
    await runWithContext(ctx, () => importExport.dryRun(jobId));
    const commit = await runWithContext(ctx, () => importExport.commit(jobId));
    if (!commit.ok) throw commit.error;

    expect(commit.value.job.bulkOperationId).toBeTruthy();
    const bulkOperationId = commit.value.job.bulkOperationId!;

    const historyRows = await ownerSql`
      select record_id, bulk_operation_id from audit.record_history
      where table_schema = 'import_export_test' and table_name = 'widget' and operation = 'insert'
        and tenant_id = ${tenantId}
    `;
    expect(historyRows).toHaveLength(2);
    for (const row of historyRows) {
      expect(row.bulk_operation_id).toBe(bulkOperationId);
    }

    const bulkOpRow = await ownerSql`select status, kind from audit.bulk_operation where id = ${bulkOperationId}`;
    expect(bulkOpRow[0]?.status).toBe('completed');
    expect(bulkOpRow[0]?.kind).toBe('import_export.commit');
  });

  it('revert restores prior state: a created row disappears, an updated row goes back to its previous values', async () => {
    const tenantId = await createTenant('tenant-ie-revert', 'Tenant IE Revert');
    const ctx = ctxFor(tenantId, 'req-ie-revert-seed');

    // Pre-existing row this job's commit will UPDATE.
    await runWithContext(ctx, () =>
      withTenantTx(ctx, (tx) =>
        tx.execute(sql`insert into import_export_test.widget (id, tenant_id, key, name, email) values (${newId()}, ${tenantId}, 'R1', 'Old Name', 'old@example.com')`),
      ),
    );

    const csv = 'Key,Name,Email\nR1,New Name,new@example.com\nR2,Brand New,\n';
    const created = await runWithContext(ctx, () => importExport.createJob({ entityType: 'test.widget', filename: 'revert.csv', csv }));
    if (!created.ok) throw created.error;
    const jobId = created.value.job.id;

    await runWithContext(ctx, () => importExport.setMapping(jobId, KEY_MAPPING));
    const dryRun = await runWithContext(ctx, () => importExport.dryRun(jobId));
    if (!dryRun.ok) throw dryRun.error;
    expect(dryRun.value.predictedCreateCount).toBe(1);
    expect(dryRun.value.predictedUpdateCount).toBe(1);

    const commit = await runWithContext(ctx, () => importExport.commit(jobId));
    if (!commit.ok) throw commit.error;
    expect(commit.value.createdCount).toBe(1);
    expect(commit.value.updatedCount).toBe(1);

    const afterCommit = await widgetRows(tenantId);
    expect(afterCommit).toEqual([
      { key: 'R1', name: 'New Name', email: 'new@example.com' },
      { key: 'R2', name: 'Brand New', email: null },
    ]);

    const reverted = await runWithContext(ctx, () => importExport.revert(jobId));
    expect(reverted.ok).toBe(true);
    if (!reverted.ok) throw reverted.error;
    expect(reverted.value.status).toBe('reverted');

    const afterRevert = await widgetRows(tenantId);
    // R2 (created by the import) is gone entirely; R1 (updated) is back to
    // its pre-import values.
    expect(afterRevert).toEqual([{ key: 'R1', name: 'Old Name', email: 'old@example.com' }]);

    expect(commit.value.job.bulkOperationId).toBeTruthy();
    const bulkOpRow = await ownerSql`select status from audit.bulk_operation where id = ${commit.value.job.bulkOperationId!}`;
    expect(bulkOpRow[0]?.status).toBe('reverted');
  });

  it('re-running the same file is idempotent: the second commit updates rather than duplicates', async () => {
    const tenantId = await createTenant('tenant-ie-idem', 'Tenant IE Idempotent');
    const csv = 'Key,Name,Email\nD1,Duplicate Me,first@example.com\n';

    async function runImport(requestId: string) {
      const c = ctxFor(tenantId, requestId);
      const created = await runWithContext(c, () => importExport.createJob({ entityType: 'test.widget', filename: 'dup.csv', csv }));
      if (!created.ok) throw created.error;
      const jobId = created.value.job.id;
      await runWithContext(c, () => importExport.setMapping(jobId, KEY_MAPPING));
      await runWithContext(c, () => importExport.dryRun(jobId));
      const commit = await runWithContext(c, () => importExport.commit(jobId));
      if (!commit.ok) throw commit.error;
      return commit.value;
    }

    const first = await runImport('req-ie-idem-1');
    expect(first.createdCount).toBe(1);
    expect(first.updatedCount).toBe(0);

    const second = await runImport('req-ie-idem-2');
    expect(second.createdCount).toBe(0);
    expect(second.updatedCount).toBe(1);

    const rows = await widgetRows(tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ key: 'D1', name: 'Duplicate Me', email: 'first@example.com' });
  });

  it('RLS isolates import jobs and rows across tenants', async () => {
    const tenantX = await createTenant('tenant-ie-rls-x', 'Tenant IE RLS X');
    const tenantY = await createTenant('tenant-ie-rls-y', 'Tenant IE RLS Y');
    const ctxX = ctxFor(tenantX, 'req-ie-rls-x');
    const ctxY = ctxFor(tenantY, 'req-ie-rls-y');

    const created = await runWithContext(ctxX, () =>
      importExport.createJob({ entityType: 'test.widget', filename: 'rls.csv', csv: 'Key,Name\nX1,X One\n' }),
    );
    if (!created.ok) throw created.error;
    const jobId = created.value.job.id;

    const jobsForY = await runWithContext(ctxY, () => importExport.listJobs());
    expect(jobsForY.find((j) => j.id === jobId)).toBeUndefined();

    const getForY = await runWithContext(ctxY, () => importExport.getJob(jobId));
    expect(getForY.ok).toBe(false);

    const rowsForY = await runWithContext(ctxY, () => importExport.listRows(jobId));
    expect(rowsForY.items).toHaveLength(0);

    const jobsForX = await runWithContext(ctxX, () => importExport.listJobs());
    expect(jobsForX.find((j) => j.id === jobId)).toBeTruthy();

    // Directly against the tables too, not just through the service, to rule
    // out an application-level filter doing the work RLS is supposed to.
    const appSqlNoContext = createSqlClient(process.env.DATABASE_URL!);
    try {
      const rows = await appSqlNoContext`select id from import_export.import_job where id = ${jobId}`;
      expect(rows.length).toBe(0); // no app.tenant_id GUC set -> zero rows, never "every tenant"
    } finally {
      await appSqlNoContext.end({ timeout: 1 });
    }
  });
});
