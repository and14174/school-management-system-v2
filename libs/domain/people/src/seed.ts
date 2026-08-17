#!/usr/bin/env tsx
/**
 * Idempotent local-dev/CI seed data: ~40 people for Greenwood - students
 * across grade levels (via a `grade_level` custom field), guardians linked
 * by `relationship` into `household`s, and a handful of staff (including
 * `admin@greenwood.test`'s own linked person record - see
 * `linkAdminMembership` below, which closes the `identity.membership.
 * person_id` loop the `0501` migration's FK made real). Includes one
 * deliberate near-duplicate student pair ("Emily Carter" / "Emilie Carter",
 * same date of birth, entered into two different households) so
 * `findPotentialDuplicates` has something real to surface.
 *
 * Complements (does not modify - see the module report's constraints)
 * `@sms/tenancy`'s, `@sms/identity`'s and `@sms/access`'s own `seed.ts`: all
 * three must have already run (this script looks up the "greenwood" tenant,
 * its campuses, and the admin user/membership, and fails with a clear
 * message if any is missing).
 *
 * Every person/household/role/relationship/identifier check-then-creates (or
 * relies on a real DB constraint plus a CONFLICT catch) so re-running this
 * script converges rather than duplicating rows - same discipline as
 * `@sms/tenancy`'s and `@sms/access`'s own seeds.
 *
 * Usage: tsx src/seed.ts (run after tenancy's, identity's and access's).
 */
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { closeSqlClients, withSystemTx } from '@sms/db';
import { newId, ok, type CampusId, type DateOnly, type PersonId, type TenantId, type UserId } from '@sms/kernel';
import type { CustomFieldsContract } from '@sms/custom-fields';
import type { ContactPointKind, PersonRoleType, RelationshipType } from './domain/types.js';
import { AlertService } from './application/alert.service.js';
import { ContactPointService } from './application/contact-point.service.js';
import { HouseholdService } from './application/household.service.js';
import { IdentifierService } from './application/identifier.service.js';
import { PersonService } from './application/person.service.js';
import { RelationshipService } from './application/relationship.service.js';
import { RoleService } from './application/role.service.js';
import { toPerson } from './infrastructure/mappers.js';
import { personTable } from './infrastructure/schema.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// Resolved relative to this file, not process.cwd() - see @sms/tenancy's migrate.ts/seed.ts for why.
try {
  process.loadEnvFile(join(__dirname, '..', '..', '..', '..', '.env'));
} catch {
  // no .env file present - assume the environment already has what we need
}

const ADMIN_EMAIL = 'admin@greenwood.test';

/**
 * `PersonService` needs a `CustomFieldsContract` to validate `custom_fields`
 * against - the real implementation lives in `@sms/custom-fields`'s
 * internal `application/*`, which (like every sibling module's internals)
 * this package can only reach through its public entrypoint, and that
 * entrypoint's real implementation is Nest-DI-only (no standalone
 * constructor a seed script can `new` up the way `@sms/access`'s `seed.ts`
 * does for `RoleService`/`AbilityService`). Every person seeded below has
 * `customFields` that are either empty or match the one `grade_level`
 * definition this script writes directly (see `ensureGradeLevelFieldDefinition`) -
 * a fact this script controls completely - so a trivial pass-through
 * satisfies `PersonService` correctly for this use, without needing a real
 * schema compiler standing in for it.
 */
const passthroughCustomFields: CustomFieldsContract = {
  async listDefinitions() {
    return [];
  },
  async getDefinition() {
    throw new Error('not implemented in seed');
  },
  async createDefinition() {
    throw new Error('not implemented in seed');
  },
  async updateDefinition() {
    throw new Error('not implemented in seed');
  },
  async deleteDefinition() {
    throw new Error('not implemented in seed');
  },
  async compileSchema() {
    return z.record(z.string(), z.unknown());
  },
  async validate(_tenantId, _entityType, values) {
    return ok((values ?? {}) as Record<string, unknown>);
  },
};

const persons = new PersonService(passthroughCustomFields);
const roles = new RoleService();
const households = new HouseholdService();
const relationships = new RelationshipService();
const identifiers = new IdentifierService();
const alerts = new AlertService();
const contactPoints = new ContactPointService();

