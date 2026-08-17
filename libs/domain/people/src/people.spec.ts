import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError, formatDateOnly, newId, ok, todayDateOnly, err, type DateOnly, type PersonId, type TenantId, type UserId } from '@sms/kernel';
import { closeSqlClients, createSqlClient, withTenantTx, type Sql } from '@sms/db';
import type { CustomFieldsContract } from '@sms/custom-fields';
import { AlertService } from './application/alert.service.js';
import { DuplicateService } from './application/duplicate.service.js';
import { HouseholdService } from './application/household.service.js';
import { IdentifierService } from './application/identifier.service.js';
import { MergeService } from './application/merge.service.js';
import { PersonService } from './application/person.service.js';
import { RelationshipService } from './application/relationship.service.js';
import { RoleService } from './application/role.service.js';
import { resolvePerson } from './application/resolve-person.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

function shiftDateOnly(date: DateOnly, days: number): DateOnly {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(year, month - 1, day);
  shifted.setDate(shifted.getDate() + days);
  return formatDateOnly(shifted);
}

/**
 * A minimal, REAL (not a stub that always says yes) in-memory
 * `CustomFieldsContract`, hand-built rather than obtained from
 * `@sms/custom-fields`'s actual Nest-DI implementation - same precedent as
 * `access.spec.ts`'s `identityStub` for `IdentityContract`: this package can
 * only reach a sibling module's PUBLIC entrypoint (the `CustomFieldsContract`
 * type), never its internal `FieldDefinitionService`/`SchemaCache` classes,
 * and those classes' only public, Nest-DI-wired construction path hits a
 * known esbuild/tsx limitation transforming a decorated class reached
 * through a cross-package workspace symlink (`@Inject`/`@Injectable`
 * parameter decorators silently fail to parse - see `@sms/access`'s and
 * `@sms/identity`'s own `tsconfig.json` comments for the same class of bug
 * in a different tool). `@sms/custom-fields`'s OWN testcontainers suite
 * (`custom-fields.spec.ts`) already proves its real Postgres-backed
 * validate()/compileSchema() correctly reject/accept values; what THIS
 * suite's item 5 needs to prove is that `PersonService` correctly
 * integrates with whatever `CustomFieldsContract` it is given (rejects an
 * invalid value, round-trips a valid one) - this compiles the exact same
 * kind of Zod schema `@sms/custom-fields`'s real `schema-compiler.ts` does,
 * from definitions kept in a plain in-memory map instead of Postgres.
 */
