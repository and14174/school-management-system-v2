import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { subject } from '@casl/ability';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NotFoundError,
  err,
  formatDateOnly,
  newId,
  ok,
  todayDateOnly,
  type CampusId,
  type DateOnly,
  type PersonId,
  type Result,
  type TenantId,
  type UserId,
} from '@sms/kernel';
import { closeSqlClients, createSqlClient, runWithContext, type Sql } from '@sms/db';
import { getAuth, resetAuthSingleton, type IdentityContract } from '@sms/identity';
import { AbilityCache } from './application/ability-cache.js';
import { AbilityService } from './application/ability.service.js';
import { AccessService } from './application/access.service.js';
import type { DependantScopeResolver } from './application/dependant-scope-resolver.js';
import { ImpersonationService } from './application/impersonation.service.js';
import { RoleService } from './application/role.service.js';
import { maskFields } from './api/field-masking.interceptor.js';
import { PERMISSION_CATALOGUE } from './domain/permissions.js';
import { getAccessDb } from './infrastructure/db.js';
import { permissionTable } from './infrastructure/schema.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

function shiftDateOnly(date: DateOnly, days: number): DateOnly {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(year, month - 1, day);
  shifted.setDate(shifted.getDate() + days);
  return formatDateOnly(shifted);
}

/**
 * Applies the real `audit` + `tenancy` + `identity` migrations (read, never
 * edited - see the module report's constraints) and this module's own
 * `0400` migration to a throwaway container, then proves - through the real
 * `AbilityService`/`RoleService`/`ImpersonationService`/`AccessService`, not
 * reimplementations of them - the properties this module exists for:
 *
 *   1. A tenant-scoped grant allows; no grant denies.
 *   2. A campus-scoped grant allows only the assigned campus.
 *   3. A section-scoped grant grants nothing today (unresolvable scope fails closed).
 *   4. An expired/future-dated role_assignment grants nothing.
 *   5. Field masking hides medical fields from a role without read_medical, shows them to one with it.
 *   6. Impersonation writes an access.impersonation row; audit rows attribute the change to the real actor.
 *   7. RLS isolates roles and assignments across tenants.
 *
 * Plus: the DB permission catalogue matches the code catalogue, and the
 * permission-matrix contract method used by GET /access/roles/:id/permissions.
 */