/**
 * `given.family.<8-hex>@example.test`, where the 8 hex chars are a SHA-1 of
 * `personId` - deterministic (same person -> same address every run, so
 * re-running this script converges instead of piling up duplicate contact
 * points) without needing a counter or any state beyond the person's own id.
 * `@example.test` (RFC 2606 reserved) rather than a made-up domain: Mailpit
 * accepts and records mail to any address regardless of whether a real
 * mailbox exists, so these deliver fine in local dev while never risking a
 * real inbox if the domain is ever wrong.
 */
function seedEmailAddress(personId: PersonId, givenName: string, familyName: string): string {
  const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'person';
  const shortId = createHash('sha1').update(personId).digest('hex').slice(0, 8);
  return `${slug(givenName)}.${slug(familyName)}.${shortId}@example.test`;
}

/** A deterministic-but-fake `+1555XXXXXXX` number, same reasoning as `seedEmailAddress`. */
function seedPhoneNumber(personId: PersonId): string {
  const hex = createHash('sha1').update(personId).digest('hex');
  let digits = '';
  for (let i = 0; i < 7; i += 1) {
    digits += (parseInt(hex[i]!, 16) % 10).toString();
  }
  return `+1555${digits}`;
}

/**
 * Check-then-create, same discipline as the rest of this script's `ensure*`
 * helpers - there is no database constraint that would turn a repeat insert
 * into a catchable CONFLICT here (unlike `person_identifier`'s `(tenant_id,
 * type, value)` unique index, `contact_point.value` is not unique), so this
 * queries first rather than relying on one.
 */
async function ensureContactPoint(
  tenantId: TenantId,
  personId: PersonId,
  kind: ContactPointKind,
  value: string,
  isPrimary: boolean,
): Promise<void> {
  const existing = await withSystemTx((db) =>
    db.execute<{ id: string }>(
      sql`select id from people.contact_point where tenant_id = ${tenantId} and person_id = ${personId} and kind = ${kind} and value = ${value} and archived_at is null limit 1`,
    ),
  );
  if ((existing as unknown as unknown[]).length > 0) {
    console.log(`  skip   ${kind} contact point for person ${personId} (already exists)`);
    return;
  }
  const created = await contactPoints.addContactPoint(tenantId, { personId, kind, value, isPrimary });
  if (!created.ok) {
    throw created.error;
  }
  console.log(`  create ${kind} contact point for person ${personId}`);
}

const GRADE_LEVELS = [
  'Kindergarten',
  'Grade 1',
  'Grade 2',
  'Grade 3',
  'Grade 4',
  'Grade 5',
  'Grade 6',
  'Grade 7',
  'Grade 8',
  'Grade 9',
  'Grade 10',
  'Grade 11',
  'Grade 12',
] as const;

async function findGreenwoodTenantId(): Promise<TenantId> {
  const rows = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from tenancy.tenant where slug = 'greenwood' limit 1`));
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error(
      'No tenant with slug "greenwood" found. Run @sms/tenancy\'s seed first: ' +
        '(cd libs/platform/tenancy && ../../../node_modules/.bin/tsx src/seed.ts)',
    );
  }
  return row.id as TenantId;
}

async function findCampusId(tenantId: TenantId, code: string): Promise<CampusId> {
  const rows = await withSystemTx((db) =>
    db.execute<{ id: string }>(sql`select id from tenancy.campus where tenant_id = ${tenantId} and code = ${code} limit 1`),
  );
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error(`No campus "${code}" found for tenant "greenwood". Run @sms/tenancy's seed first.`);
  }
  return row.id as CampusId;
}

async function findAdminUserId(): Promise<UserId> {
  const rows = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from identity.user where email = ${ADMIN_EMAIL} limit 1`));
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error(
      `No user "${ADMIN_EMAIL}" found. Run @sms/identity's seed first: ` +
        '(cd libs/platform/identity && ../../../node_modules/.bin/tsx src/seed.ts)',
    );
  }
  return row.id as UserId;
}

/**
 * Written directly via raw SQL against `custom_fields.field_definition`,
 * not through `CUSTOM_FIELDS_CONTRACT` - see `passthroughCustomFields`'s
 * comment for why this script cannot reach the real implementation. This is
 * the same "seed scripts freely touch another module's tables directly"
 * precedent `@sms/access`'s and `@sms/identity`'s own seeds already rely on
 * for `tenancy.tenant`/`identity.user`.
 */
