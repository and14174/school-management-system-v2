#!/usr/bin/env tsx
/**
 * Architecture checks, run against a migrated database.
 *
 * The six hard-to-reverse design decisions (single person record, effective
 * dating, ambient tenant context, JSONB custom fields, rules-as-config,
 * auditable + reversible writes) are only worth anything if they cannot quietly
 * stop being true. Documentation does not achieve that; asking Postgres does.
 *
 * These interrogate the live catalog, so they cannot be satisfied by a comment
 * or a convention nobody follows. Wire into CI immediately after `db:migrate`.
 *
 *   pnpm check:db
 *
 * Opting out is deliberate and visible: set a table COMMENT containing
 *   @global    - not tenant-scoped (reference data shared by all tenants)
 *   @no-audit  - deliberately not history-tracked (append-only logs, ledgers)
 * Anything without a marker is expected to be tenant-scoped and audited.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = join(fileURLToPath(import.meta.url), '..');

try {
  process.loadEnvFile(join(__dirname, '..', '..', '..', '..', '.env'));
} catch {
  // environment already populated
}

const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error('DATABASE_MIGRATION_URL is not set.');
  process.exit(1);
}

/**
 * Schemas owned by application modules, DISCOVERED rather than listed.
 *
 * This was a hardcoded allowlist, and it silently rotted: `custom_fields`,
 * `import_export` and `outbox` were all added later and none of them was ever
 * checked. Three modules could have shipped tables with no RLS and no audit
 * trigger while this script cheerfully reported "all architecture checks
 * passed" - the precise failure a safety check must never have, because its
 * green result is what everyone trusts instead of looking.
 *
 * Inverting it makes the default safe: every schema is checked unless it is
 * explicitly a Postgres internal, so a new module is covered the moment it
 * creates its schema and forgetting to register one is not possible.
 */
const EXCLUDED_SCHEMAS = sqlLiteralList([
  'information_schema',
  'public', // no application tables live here; modules each own a named schema
]);

const MODULE_SCHEMA_PREDICATE = `
  c.relnamespace::regnamespace::text not like 'pg\\_%'
  and c.relnamespace::regnamespace::text not in (${EXCLUDED_SCHEMAS})
`;

function sqlLiteralList(values: string[]): string {
  return values.map((v) => `'${v}'`).join(', ');
}

interface Violation {
  check: string;
  detail: string;
}

const violations: Violation[] = [];
const passed: string[] = [];

function record(check: string, found: Violation[], okMessage: string): void {
  if (found.length === 0) {
    passed.push(`${check} - ${okMessage}`);
  } else {
    violations.push(...found);
  }
}