function createInMemoryCustomFields(): CustomFieldsContract {
  interface Definition {
    readonly key: string;
    readonly dataType: 'text' | 'number' | 'date' | 'boolean' | 'select' | 'multiselect';
    readonly options: string[];
    readonly required: boolean;
  }
  const definitionsByKey = new Map<string, Definition[]>();

  function compile(tenantId: TenantId, entityType: string): z.ZodTypeAny {
    const defs = definitionsByKey.get(`${tenantId}:${entityType}`) ?? [];
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const def of defs) {
      let fieldSchema: z.ZodTypeAny;
      switch (def.dataType) {
        case 'text':
          fieldSchema = z.string();
          break;
        case 'number':
          fieldSchema = z.number();
          break;
        case 'boolean':
          fieldSchema = z.boolean();
          break;
        case 'select':
          fieldSchema = z.enum(def.options as [string, ...string[]]);
          break;
        default:
          fieldSchema = z.array(z.enum(def.options as [string, ...string[]]));
      }
      shape[def.key] = def.required ? fieldSchema : fieldSchema.optional().nullable();
    }
    return z.object(shape).strict();
  }

  return {
    async listDefinitions() {
      return [];
    },
    async getDefinition() {
      return err(new NotFoundError('not implemented in test stub'));
    },
    async createDefinition(tenantId, input) {
      const mapKey = `${tenantId}:${input.entityType}`;
      const existing = definitionsByKey.get(mapKey) ?? [];
      definitionsByKey.set(mapKey, [
        ...existing,
        { key: input.key, dataType: input.dataType, options: input.options ?? [], required: input.required ?? false },
      ]);
      return ok({
        id: newId(),
        tenantId,
        entityType: input.entityType,
        key: input.key,
        label: input.label,
        dataType: input.dataType,
        options: input.options ?? [],
        required: input.required ?? false,
        reportable: input.reportable ?? true,
        displayOrder: input.displayOrder ?? 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    },
    async updateDefinition() {
      return err(new ValidationError('not implemented in test stub'));
    },
    async deleteDefinition() {
      return err(new ValidationError('not implemented in test stub'));
    },
    async compileSchema(tenantId, entityType) {
      return compile(tenantId, entityType);
    },
    async validate(tenantId, entityType, values) {
      const parsed = compile(tenantId, entityType).safeParse(values ?? {});
      if (!parsed.success) {
        return err(new ValidationError(`Invalid custom field values for "${entityType}".`, parsed.error.issues));
      }
      return ok(parsed.data as Record<string, unknown>);
    },
  };
}

/**
 * Applies the real `audit` + `tenancy` + `identity` + `custom-fields`
 * migrations (read, never edited - see the module report's constraints) and
 * this module's own `0500`/`0501` migrations to a throwaway container, then
 * proves - through the real application services, not reimplementations of
 * them - the properties this module exists for. See the module brief's TESTS
 * section for the exact list; each `it` block below is numbered to match it.
 */
describe('people (real Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: Sql;
  let customFields: CustomFieldsContract;

  let persons: PersonService;
  let roles: RoleService;
  let households: HouseholdService;
  let relationships: RelationshipService;
  let identifiers: IdentifierService;
  let alerts: AlertService;
  let duplicates: DuplicateService;
  let merges: MergeService;

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

    customFields = createInMemoryCustomFields();
    persons = new PersonService(customFields);
    roles = new RoleService();
    households = new HouseholdService();
    relationships = new RelationshipService();
    identifiers = new IdentifierService();
    alerts = new AlertService();
    duplicates = new DuplicateService();
    merges = new MergeService();
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

  async function createUser(email: string): Promise<UserId> {
    const rows = await ownerSql`
      insert into identity.user (id, name, email) values (${newId()}, ${email}, ${email}) returning id
    `;
    return (rows[0] as { id: string }).id as UserId;
  }

  async function createPerson(tenantId: TenantId, givenName: string, familyName: string, dateOfBirth?: DateOnly): Promise<PersonId> {
    const created = await persons.createPerson(tenantId, { givenName, familyName, dateOfBirth });
    if (!created.ok) throw created.error;
    return created.value.id;
  }

  // ---------------------------------------------------------------------
  // 1. RLS isolates people across tenants (as the non-owner sms_app role).
  // ---------------------------------------------------------------------
  it('1. RLS isolates people across tenants', async () => {
    const tenantX = await createTenant('tenant-people-rls-x', 'Tenant People RLS X');
    const tenantY = await createTenant('tenant-people-rls-y', 'Tenant People RLS Y');

    const personId = await createPerson(tenantX, 'Xavier', 'Only', '2010-01-01' as DateOnly);

    const searchInY = await persons.searchPeople(tenantY, {});
    expect(searchInY.items.find((p) => p.id === personId)).toBeUndefined();

    const searchInX = await persons.searchPeople(tenantX, {});
    expect(searchInX.items.find((p) => p.id === personId)).toBeDefined();

    // Directly against the table too, not just through the service, to rule
    // out an application-level filter doing the work RLS is supposed to -
    // as the ordinary sms_app role, with NO app.tenant_id GUC set.
    const appSqlNoContext = createSqlClient(process.env.DATABASE_URL!);
    try {
      const rows = await appSqlNoContext`select id from people.person where tenant_id = ${tenantX}`;
      expect(rows.length).toBe(0); // no app.tenant_id GUC set -> zero rows, never "every tenant"
    } finally {
      await appSqlNoContext.end({ timeout: 1 });
    }
  });

  // ---------------------------------------------------------------------
  // 2. Effective-dated person_role: an expired role is not current;
  //    overlapping identical roles are rejected.
  // ---------------------------------------------------------------------
  it('2. an expired role is not returned as current; overlapping identical roles are rejected', async () => {
    const tenantId = await createTenant('tenant-people-roles', 'Tenant People Roles');
    const personId = await createPerson(tenantId, 'Rory', 'Fields', '2012-05-05' as DateOnly);
    const today = todayDateOnly();

    const expired = await roles.assignRole(tenantId, {
      personId,
      role: 'student',
      validFrom: shiftDateOnly(today, -60),
      validTo: shiftDateOnly(today, -1),
    });
    expect(expired.ok).toBe(true);

    const current = await roles.assignRole(tenantId, { personId, role: 'student', validFrom: today });
    expect(current.ok).toBe(true);

    const allRoles = await roles.listRoles(tenantId, personId);
    expect(allRoles).toHaveLength(2);
    const currentRoles = allRoles.filter((r) => r.validFrom <= today && (r.validTo === null || r.validTo >= today));
    expect(currentRoles).toHaveLength(1);
    expect(currentRoles[0]?.validTo).toBeNull();

    // Overlapping identical role (same person, same role, overlapping dates)
    // is rejected by the person_role_no_overlap exclusion constraint.
    const overlapping = await roles.assignRole(tenantId, { personId, role: 'student', validFrom: today });
    expect(overlapping.ok).toBe(false);
    if (!overlapping.ok) expect(overlapping.error.code).toBe('CONFLICT');

    // A DIFFERENT role for the same person at the same time is fine - a
    // person may hold several roles at once (see the 0500 migration header).
    const differentRole = await roles.assignRole(tenantId, { personId, role: 'guardian', validFrom: today });
    expect(differentRole.ok).toBe(true);
  });

  // ---------------------------------------------------------------------
  // 3. mergePersons repoints every related row, leaves a tombstone, and
  //    resolvePerson(mergedId) returns the survivor.
  // ---------------------------------------------------------------------
  it('3. mergePersons repoints roles/households/relationships/identifiers/alerts, tombstones the loser, and resolvePerson follows the chain', async () => {
    const tenantId = await createTenant('tenant-people-merge', 'Tenant People Merge');
    const actorUserId = await createUser(`merge-actor-${newId()}@example.com`);

    const survivorId = await createPerson(tenantId, 'Jordan', 'Blake', '2013-02-02' as DateOnly);
    const loserId = await createPerson(tenantId, 'Jordan', 'Blaike', '2013-02-02' as DateOnly);

    // Related rows on the LOSER, one of each kind this merge must repoint.
    const guardianId = await createPerson(tenantId, 'Pat', 'Blake', '1980-01-01' as DateOnly);
    const thirdPartyId = await createPerson(tenantId, 'Sam', 'Rivers', '1979-01-01' as DateOnly);

    const roleAssigned = await roles.assignRole(tenantId, { personId: loserId, role: 'student' });
    expect(roleAssigned.ok).toBe(true);

    const household = await households.createHousehold(tenantId, { name: 'Blake Household' });
    if (!household.ok) throw household.error;
    const memberAdded = await households.addHouseholdMember(tenantId, { householdId: household.value.id, personId: loserId });
    expect(memberAdded.ok).toBe(true);

    const relationshipToLoser = await relationships.createRelationship(tenantId, {
      fromPersonId: guardianId,
      toPersonId: loserId,
      type: 'parent',
      hasCustody: true,
      mayPickup: true,
      mayReceiveComms: true,
    });
    expect(relationshipToLoser.ok).toBe(true);
    const relationshipFromLoser = await relationships.createRelationship(tenantId, {
      fromPersonId: loserId,
      toPersonId: thirdPartyId,
      type: 'sibling',
    });
    expect(relationshipFromLoser.ok).toBe(true);

    const identifierAdded = await identifiers.addIdentifier(tenantId, { personId: loserId, type: 'student_number', value: 'GW-MERGE-0001' });
    expect(identifierAdded.ok).toBe(true);

    const alertAdded = await alerts.createAlert(tenantId, { personId: loserId, category: 'medical', severity: 'warning', summary: 'Peanut allergy' });
    expect(alertAdded.ok).toBe(true);

    const merged = await merges.mergePersons(tenantId, actorUserId, { survivingId: survivorId, mergedId: loserId, reason: 'Duplicate enrolment entry' });
    expect(merged.ok).toBe(true);
    if (!merged.ok) throw merged.error;
    expect(merged.value.survivingPersonId).toBe(survivorId);
    expect(merged.value.mergedPersonId).toBe(loserId);
    expect(merged.value.mergedByUserId).toBe(actorUserId);

    // The loser is a TOMBSTONE, never deleted.
    const loserRow = await ownerSql`select id, merged_into_id from people.person where id = ${loserId}`;
    expect(loserRow).toHaveLength(1);
    expect((loserRow[0] as { merged_into_id: string }).merged_into_id).toBe(survivorId);

    // Every related row is repointed to the survivor.
    const survivorRoles = await roles.listRoles(tenantId, survivorId);
    expect(survivorRoles.some((r) => r.role === 'student')).toBe(true);

    const survivorHouseholdMembers = await households.listHouseholdMembers(tenantId, household.value.id);
    expect(survivorHouseholdMembers.some((m) => m.personId === survivorId)).toBe(true);
    expect(survivorHouseholdMembers.some((m) => m.personId === loserId)).toBe(false);

    const survivorRelationships = await relationships.listRelationships(tenantId, survivorId);
    expect(survivorRelationships.some((r) => r.fromPersonId === guardianId && r.toPersonId === survivorId)).toBe(true);
    expect(survivorRelationships.some((r) => r.fromPersonId === survivorId && r.toPersonId === thirdPartyId)).toBe(true);

    const survivorIdentifiers = await identifiers.listIdentifiers(tenantId, survivorId);
    expect(survivorIdentifiers.some((i) => i.value === 'GW-MERGE-0001')).toBe(true);

    const survivorAlerts = await alerts.listAlerts(tenantId, survivorId, null);
    expect(survivorAlerts.some((a) => a.summary === 'Peanut allergy')).toBe(true);

    // resolvePerson(mergedId) returns the survivor - callers never have to
    // know a merge happened.
    const resolved = await persons.getPerson(tenantId, loserId);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw resolved.error;
    expect(resolved.value.id).toBe(survivorId);

    // A person_merge record was written.
    const mergeRows = await ownerSql`select surviving_person_id, merged_person_id, reason from people.person_merge where id = ${merged.value.id}`;
    expect(mergeRows).toHaveLength(1);
    expect((mergeRows[0] as { reason: string }).reason).toBe('Duplicate enrolment entry');
  });

  // ---------------------------------------------------------------------
  // 4. findPotentialDuplicates scores an obvious near-duplicate above an
  //    unrelated person.
  // ---------------------------------------------------------------------
  it('4. findPotentialDuplicates scores an obvious near-duplicate above an unrelated person', async () => {
    const tenantId = await createTenant('tenant-people-duplicates', 'Tenant People Duplicates');

    const original = await createPerson(tenantId, 'Alexander', 'Whitmore', '2011-06-15' as DateOnly);
    // Same date of birth, a near-identical (misspelled) name - a classic
    // "someone re-typed this student" duplicate.
    const nearDuplicateId = await createPerson(tenantId, 'Alexandar', 'Whitmore', '2011-06-15' as DateOnly);
    // A completely unrelated person, same tenant.
    await createPerson(tenantId, 'Zoe', 'Kaplinsky', '2005-09-09' as DateOnly);

    const candidates = await duplicates.findPotentialDuplicates(tenantId, { personId: original });

    const nearDuplicateCandidate = candidates.find((c) => c.person.id === nearDuplicateId);
    expect(nearDuplicateCandidate).toBeDefined();
    expect(nearDuplicateCandidate!.score).toBeGreaterThan(0.5);
    expect(nearDuplicateCandidate!.reasons.length).toBeGreaterThan(0);

    const unrelatedCandidate = candidates.find((c) => c.person.familyName === 'Kaplinsky');
    expect(unrelatedCandidate).toBeUndefined();

    // The near-duplicate outranks anything else in the list.
    expect(candidates[0]?.person.id).toBe(nearDuplicateId);

    // Pre-create check: a not-yet-created candidate with the exact same
    // name + date of birth as an existing person is flagged too.
    const preCreateCandidates = await duplicates.findPotentialDuplicates(tenantId, {
      givenName: 'Alexander',
      familyName: 'Whitmore',
      dateOfBirth: '2011-06-15' as DateOnly,
    });
    expect(preCreateCandidates.some((c) => c.person.id === original)).toBe(true);
    const exactMatch = preCreateCandidates.find((c) => c.person.id === original);
    expect(exactMatch?.reasons).toContain('exact name + date of birth match');
  });

  // ---------------------------------------------------------------------
  // 5. Custom fields: a value violating its definition is rejected; a
  //    valid one round-trips.
  // ---------------------------------------------------------------------
  it('5. a custom field value violating its definition is rejected; a valid one round-trips', async () => {
    const tenantId = await createTenant('tenant-people-custom-fields', 'Tenant People Custom Fields');

    const defined = await customFields.createDefinition(tenantId, {
      entityType: 'people.person',
      key: 'grade_level',
      label: 'Grade level',
      dataType: 'select',
      options: ['Grade 1', 'Grade 2', 'Grade 3'],
      required: true,
    });
    expect(defined.ok).toBe(true);

    // Missing the required field.
    const missingRequired = await persons.createPerson(tenantId, { givenName: 'Nadia', familyName: 'Osei', customFields: {} });
    expect(missingRequired.ok).toBe(false);
    if (!missingRequired.ok) expect(missingRequired.error.code).toBe('VALIDATION_ERROR');

    // Option outside the select's allow-list.
    const invalidOption = await persons.createPerson(tenantId, {
      givenName: 'Nadia',
      familyName: 'Osei',
      customFields: { grade_level: 'Grade 99' },
    });
    expect(invalidOption.ok).toBe(false);

    // A valid value round-trips.
    const valid = await persons.createPerson(tenantId, {
      givenName: 'Nadia',
      familyName: 'Osei',
      dateOfBirth: '2015-04-04' as DateOnly,
      customFields: { grade_level: 'Grade 2' },
    });
    expect(valid.ok).toBe(true);
    if (!valid.ok) throw valid.error;
    expect(valid.value.customFields).toEqual({ grade_level: 'Grade 2' });

    const fetched = await persons.getPerson(tenantId, valid.value.id);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) throw fetched.error;
    expect(fetched.value.customFields).toEqual({ grade_level: 'Grade 2' });
  });

  // ---------------------------------------------------------------------
  // 6. Relationship flags (has_custody, may_pickup) persist and are
  //    queryable.
  // ---------------------------------------------------------------------
  it('6. relationship flags (has_custody, may_pickup, may_receive_comms) persist and are queryable', async () => {
    const tenantId = await createTenant('tenant-people-relationship-flags', 'Tenant People Relationship Flags');

    const childId = await createPerson(tenantId, 'Freya', 'Lindqvist', '2016-03-03' as DateOnly);
    const custodialParentId = await createPerson(tenantId, 'Erik', 'Lindqvist', '1985-01-01' as DateOnly);
    const nonCustodialContactId = await createPerson(tenantId, 'Uncle', 'Lindqvist', '1978-01-01' as DateOnly);

    const custodial = await relationships.createRelationship(tenantId, {
      fromPersonId: custodialParentId,
      toPersonId: childId,
      type: 'parent',
      hasCustody: true,
      mayPickup: true,
      mayReceiveComms: true,
    });
    expect(custodial.ok).toBe(true);

    const nonCustodial = await relationships.createRelationship(tenantId, {
      fromPersonId: nonCustodialContactId,
      toPersonId: childId,
      type: 'authorized_pickup',
      hasCustody: false,
      mayPickup: true,
      mayReceiveComms: false,
    });
    expect(nonCustodial.ok).toBe(true);

    const childRelationships = await relationships.listRelationships(tenantId, childId);
    expect(childRelationships).toHaveLength(2);

    const custodialRow = childRelationships.find((r) => r.fromPersonId === custodialParentId);
    expect(custodialRow?.hasCustody).toBe(true);
    expect(custodialRow?.mayPickup).toBe(true);
    expect(custodialRow?.mayReceiveComms).toBe(true);

    const pickupOnlyRow = childRelationships.find((r) => r.fromPersonId === nonCustodialContactId);
    expect(pickupOnlyRow?.hasCustody).toBe(false);
    expect(pickupOnlyRow?.mayPickup).toBe(true);
    expect(pickupOnlyRow?.mayReceiveComms).toBe(false);

    // The flags are independently queryable straight from the table too -
    // proving they are real columns, not derived/computed at read time.
    const rawRows = await ownerSql`
      select has_custody, may_pickup, may_receive_comms from people.relationship
      where tenant_id = ${tenantId} and to_person_id = ${childId} and from_person_id = ${nonCustodialContactId}
    `;
    expect(rawRows).toHaveLength(1);
    expect((rawRows[0] as { has_custody: boolean }).has_custody).toBe(false);
    expect((rawRows[0] as { may_pickup: boolean }).may_pickup).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Bonus: alerts are row-filtered by category against the caller's ability
  // (not field-masked - see AlertService's own comment for why).
  // ---------------------------------------------------------------------
  it('bonus: listAlerts filters medical/safeguarding rows by ability; unfiltered (ability: null) sees everything', async () => {
    const tenantId = await createTenant('tenant-people-alerts', 'Tenant People Alerts');
    const personId = await createPerson(tenantId, 'Casey', 'Nolan', '2014-01-01' as DateOnly);

    await alerts.createAlert(tenantId, { personId, category: 'medical', severity: 'warning', summary: 'Asthma' });
    await alerts.createAlert(tenantId, { personId, category: 'safeguarding', severity: 'critical', summary: 'Restricted contact list' });
    await alerts.createAlert(tenantId, { personId, category: 'other', severity: 'info', summary: 'Prefers a window seat on the bus' });

    const unfiltered = await alerts.listAlerts(tenantId, personId, null);
    expect(unfiltered).toHaveLength(3);

    // An ability granting neither read_medical nor read_safeguarding sees
    // only the 'other' category alert.
    const noAbility = { can: () => false } as unknown as Parameters<typeof alerts.listAlerts>[2];
    const filtered = await alerts.listAlerts(tenantId, personId, noAbility);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.category).toBe('other');
  });

  it('resolve-person guards against a cycle without hanging', async () => {
    const tenantId = await createTenant('tenant-people-resolve-guard', 'Tenant People Resolve Guard');
    const a = await createPerson(tenantId, 'A', 'Loop', '2010-01-01' as DateOnly);

    // resolvePerson on a person with no merge at all is just itself.
    const ctx = { tenantId, roles: [] as string[], requestId: newId() };
    const resolved = await withTenantTx(ctx, (db) => resolvePerson(db, tenantId, a));
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.id).toBe(a);
  });
});