async function ensureGradeLevelFieldDefinition(tenantId: TenantId): Promise<void> {
  const existing = await withSystemTx((db) =>
    db.execute<{ id: string }>(
      sql`select id from custom_fields.field_definition where tenant_id = ${tenantId} and entity_type = 'people.person' and key = 'grade_level' limit 1`,
    ),
  );
  if ((existing as unknown as unknown[]).length > 0) {
    console.log('  skip   custom field "grade_level" (already exists)');
    return;
  }
  await withSystemTx((db) =>
    db.execute(sql`
      insert into custom_fields.field_definition (id, tenant_id, entity_type, key, label, data_type, options, required, reportable, display_order)
      values (${newId()}, ${tenantId}, 'people.person', 'grade_level', 'Grade level', 'select', ${JSON.stringify(GRADE_LEVELS)}::jsonb, false, true, 0)
    `),
  );
  console.log('  create custom field "grade_level"');
}

async function linkAdminMembership(tenantId: TenantId, adminUserId: UserId, personId: PersonId): Promise<void> {
  const rows = await withSystemTx((db) =>
    db.execute<{ person_id: string | null }>(
      sql`select person_id from identity.membership where tenant_id = ${tenantId} and user_id = ${adminUserId} limit 1`,
    ),
  );
  const row = (rows as unknown as Array<{ person_id: string | null }>)[0];
  if (!row) {
    throw new Error(`No membership found for "${ADMIN_EMAIL}" on tenant "greenwood" - run @sms/identity's seed first.`);
  }
  if (row.person_id) {
    console.log(`  skip   membership -> person link for ${ADMIN_EMAIL} (already linked)`);
    return;
  }
  await withSystemTx((db) =>
    db.execute(sql`update identity.membership set person_id = ${personId} where tenant_id = ${tenantId} and user_id = ${adminUserId}`),
  );
  console.log(`  link   membership for ${ADMIN_EMAIL} -> person ${personId}`);
}

async function findPersonByNameAndDob(tenantId: TenantId, givenName: string, familyName: string, dateOfBirth: DateOnly | null) {
  const rows = await withSystemTx((db) =>
    db
      .select()
      .from(personTable)
      .where(
        dateOfBirth
          ? sql`${personTable.tenantId} = ${tenantId} and ${personTable.givenName} = ${givenName} and ${personTable.familyName} = ${familyName} and ${personTable.dateOfBirth} = ${dateOfBirth}`
          : eq(personTable.tenantId, tenantId),
      )
      .limit(1),
  );
  const row = rows[0];
  return row ? toPerson(row) : null;
}

interface PersonSpec {
  readonly givenName: string;
  readonly familyName: string;
  readonly dateOfBirth: DateOnly;
  readonly gender?: string;
  readonly gradeLevel?: string;
}

async function ensurePerson(tenantId: TenantId, spec: PersonSpec): Promise<PersonId> {
  const existing = await findPersonByNameAndDob(tenantId, spec.givenName, spec.familyName, spec.dateOfBirth);
  if (existing) {
    console.log(`  skip   person "${spec.givenName} ${spec.familyName}" (already exists)`);
    return existing.id;
  }

  const created = await persons.createPerson(tenantId, {
    givenName: spec.givenName,
    familyName: spec.familyName,
    dateOfBirth: spec.dateOfBirth,
    gender: spec.gender,
    customFields: spec.gradeLevel ? { grade_level: spec.gradeLevel } : {},
  });
  if (!created.ok) {
    throw created.error;
  }
  console.log(`  create person "${spec.givenName} ${spec.familyName}"`);
  return created.value.id;
}

async function ensureRole(tenantId: TenantId, personId: PersonId, role: PersonRoleType, campusId: CampusId | null): Promise<void> {
  const assigned = await roles.assignRole(tenantId, { personId, role, campusId: campusId ?? undefined });
  if (assigned.ok) {
    return;
  }
  if (assigned.error.code !== 'CONFLICT') {
    throw assigned.error;
  }
  // person_role_no_overlap already holds a current assignment - idempotent skip.
}

async function ensureIdentifier(tenantId: TenantId, personId: PersonId, type: 'student_number', value: string): Promise<void> {
  const added = await identifiers.addIdentifier(tenantId, { personId, type, value });
  if (added.ok || added.error.code === 'CONFLICT') {
    return;
  }
  throw added.error;
}

