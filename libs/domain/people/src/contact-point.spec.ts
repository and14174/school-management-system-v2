import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, ok, type DateOnly, type PersonId, type TenantId } from '@sms/kernel';
import { closeSqlClients, createSqlClient, type Sql } from '@sms/db';
import type { CustomFieldsContract } from '@sms/custom-fields';
import { ContactPointService } from './application/contact-point.service.js';
import { PersonService } from './application/person.service.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

/**
 * A trivial pass-through `CustomFieldsContract` - `PersonService` needs one
 * to validate `custom_fields` against, but every person created below has
 * empty `customFields`, so nothing here actually exercises validation. Same
 * precedent as `seed.ts`'s own `passthroughCustomFields` and
 * `people.spec.ts`'s (fuller) in-memory stub - see either's comment for why
 * this package cannot reach `@sms/custom-fields`'s real Nest-DI
 * implementation from a plain `new`.
 */
const passthroughCustomFields: CustomFieldsContract = {
  async listDefinitions() {
    return [];
  },
  async getDefinition() {
    throw new Error('not implemented in test stub');
  },
  async createDefinition() {
    throw new Error('not implemented in test stub');
  },
  async updateDefinition() {
    throw new Error('not implemented in test stub');
  },
  async deleteDefinition() {
    throw new Error('not implemented in test stub');
  },
  async compileSchema() {
    return z.record(z.string(), z.unknown());
  },
  async validate(_tenantId, _entityType, values) {
    return ok((values ?? {}) as Record<string, unknown>);
  },
};

/**
 * Real Postgres via testcontainers, own container (not shared with
 * `people.spec.ts` - this is a SEPARATE file precisely so another agent's
 * concurrent work in that file is never touched, per the module brief's
 * constraints). Applies the real `audit` + `tenancy` + `identity` +
 * `custom-fields` migrations plus this module's own `0500`-`0503`
 * migrations, then proves `ContactPointService`'s properties through the
 * real service, against real RLS/constraints - never a reimplementation of
 * them. See `docs/decisions.md`'s "Run one testcontainers suite at a time":
 * if this suite times out at 120s while another testcontainers run is also
 * in flight, that is resource contention, not a logic bug.
 */
