import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql as rawSql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type TenantContext } from '@sms/kernel';
import { closeSqlClients, createSqlClient, runWithContext, withTenantTx, type Sql } from '@sms/db';
import { AcademicYearService } from './application/academic-year.service.js';
import { CampusService } from './application/campus.service.js';
import { TenancyService } from './application/tenancy.service.js';
import { TenantService } from './application/tenant.service.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

/**
 * Applies the real `0100_audit.sql` (from `libs/platform/audit`, read but
 * never edited - see the module report's constraints) and this module's own
 * `0200_tenancy.sql` to a throwaway container, then proves - through the
 * real `withTenantTx`/`withSystemTx` and the real application services, not
 * reimplementations of them - the four things this module exists for:
 *
 *   1. RLS actually isolates tenants (a non-owner `sms_app` connection).
 *   2. `resolveScope` rejects a campus that belongs to a different tenant.
 *   3. The partial unique indexes (one default campus, one current year)
 *      hold even against a direct insert.
 *   4. `assert_year_writable` raises for a locked year and passes for an
 *      open one.
 */
describe('tenancy (real Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: Sql;

  const tenantService = new TenantService();
  const campusService = new CampusService();
  const academicYearService = new AcademicYearService();
  const tenancyService = new TenancyService(tenantService, campusService, academicYearService);

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('sms_test')
      .withUsername('sms_owner')
      .withPassword('dev')
      .start();

    const ownerUrl = container.getConnectionUri();
    // createSqlClient (not a direct `postgres` import) - the no-restricted-imports
    // ESLint rule only exempts libs/shared/db itself; everywhere else, including
    // this module's own tests, goes through @sms/db's sanctioned client factory.
    ownerSql = createSqlClient(ownerUrl);

    // Minimal stand-in for infra/postgres/init/01-roles-and-extensions.sql:
    // a non-owner app role, so table-owner RLS bypass can't mask a bug here.
    // Both migrations below GRANT to sms_app, so it must exist first.
    await ownerSql`create role sms_app with login password 'dev' nobypassrls`;
    await ownerSql`grant connect on database sms_test to sms_app`;

    // Read each module's migrations folder rather than naming files: a hardcoded
    // list silently stops applying anything added later, so a new migration
    // would be invisible to these tests instead of exercised by them.
    // Numeric prefixes make lexical order the real apply order (see migrate.ts).
    const applyMigrations = async (dir: string): Promise<void> => {
      const files = readdirSync(dir)
        .filter((name) => name.endsWith('.sql'))
        .sort((a, b) => a.localeCompare(b, 'en'));
      for (const file of files) {
        await ownerSql.unsafe(readFileSync(join(dir, file), 'utf8'));
      }
    };

    await applyMigrations(join(__dirname, '..', '..', 'audit', 'migrations'));
    await applyMigrations(join(__dirname, '..', 'migrations'));

    const appUrl = new URL(ownerUrl);
    appUrl.username = 'sms_app';
    appUrl.password = 'dev';

    process.env.DATABASE_URL = appUrl.toString();
    process.env.DATABASE_MIGRATION_URL = ownerUrl;
  }, 180_000);

  afterAll(async () => {
    await closeSqlClients();
    await ownerSql?.end({ timeout: 1 });
    await container?.stop();
  });

  async function createTenant(slug: string, name: string) {
    const result = await tenantService.create({
      slug,
      name,
      locale: 'en',
      timezone: 'UTC',
      currency: 'USD',
      status: 'active',
      branding: {},
      featureFlags: {},
      terminology: {},
    });
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  }

  function ctxFor(tenantId: string): TenantContext {
    return { tenantId: tenantId as TenantContext['tenantId'], roles: [], requestId: newId() };
  }

  it('RLS isolates tenants: tenant B cannot see tenant A campuses, even connected as the non-owner sms_app role', async () => {
    const tenantA = await createTenant('tenant-a-rls', 'Tenant A');
    const tenantB = await createTenant('tenant-b-rls', 'Tenant B');

    const campusA = await runWithContext(ctxFor(tenantA.id), () =>
      campusService.create({ code: 'main', name: 'Main', address: {}, timezone: 'UTC', locale: 'en', isDefault: true, status: 'active' }),
    );
    if (!campusA.ok) throw campusA.error;

    const campusesSeenByB = await runWithContext(ctxFor(tenantB.id), () => campusService.list());
    expect(campusesSeenByB).toEqual([]);

    const campusesSeenByA = await runWithContext(ctxFor(tenantA.id), () => campusService.list());
    expect(campusesSeenByA.map((c) => c.id)).toEqual([campusA.value.id]);

    // Directly against the table too, not just through the service, to rule
    // out an application-level filter doing the work RLS is supposed to.
    const rawRows = await withTenantTx(ctxFor(tenantB.id), (db) =>
      db.execute(rawSql`select id from tenancy.campus where id = ${campusA.value.id}`),
    );
    expect((rawRows as unknown as unknown[]).length).toBe(0);
  });

  it('a system connection (no app.tenant_id set) sees zero tenant rows, not every tenant', async () => {
    await createTenant('tenant-system-probe', 'System Probe Tenant');

    const rows = (await ownerSql`select current_setting('app.tenant_id', true) as tid`) as unknown as Array<{
      tid: string | null;
    }>;
    expect(Boolean(rows[0]?.tid)).toBe(false);

    // sms_owner bypasses RLS as table owner, so query as sms_app with no GUC set instead.
    const appSqlNoContext = createSqlClient(process.env.DATABASE_URL!);
    try {
      const seen = await appSqlNoContext`select count(*)::int as count from tenancy.tenant`;
      expect(seen[0]?.count).toBe(0);
    } finally {
      await appSqlNoContext.end({ timeout: 1 });
    }
  });

  it('resolveScope rejects a campusId belonging to a different tenant', async () => {
    const tenantA = await createTenant('tenant-a-scope', 'Tenant A Scope');
    const tenantB = await createTenant('tenant-b-scope', 'Tenant B Scope');

    const campusB = await runWithContext(ctxFor(tenantB.id), () =>
      campusService.create({ code: 'main', name: 'Main', address: {}, timezone: 'UTC', locale: 'en', isDefault: true, status: 'active' }),
    );
    if (!campusB.ok) throw campusB.error;

    const result = await tenancyService.resolveScope({
      tenantSlugOrId: tenantA.slug,
      campusId: campusB.value.id,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
    }
  });

  it('resolveScope accepts a campusId/academicYearId that do belong to the named tenant, and defaults are used when omitted', async () => {
    const tenant = await createTenant('tenant-resolve-ok', 'Tenant Resolve OK');

    const campus = await runWithContext(ctxFor(tenant.id), () =>
      campusService.create({ code: 'main', name: 'Main', address: {}, timezone: 'UTC', locale: 'en', isDefault: true, status: 'active' }),
    );
    if (!campus.ok) throw campus.error;

    const year = await runWithContext(ctxFor(tenant.id), () =>
      academicYearService.create({ name: '2025-2026', startsOn: '2025-09-01', endsOn: '2026-06-30', status: 'open', isCurrent: true }),
    );
    if (!year.ok) throw year.error;

    const explicit = await tenancyService.resolveScope({
      tenantSlugOrId: tenant.slug,
      campusId: campus.value.id,
      academicYearId: year.value.id,
    });
    expect(explicit.ok).toBe(true);
    if (explicit.ok) {
      expect(explicit.value).toEqual({ tenantId: tenant.id, campusId: campus.value.id, academicYearId: year.value.id });
    }

    const defaulted = await tenancyService.resolveScope({ tenantSlugOrId: tenant.slug });
    expect(defaulted.ok).toBe(true);
    if (defaulted.ok) {
      expect(defaulted.value).toEqual({ tenantId: tenant.id, campusId: campus.value.id, academicYearId: year.value.id });
    }
  });

  it('resolveScope rejects an unknown tenant', async () => {
    const result = await tenancyService.resolveScope({ tenantSlugOrId: 'does-not-exist' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
    }
  });

  it('at most one default campus per tenant - a second one fails', async () => {
    const tenant = await createTenant('tenant-one-default', 'Tenant One Default');

    await runWithContext(ctxFor(tenant.id), async () => {
      const first = await campusService.create({
        code: 'main',
        name: 'Main',
        address: {},
        timezone: 'UTC',
        locale: 'en',
        isDefault: true,
        status: 'active',
      });
      expect(first.ok).toBe(true);

      const second = await campusService.create({
        code: 'north',
        name: 'North',
        address: {},
        timezone: 'UTC',
        locale: 'en',
        isDefault: true,
        status: 'active',
      });
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error.message.toLowerCase()).toContain('duplicate');
      }
    });
  });

  it('at most one current academic year per tenant - a second one fails', async () => {
    const tenant = await createTenant('tenant-one-current', 'Tenant One Current');

    await runWithContext(ctxFor(tenant.id), async () => {
      const first = await academicYearService.create({
        name: '2024-2025',
        startsOn: '2024-09-01',
        endsOn: '2025-06-30',
        status: 'archived',
        isCurrent: true,
      });
      expect(first.ok).toBe(true);

      const second = await academicYearService.create({
        name: '2025-2026',
        startsOn: '2025-09-01',
        endsOn: '2026-06-30',
        status: 'open',
        isCurrent: true,
      });
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error.message.toLowerCase()).toContain('duplicate');
      }
    });
  });

  it('assert_year_writable raises for a locked year and passes for an open one', async () => {
    const tenant = await createTenant('tenant-writable', 'Tenant Writable');

    await runWithContext(ctxFor(tenant.id), async () => {
      const open = await academicYearService.create({
        name: 'open-year',
        startsOn: '2025-09-01',
        endsOn: '2026-06-30',
        status: 'open',
        isCurrent: false,
      });
      if (!open.ok) throw open.error;

      const locked = await academicYearService.create({
        name: 'locked-year',
        startsOn: '2020-09-01',
        endsOn: '2021-06-30',
        status: 'locked',
        isCurrent: false,
      });
      if (!locked.ok) throw locked.error;

      const ctx = ctxFor(tenant.id);

      await expect(
        withTenantTx(ctx, (db) => db.execute(rawSql`select tenancy.assert_year_writable(${open.value.id})`)),
      ).resolves.toBeDefined();

      // drizzle-orm wraps the driver error in its own DrizzleQueryError
      // ("Failed query: ...") and keeps the real Postgres error - the one
      // carrying assert_year_writable's actual RAISE EXCEPTION message - on
      // `.cause` (see also application/sql-errors.ts, which unwraps the
      // same way). Assert on that, not the wrapper's own message.
      let caught: unknown;
      try {
        await withTenantTx(ctx, (db) => db.execute(rawSql`select tenancy.assert_year_writable(${locked.value.id})`));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const cause = caught instanceof Error ? caught.cause : undefined;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).message).toMatch(/not writable/);
    });
  });
});