async function ensureHousehold(tenantId: TenantId, name: string): Promise<string> {
  const existing = await withSystemTx((db) =>
    db.execute<{ id: string }>(sql`select id from people.household where tenant_id = ${tenantId} and name = ${name} limit 1`),
  );
  const row = (existing as unknown as Array<{ id: string }>)[0];
  if (row) {
    return row.id;
  }
  const created = await households.createHousehold(tenantId, { name });
  if (!created.ok) {
    throw created.error;
  }
  console.log(`  create household "${name}"`);
  return created.value.id;
}

async function ensureHouseholdMember(tenantId: TenantId, householdId: string, personId: PersonId, isPrimaryContact: boolean): Promise<void> {
  const added = await households.addHouseholdMember(tenantId, { householdId, personId, isPrimaryContact });
  if (added.ok || added.error.code === 'CONFLICT') {
    return;
  }
  throw added.error;
}

interface RelationshipFlags {
  readonly hasCustody: boolean;
  readonly mayPickup: boolean;
  readonly mayReceiveComms: boolean;
}

async function ensureRelationship(
  tenantId: TenantId,
  fromPersonId: PersonId,
  toPersonId: PersonId,
  type: RelationshipType,
  flags: RelationshipFlags,
): Promise<void> {
  const created = await relationships.createRelationship(tenantId, { fromPersonId, toPersonId, type, ...flags });
  if (created.ok || created.error.code === 'CONFLICT') {
    return;
  }
  throw created.error;
}

async function ensureAlert(
  tenantId: TenantId,
  personId: PersonId,
  category: 'medical' | 'safeguarding',
  severity: 'info' | 'warning' | 'critical',
  summary: string,
): Promise<void> {
  const existing = await withSystemTx((db) =>
    db.execute<{ id: string }>(
      sql`select id from people.person_alert where tenant_id = ${tenantId} and person_id = ${personId} and category = ${category} and summary = ${summary} limit 1`,
    ),
  );
  if ((existing as unknown as unknown[]).length > 0) {
    return;
  }
  const created = await alerts.createAlert(tenantId, { personId, category, severity, summary });
  if (!created.ok) {
    throw created.error;
  }
  console.log(`  create ${category} alert for person ${personId}`);
}

interface GuardianSpec extends PersonSpec {
  readonly relation: RelationshipType;
  readonly flags: RelationshipFlags;
  readonly isPrimaryContact: boolean;
}

interface FamilySpec {
  readonly householdName: string;
  readonly guardians: GuardianSpec[];
  readonly children: PersonSpec[];
}