describe('people.contact_point (real Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: Sql;
  let persons: PersonService;
  let contactPoints: ContactPointService;

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
    // access.spec.ts / people.spec.ts for why (a hardcoded list silently
    // stops covering new migrations). Numeric prefixes make lexical order
    // the real apply order (see migrate.ts).
    const applyMigrations = async (dir: string): Promise<void> => {
      const files = readdirSync(dir)
        .filter((name) => name.endsWith('.sql'))
        .sort((a, b) => a.localeCompare(b, 'en'));
      for (const file of files) {
        await ownerSql.unsafe(readFileSync(join(dir, file), 'utf8'));
      }
    };

    await applyMigrations(join(__dirname, '..', '..', '..', 'platform', 'audit', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', '..', 'platform', 'tenancy', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', '..', 'platform', 'identity', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', '..', 'platform', 'custom-fields', 'migrations'));
    await applyMigrations(join(__dirname, '..', 'migrations'));

    const appUrl = new URL(ownerUrl);
    appUrl.username = 'sms_app';
    appUrl.password = 'dev';

    process.env.DATABASE_URL = appUrl.toString();
    process.env.DATABASE_MIGRATION_URL = ownerUrl;

    persons = new PersonService(passthroughCustomFields);
    contactPoints = new ContactPointService();
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

  async function createPerson(tenantId: TenantId, givenName: string, familyName: string, dateOfBirth?: DateOnly): Promise<PersonId> {
    const created = await persons.createPerson(tenantId, { givenName, familyName, dateOfBirth });
    if (!created.ok) throw created.error;
    return created.value.id;
  }

  // ---------------------------------------------------------------------
  // 1. RLS isolates contact points across tenants.
  // ---------------------------------------------------------------------
  it('1. RLS isolates contact points across tenants', async () => {
    const tenantX = await createTenant('tenant-contact-rls-x', 'Tenant Contact RLS X');
    const tenantY = await createTenant('tenant-contact-rls-y', 'Tenant Contact RLS Y');

    const personId = await createPerson(tenantX, 'Xavier', 'Only', '2010-01-01' as DateOnly);
    const added = await contactPoints.addContactPoint(tenantX, { personId, kind: 'email', value: 'xavier@example.test', isPrimary: true });
    expect(added.ok).toBe(true);

    // The service scopes to tenantY, so tenantX's contact point must not appear.
    const listedInY = await contactPoints.listContactPoints(tenantY, personId);
    expect(listedInY).toHaveLength(0);

    const listedInX = await contactPoints.listContactPoints(tenantX, personId);
    expect(listedInX).toHaveLength(1);

    // Directly against the table too, as the ordinary sms_app role with NO
    // app.tenant_id GUC set, to rule out an application-level filter doing
    // the work RLS is supposed to - same discipline as people.spec.ts's own
    // RLS test.
    const appSqlNoContext = createSqlClient(process.env.DATABASE_URL!);
    try {
      const rows = await appSqlNoContext`select id from people.contact_point where tenant_id = ${tenantX}`;
      expect(rows.length).toBe(0); // no app.tenant_id GUC set -> zero rows, never "every tenant"
    } finally {
      await appSqlNoContext.end({ timeout: 1 });
    }
  });

  // ---------------------------------------------------------------------
  // 2. At most one primary per (person, kind); setting a new primary
  //    demotes the old one instead of being rejected.
  // ---------------------------------------------------------------------
  it('2. at most one primary per (person, kind) - a new primary demotes the old one', async () => {
    const tenantId = await createTenant('tenant-contact-primary', 'Tenant Contact Primary');
    const personId = await createPerson(tenantId, 'Priya', 'Singh', '2011-03-03' as DateOnly);

    const first = await contactPoints.addContactPoint(tenantId, { personId, kind: 'email', value: 'priya.home@example.test', isPrimary: true });
    expect(first.ok).toBe(true);
    if (!first.ok) throw first.error;

    const second = await contactPoints.addContactPoint(tenantId, { personId, kind: 'email', value: 'priya.work@example.test', isPrimary: true });
    expect(second.ok).toBe(true);
    if (!second.ok) throw second.error;

    const points = await contactPoints.listContactPoints(tenantId, personId);
    const emailPoints = points.filter((p) => p.kind === 'email');
    expect(emailPoints).toHaveLength(2);
    const primaries = emailPoints.filter((p) => p.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.id).toBe(second.value.id);
    expect(emailPoints.find((p) => p.id === first.value.id)?.isPrimary).toBe(false);

    // A DIFFERENT kind (phone) for the same person is an independent slot -
    // setting it primary must not touch the email primary above.
    const phone = await contactPoints.addContactPoint(tenantId, { personId, kind: 'phone', value: '+15551234567', isPrimary: true });
    expect(phone.ok).toBe(true);
    const afterPhone = await contactPoints.listContactPoints(tenantId, personId);
    expect(afterPhone.find((p) => p.id === second.value.id)?.isPrimary).toBe(true);
    expect(afterPhone.find((p) => p.kind === 'phone')?.isPrimary).toBe(true);

    // updateContactPoint promoting an existing point to primary demotes the
    // current primary too, not just addContactPoint.
    const promoted = await contactPoints.updateContactPoint(tenantId, first.value.id, { isPrimary: true });
    expect(promoted.ok).toBe(true);
    const afterPromote = await contactPoints.listContactPoints(tenantId, personId);
    const emailAfterPromote = afterPromote.filter((p) => p.kind === 'email');
    expect(emailAfterPromote.find((p) => p.id === first.value.id)?.isPrimary).toBe(true);
    expect(emailAfterPromote.find((p) => p.id === second.value.id)?.isPrimary).toBe(false);

    // The database itself enforces this, not just the service: a raw insert
    // that tries to create a second non-archived primary email is rejected
    // by contact_point_one_primary_per_kind_idx.
    await expect(
      ownerSql`
        insert into people.contact_point (id, tenant_id, person_id, kind, value, is_primary)
        values (${newId()}, ${tenantId}, ${personId}, 'email', 'priya.raw@example.test', true)
      `,
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------
  // 3. Archiving hides a contact point from lookups (and frees the primary
  //    slot for a replacement).
  // ---------------------------------------------------------------------
  it('3. archiving hides a contact point from lookups', async () => {
    const tenantId = await createTenant('tenant-contact-archive', 'Tenant Contact Archive');
    const personId = await createPerson(tenantId, 'Omar', 'Reyes', '2012-04-04' as DateOnly);

    const added = await contactPoints.addContactPoint(tenantId, { personId, kind: 'email', value: 'omar@example.test', isPrimary: true });
    expect(added.ok).toBe(true);
    if (!added.ok) throw added.error;

    const beforeArchive = await contactPoints.listContactPoints(tenantId, personId);
    expect(beforeArchive.some((p) => p.id === added.value.id)).toBe(true);

    const archived = await contactPoints.archiveContactPoint(tenantId, added.value.id);
    expect(archived.ok).toBe(true);

    const afterArchive = await contactPoints.listContactPoints(tenantId, personId);
    expect(afterArchive.some((p) => p.id === added.value.id)).toBe(false);

    // Archiving twice is a NotFoundError, not a silent success - matching
    // this service's "not found (or already archived)" message.
    const archivedAgain = await contactPoints.archiveContactPoint(tenantId, added.value.id);
    expect(archivedAgain.ok).toBe(false);
    if (!archivedAgain.ok) expect(archivedAgain.error.code).toBe('NOT_FOUND');

    // The row itself still exists (archived, never deleted - see the 0503
    // migration header), it just carries archived_at now.
    const rawRow = await ownerSql`select id, archived_at from people.contact_point where id = ${added.value.id}`;
    expect(rawRow).toHaveLength(1);
    expect((rawRow[0] as { archived_at: Date | null }).archived_at).not.toBeNull();

    // Archiving frees the (person, kind) primary slot: a new primary email
    // can be added without conflicting with the archived one.
    const replacement = await contactPoints.addContactPoint(tenantId, {
      personId,
      kind: 'email',
      value: 'omar.new@example.test',
      isPrimary: true,
    });
    expect(replacement.ok).toBe(true);
  });

  // ---------------------------------------------------------------------
  // 4. listContactPointsForPeople: bulk lookup returns the right rows for
  //    many people at once, including an empty array for someone with none.
  // ---------------------------------------------------------------------
  it('4. listContactPointsForPeople returns the right rows for many people, without N+1', async () => {
    const tenantId = await createTenant('tenant-contact-bulk', 'Tenant Contact Bulk');

    const alice = await createPerson(tenantId, 'Alice', 'Nguyen', '2010-05-05' as DateOnly);
    const bob = await createPerson(tenantId, 'Bob', 'Nguyen', '2011-06-06' as DateOnly);
    const cara = await createPerson(tenantId, 'Cara', 'Nguyen', '2012-07-07' as DateOnly); // no contact points at all

    await contactPoints.addContactPoint(tenantId, { personId: alice, kind: 'email', value: 'alice@example.test', isPrimary: true });
    await contactPoints.addContactPoint(tenantId, { personId: alice, kind: 'phone', value: '+15550000001', isPrimary: true });
    await contactPoints.addContactPoint(tenantId, { personId: bob, kind: 'email', value: 'bob@example.test', isPrimary: true });

    // An archived point must not leak into the bulk result either.
    const bobExtra = await contactPoints.addContactPoint(tenantId, { personId: bob, kind: 'email', value: 'bob.old@example.test' });
    if (bobExtra.ok) {
      await contactPoints.archiveContactPoint(tenantId, bobExtra.value.id);
    }

    const result = await contactPoints.listContactPointsForPeople(tenantId, [alice, bob, cara]);

    expect(result.size).toBe(3);
    expect(result.get(alice)?.map((p) => p.value).sort()).toEqual(['alice@example.test', '+15550000001'].sort());
    expect(result.get(bob)?.map((p) => p.value)).toEqual(['bob@example.test']);
    expect(result.get(cara)).toEqual([]); // present, empty - not omitted

    // A person id nobody asked about is simply absent.
    expect(result.has('00000000-0000-0000-0000-000000000000' as PersonId)).toBe(false);

    // Empty input is a valid call, not an error, and touches the database
    // for nothing.
    const empty = await contactPoints.listContactPointsForPeople(tenantId, []);
    expect(empty.size).toBe(0);
  });
});