describe('access (real Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: Sql;

  const abilityCache = new AbilityCache();
  const abilityService = new AbilityService(abilityCache);
  const roleService = new RoleService(abilityService);

  // A minimal stand-in for IdentityContract, implementing only what
  // ImpersonationService actually calls (getUser). @sms/access can only
  // reach @sms/identity's PUBLIC contract type/entrypoint - not its
  // internal IdentityService/MembershipService classes (module-boundary
  // ESLint rule) - so this is the same shape apps/api gets from Nest DI,
  // hand-built against the real identity.user table instead of through Nest.
  let identityStub: IdentityContract;
  let impersonationService: ImpersonationService;
  let accessService: AccessService;

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
    // identity.spec.ts/tenancy.spec.ts for why. Numeric prefixes make
    // lexical order the real apply order (see migrate.ts).
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
    await applyMigrations(join(__dirname, '..', '..', 'identity', 'migrations'));
    await applyMigrations(join(__dirname, '..', 'migrations'));

    const appUrl = new URL(ownerUrl);
    appUrl.username = 'sms_app';
    appUrl.password = 'dev';

    process.env.DATABASE_URL = appUrl.toString();
    process.env.DATABASE_MIGRATION_URL = ownerUrl;
    process.env.AUTH_SECRET = 'test-only-32-byte-minimum-secret-value-not-for-prod';
    process.env.APP_URL = 'http://localhost:3000';
    process.env.API_URL = 'http://localhost:3333';
    resetAuthSingleton();

    identityStub = {
      async getSession() {
        throw new Error('not implemented in test stub');
      },
      async listMemberships() {
        throw new Error('not implemented in test stub');
      },
      async setActiveTenant() {
        throw new Error('not implemented in test stub');
      },
      async createUserWithMembership() {
        throw new Error('not implemented in test stub');
      },
      async getUser(id) {
        const rows = await ownerSql`select id, email, name, email_verified, two_factor_enabled, created_at, updated_at from identity.user where id = ${id}`;
        const row = rows[0] as
          | {
              id: string;
              email: string;
              name: string;
              email_verified: boolean;
              two_factor_enabled: boolean;
              created_at: Date;
              updated_at: Date;
            }
          | undefined;
        if (!row) {
          return err(new NotFoundError(`User ${id} not found.`));
        }
        return ok({
          id: row.id as UserId,
          email: row.email,
          name: row.name,
          emailVerified: row.email_verified,
          twoFactorEnabled: row.two_factor_enabled,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
      },
    };
    impersonationService = new ImpersonationService(identityStub);
    accessService = new AccessService(abilityService, roleService, impersonationService);

    await seedPermissionCatalogue();
  }, 180_000);

  afterAll(async () => {
    await closeSqlClients();
    await ownerSql?.end({ timeout: 1 });
    await container?.stop();
  });

  async function seedPermissionCatalogue(): Promise<void> {
    for (const definition of PERMISSION_CATALOGUE) {
      await getAccessDb()
        .insert(permissionTable)
        .values({ id: newId(), key: definition.key, resource: definition.resource, action: definition.action, description: definition.description })
        .onConflictDoNothing();
    }
  }

  async function createTenant(slug: string, name: string): Promise<TenantId> {
    const rows = await ownerSql`insert into tenancy.tenant (slug, name) values (${slug}, ${name}) returning id`;
    return (rows[0] as { id: string }).id as TenantId;
  }

  async function createCampus(tenantId: TenantId, code: string, name: string): Promise<CampusId> {
    const rows = await ownerSql`
      insert into tenancy.campus (tenant_id, code, name) values (${tenantId}, ${code}, ${name}) returning id
    `;
    return (rows[0] as { id: string }).id as CampusId;
  }

  async function signUpUser(email: string): Promise<UserId> {
    const result = await getAuth().api.signUpEmail({
      body: { name: email, email, password: 'correct-horse-battery-staple' },
    });
    return result.user.id as UserId;
  }

  async function findPermissionId(key: string): Promise<string> {
    const rows = await getAccessDb().select().from(permissionTable).where(eq(permissionTable.key, key)).limit(1);
    const row = rows[0];
    if (!row) {
      throw new Error(`Permission "${key}" not seeded.`);
    }
    return row.id;
  }

  /** Creates a role granting exactly one permission at one scope, and returns its id. */
  async function createRoleWithGrant(
    tenantId: TenantId,
    roleKey: string,
    permissionKey: string,
    scope: 'own' | 'section' | 'dependants' | 'grade_level' | 'campus' | 'tenant',
  ): Promise<string> {
    const created = await roleService.createRole({ tenantId, key: roleKey, name: roleKey });
    if (!created.ok) {
      throw created.error;
    }
    const permissionId = await findPermissionId(permissionKey);
    const granted = await roleService.grantPermission({ tenantId, roleId: created.value.id, permissionId, scope });
    if (!granted.ok) {
      throw granted.error;
    }
    return created.value.id;
  }

  /**
   * Links `userId` to `personId` via `identity.membership` - what `own`'s
   * `resolvePersonId` and `dependants`' real (`apps/api`) resolver both key
   * off. `person_id` carries no FK yet (see the `0301` migration header: M2's
   * `people` module adds it), so any UUID is accepted without a real
   * `people.person` row existing - this package's tests never load
   * `@sms/people`'s migrations, same reasoning `academic.spec.ts`'s own
   * `createMembership` documents for `SECTION_SCOPE_RESOLVER`.
   */
  async function createMembership(tenantId: TenantId, userId: UserId, personId: string): Promise<void> {
    await ownerSql`
      insert into identity.membership (tenant_id, user_id, person_id, status)
      values (${tenantId}, ${userId}, ${personId}, 'active')
    `;
  }

  /**
   * Mimics the ambient `TenantContext` `apps/api`'s `TenantContextInterceptor`
   * builds for a real request.
   *
   * `actorUserId` is the REAL signed-in human and defaults to `userId`;
   * `audit.record_history()` stamps `changed_by_user_id` from it. Tests
   * override `userId` alone to simulate impersonation - acting AS someone
   * while the actor stays whoever actually signed in - which is exactly the
   * property the attribution test asserts.
   */
  async function runAs<T>(
    tenantId: TenantId,
    userId: UserId,
    fn: () => Promise<T>,
    extra?: { campusId?: CampusId; actorUserId?: UserId },
  ): Promise<T> {
    return runWithContext(
      {
        tenantId,
        userId,
        roles: [],
        requestId: newId(),
        campusId: extra?.campusId,
        actorUserId: extra?.actorUserId ?? userId,
      },
      fn,
    );
  }

  it('the DB permission catalogue matches the code catalogue (src/domain/permissions.ts)', async () => {
    const dbRows = await getAccessDb().select().from(permissionTable);
    const dbKeys = dbRows.map((row) => row.key).sort();
    const codeKeys = PERMISSION_CATALOGUE.map((permission) => permission.key).sort();
    expect(dbKeys).toEqual(codeKeys);

    for (const definition of PERMISSION_CATALOGUE) {
      const row = dbRows.find((candidate) => candidate.key === definition.key);
      expect(row?.resource).toBe(definition.resource);
      expect(row?.action).toBe(definition.action);
      expect(row?.description).toBe(definition.description);
    }
  });

  it('a tenant-scoped grant allows; no grant denies', async () => {
    const tenantId = await createTenant('tenant-scope-allow', 'Tenant Scope Allow');
    const roleId = await createRoleWithGrant(tenantId, 'tenant_reader', 'people.student:read', 'tenant');

    const grantedUser = await signUpUser(`granted-${newId()}@example.com`);
    const assigned = await roleService.assignRole(tenantId, { roleId, userId: grantedUser });
    expect(assigned.ok).toBe(true);

    const grantedAbility = await abilityService.compileAbility(grantedUser, tenantId);
    expect(grantedAbility.can('read', 'people.student')).toBe(true);

    const ungrantedUser = await signUpUser(`ungranted-${newId()}@example.com`);
    const ungrantedAbility = await abilityService.compileAbility(ungrantedUser, tenantId);
    expect(ungrantedAbility.can('read', 'people.student')).toBe(false);
  });

  it('a campus-scoped grant allows only the assigned campus', async () => {
    const tenantId = await createTenant('tenant-scope-campus', 'Tenant Scope Campus');
    const campusA = await createCampus(tenantId, 'campus-a', 'Campus A');
    const campusB = await createCampus(tenantId, 'campus-b', 'Campus B');
    const roleId = await createRoleWithGrant(tenantId, 'campus_reader', 'people.student:read', 'campus');

    const userId = await signUpUser(`campus-scoped-${newId()}@example.com`);
    const assigned = await roleService.assignRole(tenantId, { roleId, userId, campusId: campusA });
    expect(assigned.ok).toBe(true);

    const ability = await abilityService.compileAbility(userId, tenantId);
    expect(ability.can('read', subject('people.student', { campusId: campusA }))).toBe(true);
    expect(ability.can('read', subject('people.student', { campusId: campusB }))).toBe(false);
  });

  it('a section-scoped grant grants nothing today (unresolvable scope fails closed)', async () => {
    const tenantId = await createTenant('tenant-scope-section', 'Tenant Scope Section');
    const roleId = await createRoleWithGrant(tenantId, 'section_reader', 'people.student:read', 'section');

    const userId = await signUpUser(`section-scoped-${newId()}@example.com`);
    const assigned = await roleService.assignRole(tenantId, { roleId, userId });
    expect(assigned.ok).toBe(true);

    const ability = await abilityService.compileAbility(userId, tenantId);
    // Even a bare type-level check (no instance, no conditions to satisfy)
    // is false - proving no rule was emitted at all, not merely a
    // condition that happens not to match.
    expect(ability.can('read', 'people.student')).toBe(false);
    expect(ability.rules.length).toBe(0);
  });

  it('a grade_level-scoped grant grants nothing today either', async () => {
    const tenantId = await createTenant('tenant-scope-grade-level', 'Tenant Scope Grade Level');
    const roleId = await createRoleWithGrant(tenantId, 'grade_level_reader', 'people.student:read', 'grade_level');
    const userId = await signUpUser(`grade-level-scoped-${newId()}@example.com`);
    await roleService.assignRole(tenantId, { roleId, userId });

    const ability = await abilityService.compileAbility(userId, tenantId);
    expect(ability.can('read', 'people.student')).toBe(false);
  });

  it("an own-scoped grant allows only the caller's own linked person (unchanged by the new dependants scope)", async () => {
    const tenantId = await createTenant('tenant-scope-own', 'Tenant Scope Own');
    const roleId = await createRoleWithGrant(tenantId, 'own_reader', 'people.student:read', 'own');

    const userId = await signUpUser(`own-scoped-${newId()}@example.com`);
    const ownPersonId = newId();
    await createMembership(tenantId, userId, ownPersonId);
    const assigned = await roleService.assignRole(tenantId, { roleId, userId });
    expect(assigned.ok).toBe(true);

    // compileAbility's 'own' rule conditions on the SUBJECT's userId field
    // (see buildAbility's 'own' case) - unchanged by this task, which only
    // adds a NEW 'dependants' case (conditioned on personId, since a
    // guardian's grant has no userId of the child's to match against).
    const ability = await abilityService.compileAbility(userId, tenantId);
    expect(ability.can('read', subject('people.student', { userId }))).toBe(true);
    expect(ability.can('read', subject('people.student', { userId: await signUpUser(`other-${newId()}@example.com`) }))).toBe(false);

    // The data-filtering counterpart (what every controller in this codebase
    // actually enforces 'own' with) still resolves the caller's OWN linked
    // person id via identity.membership, exactly as before.
    const constraints = await abilityService.resolveScopeConstraints(userId, tenantId);
    expect(constraints['people.student:read']).toEqual({ kind: 'own', personId: ownPersonId });
  });

  describe('the dependants scope (a guardian reading their own children)', () => {
    /** A stub DEPENDANT_SCOPE_RESOLVER - the real one (identity.membership -> people.relationship) lives in apps/api and is exercised live, not here (this package cannot load @sms/people's migrations - see docs/decisions.md's module-boundary rules). This proves AbilityService's OWN handling of the scope: precedence, fail-closed-on-empty, and the resolved constraint/ability shape - exactly what compileAbility/resolveScopeConstraints own regardless of which resolver is wired up. */
    function stubResolver(byUser: ReadonlyMap<UserId, readonly PersonId[]>): DependantScopeResolver {
      return {
        async resolveDependantPersonIds(userId) {
          return [...(byUser.get(userId) ?? [])];
        },
      };
    }

    it("a dependants-scoped grant resolves to the guardian's own children only - denies a non-child", async () => {
      const tenantId = await createTenant('tenant-scope-dependants', 'Tenant Scope Dependants');
      const roleId = await createRoleWithGrant(tenantId, 'dependants_reader', 'people.student:read', 'dependants');

      const guardianUser = await signUpUser(`guardian-${newId()}@example.com`);
      const assigned = await roleService.assignRole(tenantId, { roleId, userId: guardianUser });
      expect(assigned.ok).toBe(true);

      const childId = newId() as PersonId;
      const notMyChildId = newId() as PersonId;
      const scopedAbility = new AbilityService(new AbilityCache(), undefined, stubResolver(new Map([[guardianUser, [childId]]])));

      const ability = await scopedAbility.compileAbility(guardianUser, tenantId);
      expect(ability.can('read', subject('people.student', { personId: childId }))).toBe(true);
      // A guardian holding this grant must NOT reach a student who is not
      // their own child - the whole point of 'dependants' over widening to
      // 'campus'/'tenant'.
      expect(ability.can('read', subject('people.student', { personId: notMyChildId }))).toBe(false);

      const constraints = await scopedAbility.resolveScopeConstraints(guardianUser, tenantId);
      expect(constraints['people.student:read']).toEqual({ kind: 'dependants', personIds: [childId] });
    });

    it('a user with no dependants resolves to { kind: "none" } and is denied - fail closed, never widened to "everything"', async () => {
      const tenantId = await createTenant('tenant-scope-dependants-empty', 'Tenant Scope Dependants Empty');
      const roleId = await createRoleWithGrant(tenantId, 'dependants_reader_empty', 'people.student:read', 'dependants');

      const noKidsUser = await signUpUser(`no-dependants-${newId()}@example.com`);
      await roleService.assignRole(tenantId, { roleId, userId: noKidsUser });

      const emptyResolverAbility = new AbilityService(new AbilityCache(), undefined, stubResolver(new Map()));

      const ability = await emptyResolverAbility.compileAbility(noKidsUser, tenantId);
      // Same proof shape as the section/grade_level fail-closed tests above:
      // no rule at all, not a condition that happens not to match.
      expect(ability.can('read', 'people.student')).toBe(false);
      expect(ability.rules.length).toBe(0);

      const constraints = await emptyResolverAbility.resolveScopeConstraints(noKidsUser, tenantId);
      expect(constraints['people.student:read']).toEqual({ kind: 'none' });

      // The same holds true for the DEFAULT resolver (nothing wired up at
      // all, e.g. a test - or a real deployment - that never registers
      // DEPENDANT_SCOPE_RESOLVER) - the safe default this port ships with.
      const defaultResolverAbility = new AbilityService(new AbilityCache());
      const defaultAbility = await defaultResolverAbility.compileAbility(noKidsUser, tenantId);
      expect(defaultAbility.can('read', 'people.student')).toBe(false);
      expect(defaultAbility.rules.length).toBe(0);
    });

    it('precedence: tenant > campus > section > dependants > own - a user holding both an own-scoped and a dependants-scoped grant (via two roles) for the same key resolves dependants', async () => {
      // A single role cannot hold two scopes for the same permission (access.
      // role_permission is unique on (role_id, permission_id) - grantPermission
      // upserts, it does not add a second row - see role.service.ts). The
      // realistic way a caller ends up with BOTH scopes for the same key is
      // two roles, same as the seeded Parent/Guardian ('dependants') and
      // Student ('own') roles would if ever assigned to the same user - which
      // the seed comment notes never happens today, but the ordering must
      // still be correct if it ever did.
      const tenantId = await createTenant('tenant-scope-precedence', 'Tenant Scope Precedence');
      const ownRoleId = await createRoleWithGrant(tenantId, 'own_half', 'people.student:read', 'own');
      const dependantsRoleId = await createRoleWithGrant(tenantId, 'dependants_half', 'people.student:read', 'dependants');

      const userId = await signUpUser(`both-scopes-${newId()}@example.com`);
      const ownPersonId = newId();
      await createMembership(tenantId, userId, ownPersonId);
      await roleService.assignRole(tenantId, { roleId: ownRoleId, userId });
      await roleService.assignRole(tenantId, { roleId: dependantsRoleId, userId });

      const childId = newId() as PersonId;
      const scopedAbility = new AbilityService(new AbilityCache(), undefined, stubResolver(new Map([[userId, [childId]]])));

      const constraints = await scopedAbility.resolveScopeConstraints(userId, tenantId);
      // 'dependants' wins over 'own' for the same key, per the precedence
      // documented in resolveScopeConstraints - own's personId (a real,
      // resolvable value here) is discarded in favour of it.
      expect(constraints['people.student:read']).toEqual({ kind: 'dependants', personIds: [childId] });
    });
  });

  it('an expired role_assignment grants nothing; a future-dated one likewise', async () => {
    const tenantId = await createTenant('tenant-effective-dating', 'Tenant Effective Dating');
    const roleId = await createRoleWithGrant(tenantId, 'tenant_reader_dated', 'people.student:read', 'tenant');
    const today = todayDateOnly();

    const expiredUser = await signUpUser(`expired-${newId()}@example.com`);
    const expiredAssignment = await roleService.assignRole(tenantId, {
      roleId,
      userId: expiredUser,
      validFrom: shiftDateOnly(today, -30),
      validTo: shiftDateOnly(today, -1),
    });
    expect(expiredAssignment.ok).toBe(true);
    const expiredAbility = await abilityService.compileAbility(expiredUser, tenantId);
    expect(expiredAbility.can('read', 'people.student')).toBe(false);

    const futureUser = await signUpUser(`future-${newId()}@example.com`);
    const futureAssignment = await roleService.assignRole(tenantId, {
      roleId,
      userId: futureUser,
      validFrom: shiftDateOnly(today, 1),
    });
    expect(futureAssignment.ok).toBe(true);
    const futureAbility = await abilityService.compileAbility(futureUser, tenantId);
    expect(futureAbility.can('read', 'people.student')).toBe(false);

    // Sanity check: the SAME assignment resolves as granted "as of" a date
    // inside its own window, proving the denial above is about dates, not a
    // broken assignment.
    const futureAbilityLater = await abilityService.compileAbility(futureUser, tenantId, shiftDateOnly(today, 2));
    expect(futureAbilityLater.can('read', 'people.student')).toBe(true);
  });

  it('revoking a role assignment removes access from the day after the revocation date (validTo is inclusive, matching @sms/kernel\'s Interval)', async () => {
    const tenantId = await createTenant('tenant-revoke', 'Tenant Revoke');
    const roleId = await createRoleWithGrant(tenantId, 'revoke_target', 'people.student:read', 'tenant');
    const userId = await signUpUser(`revoke-${newId()}@example.com`);
    await roleService.assignRole(tenantId, { roleId, userId });

    expect((await abilityService.compileAbility(userId, tenantId)).can('read', 'people.student')).toBe(true);

    const today = todayDateOnly();
    const revoked = await roleService.revokeRole(tenantId, { roleId, userId, asOf: today });
    expect(revoked.ok).toBe(true);

    // asOf: today is still within the (inclusive) validTo, so access holds
    // through the revocation date itself...
    expect((await abilityService.compileAbility(userId, tenantId, today)).can('read', 'people.student')).toBe(true);
    // ...and is gone from the next day on. compileAbility's own default
    // asOf (today) is cache-invalidated by revokeRole, so this also proves
    // invalidateAbility actually ran, not just that a fresh query would
    // have found it anyway.
    expect((await abilityService.compileAbility(userId, tenantId, shiftDateOnly(today, 1))).can('read', 'people.student')).toBe(
      false,
    );
  });

  it('rejects an overlapping assignment of the same role to the same user', async () => {
    const tenantId = await createTenant('tenant-overlap', 'Tenant Overlap');
    const roleId = await createRoleWithGrant(tenantId, 'overlap_target', 'people.student:read', 'tenant');
    const userId = await signUpUser(`overlap-${newId()}@example.com`);

    const first = await roleService.assignRole(tenantId, { roleId, userId });
    expect(first.ok).toBe(true);

    const second = await roleService.assignRole(tenantId, { roleId, userId });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('CONFLICT');
    }
  });

  it('field masking: a role without read_medical cannot see medical fields; the Nurse-like role can', async () => {
    const tenantId = await createTenant('tenant-field-masking', 'Tenant Field Masking');
    const readerRoleId = await createRoleWithGrant(tenantId, 'reader_no_medical', 'people.student:read', 'tenant');

    const nurseCreated = await roleService.createRole({ tenantId, key: 'nurse_like', name: 'Nurse-like' });
    if (!nurseCreated.ok) throw nurseCreated.error;
    const readPermissionId = await findPermissionId('people.student:read');
    const medicalPermissionId = await findPermissionId('people.student:read_medical');
    await roleService.grantPermission({ tenantId, roleId: nurseCreated.value.id, permissionId: readPermissionId, scope: 'tenant' });
    await roleService.grantPermission({ tenantId, roleId: nurseCreated.value.id, permissionId: medicalPermissionId, scope: 'tenant' });

    const readerUser = await signUpUser(`reader-${newId()}@example.com`);
    await roleService.assignRole(tenantId, { roleId: readerRoleId, userId: readerUser });
    const nurseUser = await signUpUser(`nurse-${newId()}@example.com`);
    await roleService.assignRole(tenantId, { roleId: nurseCreated.value.id, userId: nurseUser });

    // 'people.person'/'hasMedicalAlerts': the real field-registry entry
    // @sms/people's PeopleController's GET /people/:id carries (replacing
    // the placeholder 'people.student'/'medicalNotes' entry that used to
    // stand in for it ahead of that module existing - see field-registry.ts's
    // own comment). The *permission* required (people.student:read_medical)
    // is unchanged; only the resource/field name moved to match the real
    // schema.
    const record = { id: 's1', name: 'Jamie Rivera', hasMedicalAlerts: true };

    const readerAbility = await abilityService.compileAbility(readerUser, tenantId);
    const maskedForReader = maskFields(record, 'people.person', readerAbility);
    expect(maskedForReader).not.toHaveProperty('hasMedicalAlerts');
    expect(maskedForReader.name).toBe('Jamie Rivera');

    const nurseAbility = await abilityService.compileAbility(nurseUser, tenantId);
    const maskedForNurse = maskFields(record, 'people.person', nurseAbility);
    expect(maskedForNurse).toHaveProperty('hasMedicalAlerts', true);
  });

  it('impersonation writes an access.impersonation row, and audit rows attribute writes made while impersonating to the real actor', async () => {
    const tenantId = await createTenant('tenant-impersonation', 'Tenant Impersonation');
    const actorUserId = await signUpUser(`actor-${newId()}@example.com`);
    const targetUserId = await signUpUser(`target-${newId()}@example.com`);

    const started = await runAs(tenantId, actorUserId, () =>
      accessService.startImpersonation({ targetUserId, reason: 'Investigating a support ticket' }),
    );
    expect(started.ok).toBe(true);
    if (!started.ok) throw started.error;
    expect(started.value.actorUserId).toBe(actorUserId);
    expect(started.value.targetUserId).toBe(targetUserId);
    expect(started.value.reason).toBe('Investigating a support ticket');
    expect(started.value.endedAt).toBeNull();

    // The row is really there, independent of the service's own read path.
    const impersonationRows = await ownerSql`
      select actor_user_id, target_user_id, reason, ended_at from access.impersonation where id = ${started.value.id}
    `;
    expect(impersonationRows.length).toBe(1);
    expect((impersonationRows[0] as { actor_user_id: string }).actor_user_id).toBe(actorUserId);

    const activeImpersonation = await accessService.getActiveImpersonation(actorUserId, tenantId);
    expect(activeImpersonation?.id).toBe(started.value.id);

    // The audit row for the INSERT into access.impersonation is attributed to
    // the actor - runAs sets actorUserId, exactly as apps/api's
    // TenantContextInterceptor does for every request.
    const impersonationAuditRows = await ownerSql`
      select changed_by_user_id from audit.record_history
      where table_schema = 'access' and table_name = 'impersonation' and record_id = ${started.value.id}
        and operation = 'insert'
    `;
    expect(impersonationAuditRows.length).toBe(1);
    expect((impersonationAuditRows[0] as { changed_by_user_id: string }).changed_by_user_id).toBe(actorUserId);

    // Now simulate a SEPARATE write made "as" the target while impersonating
    // - exactly the ambient context apps/api's TenantContextInterceptor
    // builds once an active impersonation is found: userId is the EFFECTIVE
    // (target) identity, actorUserId stays the REAL actor. The resulting audit
    // row must still say the actor did it, not the target - this is the
    // "chain" the brief asks for: impersonated writes are attributable to
    // the real actor, not just the target.
    const roleId = await createRoleWithGrant(tenantId, 'impersonation_write_target', 'people.student:read', 'tenant');
    const someOtherUser = await signUpUser(`other-${newId()}@example.com`);

    const assignedWhileImpersonating = await runWithContext(
      { tenantId, userId: targetUserId, actorUserId, roles: [], requestId: newId() },
      () => roleService.assignRole(tenantId, { roleId, userId: someOtherUser }),
    );
    expect(assignedWhileImpersonating.ok).toBe(true);
    if (!assignedWhileImpersonating.ok) throw assignedWhileImpersonating.error;

    const assignmentAuditRows = await ownerSql`
      select changed_by_user_id from audit.record_history
      where table_schema = 'access' and table_name = 'role_assignment' and record_id = ${assignedWhileImpersonating.value.id}
        and operation = 'insert'
    `;
    expect(assignmentAuditRows.length).toBe(1);
    expect((assignmentAuditRows[0] as { changed_by_user_id: string }).changed_by_user_id).toBe(actorUserId);
    expect((assignmentAuditRows[0] as { changed_by_user_id: string }).changed_by_user_id).not.toBe(targetUserId);

    const ended = await runAs(tenantId, actorUserId, () => accessService.endImpersonation());
    expect(ended.ok).toBe(true);
    const activeAfterEnd = await accessService.getActiveImpersonation(actorUserId, tenantId);
    expect(activeAfterEnd).toBeNull();
  });

  it('rejects starting a second impersonation session while one is already active', async () => {
    const tenantId = await createTenant('tenant-impersonation-overlap', 'Tenant Impersonation Overlap');
    const actorUserId = await signUpUser(`actor2-${newId()}@example.com`);
    const targetA = await signUpUser(`targetA-${newId()}@example.com`);
    const targetB = await signUpUser(`targetB-${newId()}@example.com`);

    const first = await runAs(tenantId, actorUserId, () => accessService.startImpersonation({ targetUserId: targetA, reason: 'r1' }));
    expect(first.ok).toBe(true);

    const second = await runAs(tenantId, actorUserId, () => accessService.startImpersonation({ targetUserId: targetB, reason: 'r2' }));
    expect(second.ok).toBe(false);
  });

  it('RLS isolates roles and role assignments across tenants', async () => {
    const tenantX = await createTenant('tenant-rls-x', 'Tenant RLS X');
    const tenantY = await createTenant('tenant-rls-y', 'Tenant RLS Y');
    await createRoleWithGrant(tenantX, 'x_only_role', 'people.student:read', 'tenant');

    const rolesInY = await roleService.listRoles(tenantY);
    expect(rolesInY.find((role) => role.key === 'x_only_role')).toBeUndefined();

    const rolesInX = await roleService.listRoles(tenantX);
    expect(rolesInX.find((role) => role.key === 'x_only_role')).toBeDefined();

    // Directly against the table too, not just through the service, to rule
    // out an application-level filter doing the work RLS is supposed to.
    const appSqlNoContext = createSqlClient(process.env.DATABASE_URL!);
    try {
      const rows = await appSqlNoContext`select id from access.role where tenant_id = ${tenantX}`;
      expect(rows.length).toBe(0); // no app.tenant_id GUC set -> zero rows, never "every tenant"
    } finally {
      await appSqlNoContext.end({ timeout: 1 });
    }
  });

  it('GET /access/roles/:id/permissions-backing method returns the full catalogue with null scope for ungranted permissions, and 404s for a role in another tenant', async () => {
    const tenantId = await createTenant('tenant-permission-matrix', 'Tenant Permission Matrix');
    const otherTenantId = await createTenant('tenant-permission-matrix-other', 'Tenant Permission Matrix Other');
    const roleId = await createRoleWithGrant(tenantId, 'matrix_role', 'people.student:read_medical', 'campus');

    const matrix = await roleService.listPermissionMatrix(tenantId, roleId);
    expect(matrix.ok).toBe(true);
    if (!matrix.ok) throw matrix.error;

    expect(matrix.value.length).toBe(PERMISSION_CATALOGUE.length);
    const grantedEntry = matrix.value.find((entry) => entry.key === 'people.student:read_medical');
    expect(grantedEntry?.scope).toBe('campus');
    const ungrantedEntry = matrix.value.find((entry) => entry.key === 'billing.invoice:write');
    expect(ungrantedEntry?.scope).toBeNull();

    const crossTenant: Result<unknown, NotFoundError> = await roleService.listPermissionMatrix(otherTenantId, roleId);
    expect(crossTenant.ok).toBe(false);
    if (!crossTenant.ok) {
      expect(crossTenant.error.code).toBe('NOT_FOUND');
    }
  });
});