async function main(): Promise<void> {
  const sql = postgres(url!, { max: 1, onnotice: () => {} });

  try {
    // -----------------------------------------------------------------------
    // 1. Every tenant-scoped table has tenant_id, RLS enabled, and a policy.
    //
    //    A table with tenant_id but no policy is the dangerous case: it looks
    //    scoped, and every query silently returns every tenant's rows.
    // -----------------------------------------------------------------------
    const rlsRows = await sql.unsafe<
      Array<{
        schema: string;
        table: string;
        has_tenant_id: boolean;
        rls_enabled: boolean;
        policy_count: number;
        is_global: boolean;
      }>
    >(`
      select
        c.relnamespace::regnamespace::text                              as schema,
        c.relname                                                       as table,
        exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped
        )                                                               as has_tenant_id,
        c.relrowsecurity                                                as rls_enabled,
        (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policy_count,
        coalesce(obj_description(c.oid, 'pg_class'), '') like '%@global%' as is_global
      from pg_class c
      where c.relkind in ('r', 'p')
        and ${MODULE_SCHEMA_PREDICATE}
        and c.relname not like '\\_\\_%'
        -- Partition children are not independently designed tables: they carry no
        -- grants of their own, so they are only reachable through the partitioned
        -- parent, whose RLS policy and trigger already govern them.
        and not c.relispartition
      order by 1, 2
    `);

    const rlsViolations: Violation[] = [];
    for (const r of rlsRows) {
      const name = `${r.schema}.${r.table}`;
      if (r.is_global) {
        if (r.has_tenant_id) {
          rlsViolations.push({
            check: 'rls',
            detail: `${name} is marked @global but still has a tenant_id column - pick one.`,
          });
        }
        continue;
      }
      if (!r.has_tenant_id) {
        rlsViolations.push({
          check: 'rls',
          detail: `${name} has no tenant_id column and is not marked @global.`,
        });
        continue;
      }
      if (!r.rls_enabled) {
        rlsViolations.push({
          check: 'rls',
          detail: `${name} has tenant_id but row-level security is DISABLED - every tenant can read every row.`,
        });
      } else if (r.policy_count === 0) {
        rlsViolations.push({
          check: 'rls',
          detail: `${name} has RLS enabled but ZERO policies - this denies all access rather than scoping it.`,
        });
      }
    }
    record('rls', rlsViolations, `${rlsRows.length} module tables checked`);

    // -----------------------------------------------------------------------
    // 2. Every table carries the audit history trigger.
    // -----------------------------------------------------------------------
    const auditFnExists = await sql`
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'audit' and p.proname = 'record_history'
    `;

    if (auditFnExists.length === 0) {
      passed.push('audit - skipped, audit.record_history() does not exist yet');
    } else {
      const auditRows = await sql.unsafe<
        Array<{ schema: string; table: string; has_trigger: boolean; opted_out: boolean }>
      >(`
        select
          c.relnamespace::regnamespace::text as schema,
          c.relname                          as table,
          exists (
            select 1 from pg_trigger t
            where t.tgrelid = c.oid and not t.tgisinternal
              and t.tgfoid = 'audit.record_history'::regproc
          )                                  as has_trigger,
          coalesce(obj_description(c.oid, 'pg_class'), '') like '%@no-audit%' as opted_out
        from pg_class c
        where c.relkind in ('r', 'p')
          and ${MODULE_SCHEMA_PREDICATE}
          and c.relnamespace::regnamespace::text <> 'audit'
          and c.relname not like '\\_\\_%'
        -- Partition children are not independently designed tables: they carry no
        -- grants of their own, so they are only reachable through the partitioned
        -- parent, whose RLS policy and trigger already govern them.
        and not c.relispartition
        order by 1, 2
      `);

      const auditViolations = auditRows
        .filter((r) => !r.has_trigger && !r.opted_out)
        .map((r) => ({
          check: 'audit',
          detail: `${r.schema}.${r.table} has no history trigger and is not marked @no-audit - changes to it would be untraceable.`,
        }));
      record('audit', auditViolations, `${auditRows.length} module tables checked`);
    }

    // -----------------------------------------------------------------------
    // 3. The application role cannot bypass RLS.
    //
    //    RLS does not apply to superusers or to a table's owner. If the API
    //    connects as either, every policy above is decorative.
    // -----------------------------------------------------------------------
    const [appRole] = await sql<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      select rolsuper, rolbypassrls from pg_roles where rolname = 'sms_app'
    `;

    const roleViolations: Violation[] = [];
    if (!appRole) {
      roleViolations.push({ check: 'role', detail: 'Role sms_app does not exist.' });
    } else {
      if (appRole.rolsuper) {
        roleViolations.push({
          check: 'role',
          detail: 'sms_app is a SUPERUSER - it bypasses every row-level security policy.',
        });
      }
      if (appRole.rolbypassrls) {
        roleViolations.push({
          check: 'role',
          detail: 'sms_app has BYPASSRLS - it bypasses every row-level security policy.',
        });
      }
    }
    record('role', roleViolations, 'sms_app is a plain, non-bypassing role');

    // -----------------------------------------------------------------------
    // 4. The application role owns no tables (owners implicitly bypass RLS).
    // -----------------------------------------------------------------------
    const ownedRows = await sql.unsafe<Array<{ schema: string; table: string }>>(`
      select c.relnamespace::regnamespace::text as schema, c.relname as table
      from pg_class c
      where c.relkind in ('r', 'p')
        and ${MODULE_SCHEMA_PREDICATE}
        and pg_get_userbyid(c.relowner) = 'sms_app'
      order by 1, 2
    `);

    record(
      'ownership',
      ownedRows.map((r) => ({
        check: 'ownership',
        detail: `${r.schema}.${r.table} is owned by sms_app - table owners bypass RLS. Migrations must run as sms_owner.`,
      })),
      'no module table is owned by the application role',
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main()
  .then(() => {
    for (const line of passed) console.log(`  ok    ${line}`);

    if (violations.length > 0) {
      console.error('');
      for (const v of violations) console.error(`  FAIL  [${v.check}] ${v.detail}`);
      console.error(`\n${violations.length} architecture check violation(s).`);
      process.exit(1);
    }

    console.log('\nall architecture checks passed');
  })
  .catch((error: unknown) => {
    console.error('architecture checks could not run:', error);
    process.exit(1);
  });
