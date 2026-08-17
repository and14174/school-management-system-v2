import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantId } from '@sms/kernel';
import { closeSqlClients, createSqlClient, type Sql } from '@sms/db';
import { FieldDefinitionService } from './application/field-definition.service.js';
import { SchemaCache } from './application/schema-cache.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

/**
 * Applies the real `audit` + `tenancy` migrations (read, never edited - see
 * the module report's constraints) and this module's own `0450` migration to
 * a throwaway container, then proves - through the real
 * `FieldDefinitionService`, not a reimplementation of it - the properties
 * this module exists for:
 *
 *   1. RLS isolates field definitions across tenants.
 *   2. A value violating its definition (wrong type, missing required field,
 *      an option outside a select's allow-list) is rejected.
 *   3. A valid value round-trips through validate().
 *   4. The compiled schema cache is invalidated when a definition changes,
 *      so a newly-required field is enforced on the very next validate().
 */
describe('custom-fields (real Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: Sql;

  const schemaCache = new SchemaCache();
  const fieldDefinitions = new FieldDefinitionService(schemaCache);

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

    // Read each module's migrations folder rather than naming files - see
    // access.spec.ts for why. Numeric prefixes make lexical order the real
    // apply order (see migrate.ts).
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

  async function createTenant(slug: string, name: string): Promise<TenantId> {
    const rows = await ownerSql`insert into tenancy.tenant (slug, name) values (${slug}, ${name}) returning id`;
    return (rows[0] as { id: string }).id as TenantId;
  }

  it('RLS isolates field definitions across tenants', async () => {
    const tenantX = await createTenant('tenant-cf-rls-x', 'Tenant CF RLS X');
    const tenantY = await createTenant('tenant-cf-rls-y', 'Tenant CF RLS Y');

    const created = await fieldDefinitions.createDefinition(tenantX, {
      entityType: 'people.person',
      key: 'bus_route',
      label: 'Bus route',
      dataType: 'text',
    });
    expect(created.ok).toBe(true);

    const definitionsInY = await fieldDefinitions.listDefinitions(tenantY, 'people.person');
    expect(definitionsInY).toHaveLength(0);

    const definitionsInX = await fieldDefinitions.listDefinitions(tenantX, 'people.person');
    expect(definitionsInX).toHaveLength(1);
    expect(definitionsInX[0]?.key).toBe('bus_route');

    // Directly against the table too, not just through the service, to rule
    // out an application-level filter doing the work RLS is supposed to.
    const appSqlNoContext = createSqlClient(process.env.DATABASE_URL!);
    try {
      const rows = await appSqlNoContext`select id from custom_fields.field_definition where tenant_id = ${tenantX}`;
      expect(rows.length).toBe(0); // no app.tenant_id GUC set -> zero rows, never "every tenant"
    } finally {
      await appSqlNoContext.end({ timeout: 1 });
    }
  });

  it('rejects a value violating its definition; a valid value round-trips', async () => {
    const tenantId = await createTenant('tenant-cf-validate', 'Tenant CF Validate');

    await fieldDefinitions.createDefinition(tenantId, {
      entityType: 'people.person',
      key: 'allergy_notes',
      label: 'Allergy notes',
      dataType: 'text',
      required: true,
    });
    await fieldDefinitions.createDefinition(tenantId, {
      entityType: 'people.person',
      key: 'bus_route',
      label: 'Bus route',
      dataType: 'select',
      options: ['A1', 'B2', 'C3'],
    });

    // Missing the required field.
    const missingRequired = await fieldDefinitions.validate(tenantId, 'people.person', { busRoute: 'A1' });
    expect(missingRequired.ok).toBe(false);

    // Wrong type for allergy_notes (number instead of text).
    const wrongType = await fieldDefinitions.validate(tenantId, 'people.person', { allergy_notes: 42 });
    expect(wrongType.ok).toBe(false);

    // Option outside the select's allow-list.
    const badOption = await fieldDefinitions.validate(tenantId, 'people.person', {
      allergy_notes: 'Peanuts',
      bus_route: 'Z9',
    });
    expect(badOption.ok).toBe(false);

    // A key with no matching definition at all - rejected by .strict().
    const unknownKey = await fieldDefinitions.validate(tenantId, 'people.person', {
      allergy_notes: 'Peanuts',
      not_a_real_field: 'oops',
    });
    expect(unknownKey.ok).toBe(false);

    // Valid: required field present with the right type, select value in range.
    const valid = await fieldDefinitions.validate(tenantId, 'people.person', {
      allergy_notes: 'Peanuts',
      bus_route: 'B2',
    });
    expect(valid.ok).toBe(true);
    if (!valid.ok) throw valid.error;
    expect(valid.value).toEqual({ allergy_notes: 'Peanuts', bus_route: 'B2' });
  });

  it('invalidates the cached compiled schema when a definition changes', async () => {
    const tenantId = await createTenant('tenant-cf-cache', 'Tenant CF Cache');

    const created = await fieldDefinitions.createDefinition(tenantId, {
      entityType: 'people.person',
      key: 'nickname',
      label: 'Nickname',
      dataType: 'text',
      required: false,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;

    // Absent, optional field: valid.
    const beforeRequired = await fieldDefinitions.validate(tenantId, 'people.person', {});
    expect(beforeRequired.ok).toBe(true);

    // This also primes the schema cache for (tenantId, 'people.person').
    const primed = await fieldDefinitions.validate(tenantId, 'people.person', { nickname: 'Ace' });
    expect(primed.ok).toBe(true);

    const updated = await fieldDefinitions.updateDefinition(tenantId, created.value.id, { required: true });
    expect(updated.ok).toBe(true);

    // If the cache were not invalidated on update, this would still report
    // success against the stale (optional) schema.
    const afterRequired = await fieldDefinitions.validate(tenantId, 'people.person', {});
    expect(afterRequired.ok).toBe(false);
  });

  it('field definition CRUD: create, get, update, delete', async () => {
    const tenantId = await createTenant('tenant-cf-crud', 'Tenant CF CRUD');

    const created = await fieldDefinitions.createDefinition(tenantId, {
      entityType: 'people.person',
      key: 'dietary_flag',
      label: 'Dietary flag',
      dataType: 'multiselect',
      options: ['vegetarian', 'vegan', 'halal', 'kosher'],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;

    const fetched = await fieldDefinitions.getDefinition(tenantId, created.value.id);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) throw fetched.error;
    expect(fetched.value.label).toBe('Dietary flag');

    const updated = await fieldDefinitions.updateDefinition(tenantId, created.value.id, { label: 'Dietary flags' });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw updated.error;
    expect(updated.value.label).toBe('Dietary flags');

    // Duplicate (tenant_id, entity_type, key) is rejected.
    const duplicate = await fieldDefinitions.createDefinition(tenantId, {
      entityType: 'people.person',
      key: 'dietary_flag',
      label: 'Another one',
      dataType: 'text',
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe('CONFLICT');

    const deleted = await fieldDefinitions.deleteDefinition(tenantId, created.value.id);
    expect(deleted.ok).toBe(true);

    const afterDelete = await fieldDefinitions.getDefinition(tenantId, created.value.id);
    expect(afterDelete.ok).toBe(false);
    if (!afterDelete.ok) expect(afterDelete.error.code).toBe('NOT_FOUND');
  });

  it('a select/multiselect definition with no options is rejected at creation', async () => {
    const tenantId = await createTenant('tenant-cf-no-options', 'Tenant CF No Options');

    const result = await fieldDefinitions.createDefinition(tenantId, {
      entityType: 'people.person',
      key: 'no_options',
      label: 'No options',
      dataType: 'select',
      options: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_ERROR');
  });
});