const FAMILIES: FamilySpec[] = [
  {
    householdName: 'Carter Household',
    guardians: [
      { givenName: 'Michael', familyName: 'Carter', dateOfBirth: '1982-03-11' as DateOnly, gender: 'male', relation: 'parent', flags: { hasCustody: true, mayPickup: true, mayReceiveComms: true }, isPrimaryContact: true },
      { givenName: 'Sarah', familyName: 'Carter', dateOfBirth: '1984-07-22' as DateOnly, gender: 'female', relation: 'parent', flags: { hasCustody: true, mayPickup: true, mayReceiveComms: true }, isPrimaryContact: false },
    ],
    children: [{ givenName: 'Emily', familyName: 'Carter', dateOfBirth: '2014-08-01' as DateOnly, gender: 'female', gradeLevel: 'Grade 5' }],
  },
  {
    // Deliberate near-duplicate of Emily Carter above: same date of birth,
    // a near-identical (misspelled) given name, entered into a DIFFERENT
    // household - exactly the "someone re-typed this student" scenario
    // findPotentialDuplicates exists to catch.
    householdName: 'Carter-Whitfield Household',
    guardians: [
      { givenName: 'James', familyName: 'Whitfield', dateOfBirth: '1980-01-19' as DateOnly, gender: 'male', relation: 'guardian', flags: { hasCustody: true, mayPickup: true, mayReceiveComms: true }, isPrimaryContact: true },
    ],
    children: [{ givenName: 'Emilie', familyName: 'Carter', dateOfBirth: '2014-08-01' as DateOnly, gender: 'female', gradeLevel: 'Grade 5' }],
  },
  {
    householdName: 'Nguyen Household',
    guardians: [
      { givenName: 'Linh', familyName: 'Nguyen', dateOfBirth: '1979-05-02' as DateOnly, gender: 'female', relation: 'parent', flags: { hasCustody: true, mayPickup: true, mayReceiveComms: true }, isPrimaryContact: true },
      { givenName: 'Duc', familyName: 'Nguyen', dateOfBirth: '1978-12-15' as DateOnly, gender: 'male', relation: 'parent', flags: { hasCustody: true, mayPickup: true, mayReceiveComms: true }, isPrimaryContact: false },
    ],
    children: [
      { givenName: 'Anh', familyName: 'Nguyen', dateOfBirth: '2011-02-18' as DateOnly, gender: 'female', gradeLevel: 'Grade 8' },
      { givenName: 'Minh', familyName: 'Nguyen', dateOfBirth: '2016-09-09' as DateOnly, gender: 'male', gradeLevel: 'Grade 3' },
    ],
  },
  {
    householdName: 'Okafor Household',
    guardians: [
      { givenName: 'Chinwe', familyName: 'Okafor', dateOfBirth: '1983-10-05' as DateOnly, gender: 'female', relation: 'parent', flags: { hasCustody: true, mayPickup: true, mayReceiveComms: true }, isPrimaryContact: true },
    ],
    children: [{ givenName: 'Chidi', familyName: 'Okafor', dateOfBirth: '2013-04-27' as DateOnly, gender: 'male', gradeLevel: 'Grade 6' }],
  },
  {
    householdName: 'Alvarez Household',
    guardians: [
      { givenName: 'Rosa', familyName: 'Alvarez', dateOfBirth: '1981-06-30' as DateOnly, gender: 'female', relation: 'parent', flags: { hasCustody: true, mayPickup: true, mayReceiveComms: true }, isPrimaryContact: true },
      { givenName: 'Luis', familyName: 'Alvarez', dateOfBirth: '1980-02-14' as DateOnly, gender: 'male', relation: 'parent', flags: { hasCustody: false, mayPickup: true, mayReceiveComms: false }, isPrimaryContact: false },
    ],
    children: [
      { givenName: 'Sofia', familyName: 'Alvarez', dateOfBirth: '2017-11-03' as DateOnly, gender: 'female', gradeLevel: 'Kindergarten' },
      { givenName: 'Mateo', familyName: 'Alvarez', dateOfBirth: '2019-01-21' as DateOnly, gender: 'male', gradeLevel: 'Kindergarten' },
    ],
  },
  {
    householdName: 'Kowalski Household',
    guardians: [
      { givenName: 'Anna', familyName: 'Kowalski', dateOfBirth: '1977-08-19' as DateOnly, gender: 'female', relation: 'parent', flags: { hasCustody: true, mayPickup: true, mayReceiveComms: true }, isPrimaryContact: true },
    ],
    children: [{ givenName: 'Piotr', familyName: 'Kowalski', dateOfBirth: '2009-05-16' as DateOnly, gender: 'male', gradeLevel: 'Grade 10' }],
  },
  {
    householdName: 'Haddad Household',
    guardians: [
      { givenName: 'Yasmin', familyName: 'Haddad', dateOfBirth: '1985-09-27' as DateOnly, gender: 'female', relation: 'parent', flags: { hasCustody: true, mayPickup: true, mayReceiveComms: true }, isPrimaryContact: true },
      { givenName: 'Karim', familyName: 'Haddad', dateOfBirth: '1983-04-08' as DateOnly, gender: 'male', relation: 'parent', flags: { hasCustody: true, mayPickup: true, mayReceiveComms: true }, isPrimaryContact: false },
    ],
    children: [
      { givenName: 'Layla', familyName: 'Haddad', dateOfBirth: '2012-07-12' as DateOnly, gender: 'female', gradeLevel: 'Grade 7' },
      { givenName: 'Omar', familyName: 'Haddad', dateOfBirth: '2015-03-24' as DateOnly, gender: 'male', gradeLevel: 'Grade 4' },
    ],
  },
  {
    householdName: 'Larsson Household',
    guardians: [
      { givenName: 'Erik', familyName: 'Larsson', dateOfBirth: '1976-12-01' as DateOnly, gender: 'male', relation: 'parent', flags: { hasCustody: true, mayPickup: true, mayReceiveComms: true }, isPrimaryContact: true },
    ],
    children: [{ givenName: 'Elsa', familyName: 'Larsson', dateOfBirth: '2008-10-30' as DateOnly, gender: 'female', gradeLevel: 'Grade 11' }],
  },
  {
    householdName: 'Mensah Household',
    guardians: [
      { givenName: 'Ama', familyName: 'Mensah', dateOfBirth: '1980-03-03' as DateOnly, gender: 'female', relation: 'parent', flags: { hasCustody: true, mayPickup: true, mayReceiveComms: true }, isPrimaryContact: true },
      { givenName: 'Kwame', familyName: 'Mensah', dateOfBirth: '1979-07-17' as DateOnly, gender: 'male', relation: 'parent', flags: { hasCustody: true, mayPickup: true, mayReceiveComms: true }, isPrimaryContact: false },
    ],
    children: [{ givenName: 'Efua', familyName: 'Mensah', dateOfBirth: '2007-01-09' as DateOnly, gender: 'female', gradeLevel: 'Grade 12' }],
  },
  {
    householdName: 'Petrov Household',
    guardians: [
      { givenName: 'Elena', familyName: 'Petrov', dateOfBirth: '1986-11-11' as DateOnly, gender: 'female', relation: 'guardian', flags: { hasCustody: true, mayPickup: true, mayReceiveComms: true }, isPrimaryContact: true },
    ],
    children: [{ givenName: 'Ivan', familyName: 'Petrov', dateOfBirth: '2016-06-06' as DateOnly, gender: 'male', gradeLevel: 'Grade 3' }],
  },
  {
    householdName: 'Suzuki Household',
    guardians: [
      { givenName: 'Haruto', familyName: 'Suzuki', dateOfBirth: '1984-02-27' as DateOnly, gender: 'male', relation: 'parent', flags: { hasCustody: true, mayPickup: true, mayReceiveComms: true }, isPrimaryContact: true },
      { givenName: 'Yui', familyName: 'Suzuki', dateOfBirth: '1985-08-08' as DateOnly, gender: 'female', relation: 'parent', flags: { hasCustody: true, mayPickup: true, mayReceiveComms: true }, isPrimaryContact: false },
    ],
    children: [
      { givenName: 'Sora', familyName: 'Suzuki', dateOfBirth: '2010-12-19' as DateOnly, gender: 'female', gradeLevel: 'Grade 9' },
      { givenName: 'Ren', familyName: 'Suzuki', dateOfBirth: '2018-04-02' as DateOnly, gender: 'male', gradeLevel: 'Kindergarten' },
    ],
  },
  {
    householdName: 'Dubois Household',
    guardians: [
      { givenName: 'Claire', familyName: 'Dubois', dateOfBirth: '1982-05-05' as DateOnly, gender: 'female', relation: 'parent', flags: { hasCustody: true, mayPickup: true, mayReceiveComms: true }, isPrimaryContact: true },
    ],
    children: [{ givenName: 'Hugo', familyName: 'Dubois', dateOfBirth: '2013-09-23' as DateOnly, gender: 'male', gradeLevel: 'Grade 6' }],
  },
];

// Guardians who may pick up a child but are not that child's parent - an
// "authorized_pickup"/"emergency_contact" relationship on top of the
// household, exercising the flags in a genuinely different combination
// (no custody, comms optional).
interface EmergencyContactSpec extends PersonSpec {
  readonly forChild: { readonly givenName: string; readonly familyName: string; readonly dateOfBirth: DateOnly };
}

const EMERGENCY_CONTACTS: EmergencyContactSpec[] = [
  {
    givenName: 'Grandma',
    familyName: 'Carter',
    dateOfBirth: '1955-02-02' as DateOnly,
    gender: 'female',
    forChild: { givenName: 'Emily', familyName: 'Carter', dateOfBirth: '2014-08-01' as DateOnly },
  },
  {
    givenName: 'Tobias',
    familyName: 'Nguyen',
    dateOfBirth: '1975-03-03' as DateOnly,
    gender: 'male',
    forChild: { givenName: 'Anh', familyName: 'Nguyen', dateOfBirth: '2011-02-18' as DateOnly },
  },
];

const STAFF: Array<PersonSpec & { title: string }> = [
  { givenName: 'Daniel', familyName: 'Osei', dateOfBirth: '1979-11-02' as DateOnly, gender: 'male', title: 'Principal' },
  { givenName: 'Priya', familyName: 'Nandakumar', dateOfBirth: '1988-06-23' as DateOnly, gender: 'female', title: 'Teacher' },
  { givenName: 'Marco', familyName: 'Bianchi', dateOfBirth: '1975-01-30' as DateOnly, gender: 'male', title: 'Teacher' },
  { givenName: 'Grace', familyName: 'Whittaker', dateOfBirth: '1990-09-14' as DateOnly, gender: 'female', title: 'School Nurse' },
];

async function main(): Promise<void> {
  const tenantId = await findGreenwoodTenantId();
  const mainCampusId = await findCampusId(tenantId, 'main');
  const northCampusId = await findCampusId(tenantId, 'north');
  const adminUserId = await findAdminUserId();

  await ensureGradeLevelFieldDefinition(tenantId);

  // admin@greenwood.test's own linked person record (a staff member).
  const adminPersonId = await ensurePerson(tenantId, { givenName: 'Amina', familyName: 'Rahimi', dateOfBirth: '1985-04-12' as DateOnly, gender: 'female' });
  await ensureRole(tenantId, adminPersonId, 'staff', mainCampusId);
  await linkAdminMembership(tenantId, adminUserId, adminPersonId);

  for (const staff of STAFF) {
    const campusId = STAFF.indexOf(staff) % 2 === 0 ? mainCampusId : northCampusId;
    const personId = await ensurePerson(tenantId, staff);
    await ensureRole(tenantId, personId, 'staff', campusId);
  }

  let studentNumberCounter = 1;

  for (const family of FAMILIES) {
    const householdId = await ensureHousehold(tenantId, family.householdName);
    const campusId = FAMILIES.indexOf(family) % 2 === 0 ? mainCampusId : northCampusId;

    const guardianIds: PersonId[] = [];
    for (const guardian of family.guardians) {
      const personId = await ensurePerson(tenantId, guardian);
      await ensureRole(tenantId, personId, 'guardian', null);
      await ensureHouseholdMember(tenantId, householdId, personId, guardian.isPrimaryContact);
      await ensureContactPoint(tenantId, personId, 'email', seedEmailAddress(personId, guardian.givenName, guardian.familyName), true);
      await ensureContactPoint(tenantId, personId, 'phone', seedPhoneNumber(personId), true);
      guardianIds.push(personId);
    }

    for (const child of family.children) {
      const childId = await ensurePerson(tenantId, child);
      await ensureRole(tenantId, childId, 'student', campusId);
      await ensureHouseholdMember(tenantId, householdId, childId, false);
      await ensureContactPoint(tenantId, childId, 'email', seedEmailAddress(childId, child.givenName, child.familyName), true);

      const studentNumber = `GW-2026-${String(studentNumberCounter).padStart(4, '0')}`;
      studentNumberCounter += 1;
      await ensureIdentifier(tenantId, childId, 'student_number', studentNumber);

      for (let i = 0; i < family.guardians.length; i += 1) {
        const guardian = family.guardians[i]!;
        const guardianId = guardianIds[i]!;
        await ensureRelationship(tenantId, guardianId, childId, guardian.relation, guardian.flags);
      }
    }
  }

  for (const contact of EMERGENCY_CONTACTS) {
    const contactId = await ensurePerson(tenantId, contact);
    const child = await findPersonByNameAndDob(tenantId, contact.forChild.givenName, contact.forChild.familyName, contact.forChild.dateOfBirth);
    if (!child) {
      throw new Error(`Emergency contact "${contact.givenName} ${contact.familyName}" references an unseeded child.`);
    }
    await ensureRelationship(tenantId, contactId, child.id, 'emergency_contact', { hasCustody: false, mayPickup: true, mayReceiveComms: false });
  }

  // A couple of illustrative alerts, so the medical/safeguarding permission
  // split (@sms/access's people.student:read_medical/read_safeguarding) has
  // real data to demonstrate against.
  const emily = await findPersonByNameAndDob(tenantId, 'Emily', 'Carter', '2014-08-01' as DateOnly);
  if (emily) {
    await ensureAlert(tenantId, emily.id, 'medical', 'warning', 'Severe peanut allergy - EpiPen kept in the school office.');
  }
  const layla = await findPersonByNameAndDob(tenantId, 'Layla', 'Haddad', '2012-07-12' as DateOnly);
  if (layla) {
    await ensureAlert(tenantId, layla.id, 'safeguarding', 'critical', 'Custody dispute in progress - see office file before releasing to any pickup not on the approved list.');
  }

  console.log('seed complete');
}

main()
  .catch((error: unknown) => {
    console.error('seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSqlClients();
  });
