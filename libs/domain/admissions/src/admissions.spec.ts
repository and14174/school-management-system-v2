import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Test, type TestingModule } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type AcademicYearId, type CampusId, type DateOnly, type TenantId, type UserId } from '@sms/kernel';
import { closeSqlClients, createSqlClient, runWithContext, type Sql } from '@sms/db';
import { ACCESS_CONTRACT, PERMISSION_CATALOGUE, type AccessContract } from '@sms/access';
import { AdmissionsModule } from './api/admissions.module.js';
import { ApplicationRecordService } from './application/application-record.service.js';
import { DecisionService } from './application/decision.service.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

/**
 * Applies the real `audit` + `tenancy` + `identity` + `access` + `people` +
 * `academic` + `enrollment` + `outbox` migrations (read, never edited - see
 * the module report's constraints) and this module's own `1500` migration to
 * a throwaway container, then proves - through the real application services,
 * not reimplementations of them - the properties this module exists for. See
 * the module brief's VERIFICATION section for the exact list; each `it`
 * block below is numbered to match.
 */
describe('admissions (real Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: Sql;
  let moduleRef: TestingModule;
  let access: AccessContract;
  let records: ApplicationRecordService;
  let decisions: DecisionService;

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
    // decisions.md's "Test specs must read their module's migrations folder,
    // not name files" for why. Numeric prefixes make lexical order the real
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
    await applyMigrations(join(__dirname, '..', '..', '..', 'platform', 'access', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', '..', 'platform', 'custom-fields', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', '..', 'domain', 'people', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', '..', 'domain', 'academic', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', '..', 'domain', 'enrollment', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', '..', 'platform', 'outbox', 'migrations'));
    await applyMigrations(join(__dirname, '..', 'migrations'));

    const appUrl = new URL(ownerUrl);
    appUrl.username = 'sms_app';
    appUrl.password = 'dev';

    process.env.DATABASE_URL = appUrl.toString();
    process.env.DATABASE_MIGRATION_URL = ownerUrl;

    // AdmissionsModule imports AccessModule/OutboxModule/PeopleModule/
    // EnrollmentModule itself, so importing just it here pulls in every real
    // implementation `DecisionService.ensureConverted` needs - same
    // full-cross-module-wiring precedent as `@sms/attendance`'s own spec.
    moduleRef = await Test.createTestingModule({ imports: [AdmissionsModule] }).compile();
    access = moduleRef.get(ACCESS_CONTRACT);
    records = moduleRef.get(ApplicationRecordService);
    decisions = moduleRef.get(DecisionService);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await closeSqlClients();
    await ownerSql?.end({ timeout: 1 });
    await container?.stop();
  });

  // ---------------------------------------------------------------------
  // Fixture helpers - raw SQL against ownerSql (bypasses RLS, as sms_owner),
  // same precedent as enrollment.spec.ts's/attendance.spec.ts's own
  // createTenant/createUser/createCampus helpers.
  // ---------------------------------------------------------------------
  async function createTenant(slug: string, name: string): Promise<TenantId> {
    const rows = await ownerSql`insert into tenancy.tenant (slug, name) values (${slug}, ${name}) returning id`;
    return (rows[0] as { id: string }).id as TenantId;
  }

  async function createCampus(tenantId: TenantId, code: string): Promise<CampusId> {
    const rows = await ownerSql`insert into tenancy.campus (tenant_id, code, name) values (${tenantId}, ${code}, ${code}) returning id`;
    return (rows[0] as { id: string }).id as CampusId;
  }

  async function createAcademicYear(tenantId: TenantId): Promise<AcademicYearId> {
    const rows = await ownerSql`
      insert into tenancy.academic_year (tenant_id, name, starts_on, ends_on, status)
      values (${tenantId}, ${'AY-' + newId()}, '2025-09-01', '2026-06-30', 'open')
      returning id
    `;
    return (rows[0] as { id: string }).id as AcademicYearId;
  }

  async function createGradeLevel(tenantId: TenantId, code: string): Promise<string> {
    const rows = await ownerSql`
      insert into academic.grade_level (tenant_id, code, name) values (${tenantId}, ${code}, ${code}) returning id
    `;
    return (rows[0] as { id: string }).id;
  }

  async function createUser(email: string): Promise<UserId> {
    const rows = await ownerSql`insert into identity.user (id, name, email) values (${newId()}, ${email}, ${email}) returning id`;
    return (rows[0] as { id: string }).id as UserId;
  }

  async function createMembership(tenantId: TenantId, userId: UserId): Promise<void> {
    await ownerSql`
      insert into identity.membership (id, tenant_id, user_id, status) values (${newId()}, ${tenantId}, ${userId}, 'active')
    `;
  }

  async function seedPermissionCatalogue(): Promise<void> {
    for (const def of PERMISSION_CATALOGUE) {
      await ownerSql`
        insert into access.permission (id, key, resource, action, description)
        values (${newId()}, ${def.key}, ${def.resource}, ${def.action}, ${def.description})
        on conflict (key) do nothing
      `;
    }
  }

  /** A role granting exactly `permissionKey` at `scope`, assigned to `userId` in `tenantId`. */
  async function grantScopedRole(tenantId: TenantId, userId: UserId, permissionKey: string, scope: string): Promise<void> {
    const roleId = newId();
    await ownerSql`insert into access.role (id, tenant_id, key, name) values (${roleId}, ${tenantId}, ${'role-' + roleId}, 'Test role')`;
    const permissionRows = await ownerSql`select id from access.permission where key = ${permissionKey} limit 1`;
    const permissionId = (permissionRows[0] as { id: string }).id;
    await ownerSql`insert into access.role_permission (id, role_id, permission_id, scope, tenant_id) values (${newId()}, ${roleId}, ${permissionId}, ${scope}, ${tenantId})`;
    await ownerSql`
      insert into access.role_assignment (id, tenant_id, role_id, user_id, campus_id)
      values (${newId()}, ${tenantId}, ${roleId}, ${userId}, null)
    `;
  }

  interface Fixture {
    readonly tenantId: TenantId;
    readonly campusId: CampusId;
    readonly academicYearId: AcademicYearId;
    readonly gradeLevelId: string;
  }

  async function createFixture(prefix: string): Promise<Fixture> {
    const tenantId = await createTenant(`tenant-adm-${prefix}`, `Tenant Admissions ${prefix}`);
    const campusId = await createCampus(tenantId, 'main');
    const academicYearId = await createAcademicYear(tenantId);
    const gradeLevelId = await createGradeLevel(tenantId, 'G7');
    return { tenantId, campusId, academicYearId, gradeLevelId };
  }

  function baseCtx(tenantId: TenantId) {
    return { tenantId, roles: [], requestId: newId() };
  }

  async function submitFixtureApplication(fixture: Fixture, givenName: string, familyName: string) {
    return runWithContext(baseCtx(fixture.tenantId), () =>
      records.submitApplication(fixture.tenantId, {
        applicantGivenName: givenName,
        applicantFamilyName: familyName,
        applicantDateOfBirth: '2014-01-01' as DateOnly,
        desiredAcademicYearId: fixture.academicYearId,
        desiredCampusId: fixture.campusId,
        desiredGradeLevelId: fixture.gradeLevelId,
      }),
    );
  }

  // ---------------------------------------------------------------------
  // 1. RLS isolates applications across tenants.
  // ---------------------------------------------------------------------
  it('1. RLS isolates applications across tenants', async () => {
    const fixtureX = await createFixture('rls-x');
    const fixtureY = await createFixture('rls-y');

    const submitted = await submitFixtureApplication(fixtureX, 'RLS', 'ApplicantX');
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) throw submitted.error;

    const listedInY = await records.listApplications(fixtureY.tenantId, {});
    expect(listedInY.items.find((a) => a.id === submitted.value.id)).toBeUndefined();

    const listedInX = await records.listApplications(fixtureX.tenantId, {});
    expect(listedInX.items.find((a) => a.id === submitted.value.id)).toBeDefined();

    // Directly against the table too, as the ordinary sms_app role with NO
    // app.tenant_id GUC set - rules out an application-level filter doing
    // the work RLS is supposed to.
    const appSqlNoContext = createSqlClient(process.env.DATABASE_URL!);
    try {
      const rows = await appSqlNoContext`select id from admissions.application where tenant_id = ${fixtureX.tenantId}`;
      expect(rows.length).toBe(0); // no app.tenant_id GUC set -> zero rows, never "every tenant"
    } finally {
      await appSqlNoContext.end({ timeout: 1 });
    }
  });

  // ---------------------------------------------------------------------
  // 2. application_stage_history and application_decision cannot be
  //    UPDATEd or DELETEd, even by the table owner (sms_owner) - RLS does
  //    not apply to an owner, but the append-only TRIGGERS do regardless of
  //    who the caller is.
  // ---------------------------------------------------------------------
  it('2. application_stage_history and application_decision cannot be UPDATEd or DELETEd, even by the table owner', async () => {
    const fixture = await createFixture('append-only');
    const submitted = await submitFixtureApplication(fixture, 'AppendOnly', 'Applicant');
    if (!submitted.ok) throw submitted.error;

    const applicationId = submitted.value.id;
    const stageHistoryRows = await ownerSql`select id from admissions.application_stage_history where application_id = ${applicationId}`;
    const stageHistoryId = (stageHistoryRows[0] as { id: string }).id;

    await expect(ownerSql`update admissions.application_stage_history set note = 'tampered' where id = ${stageHistoryId}`).rejects.toThrow(
      /append-only/i,
    );
    await expect(ownerSql`delete from admissions.application_stage_history where id = ${stageHistoryId}`).rejects.toThrow(/append-only/i);

    const decided = await runWithContext(baseCtx(fixture.tenantId), () =>
      decisions.recordDecision(fixture.tenantId, { applicationId, outcome: 'withdrawn', reason: 'Testing append-only' }),
    );
    if (!decided.ok) throw decided.error;

    const decisionId = decided.value.decision.id;
    await expect(ownerSql`update admissions.application_decision set reason = 'tampered' where id = ${decisionId}`).rejects.toThrow(
      /append-only/i,
    );
    await expect(ownerSql`delete from admissions.application_decision where id = ${decisionId}`).rejects.toThrow(/append-only/i);
  });

  // ---------------------------------------------------------------------
  // 3. Illegal stage moves/decisions are rejected; legal ones append
  //    history; a reversal (accepted -> withdrawn) appends a NEW decision
  //    row rather than mutating the earlier one.
  // ---------------------------------------------------------------------
  it('3. illegal moves/decisions are rejected; legal ones append; a reversal appends rather than mutates', async () => {
    const fixture = await createFixture('transitions');
    const submitted = await submitFixtureApplication(fixture, 'Transition', 'Applicant');
    if (!submitted.ok) throw submitted.error;
    const applicationId = submitted.value.id;
    const ctx = baseCtx(fixture.tenantId);

    // Illegal: cannot skip straight to 'assessment' from 'enquiry'.
    const illegalMove = await runWithContext(ctx, () => records.moveStage(fixture.tenantId, { applicationId, toStage: 'assessment' }));
    expect(illegalMove.ok).toBe(false);
    if (!illegalMove.ok) expect(illegalMove.error.code).toBe('VALIDATION_ERROR');

    // Illegal: cannot decide 'offered' straight from 'enquiry' either.
    const illegalDecision = await runWithContext(ctx, () => decisions.recordDecision(fixture.tenantId, { applicationId, outcome: 'offered' }));
    expect(illegalDecision.ok).toBe(false);
    if (!illegalDecision.ok) expect(illegalDecision.error.code).toBe('VALIDATION_ERROR');

    // Legal: enquiry -> applied -> assessment (clerical, :write).
    const toApplied = await runWithContext(ctx, () => records.moveStage(fixture.tenantId, { applicationId, toStage: 'applied' }));
    expect(toApplied.ok).toBe(true);
    const toAssessment = await runWithContext(ctx, () => records.moveStage(fixture.tenantId, { applicationId, toStage: 'assessment' }));
    expect(toAssessment.ok).toBe(true);

    // Legal: assessment -> offered -> accepted (:decide).
    const offered = await runWithContext(ctx, () => decisions.recordDecision(fixture.tenantId, { applicationId, outcome: 'offered', reason: 'Strong assessment' }));
    expect(offered.ok).toBe(true);
    if (!offered.ok) throw offered.error;
    const accepted = await runWithContext(ctx, () => decisions.recordDecision(fixture.tenantId, { applicationId, outcome: 'accepted' }));
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw accepted.error;

    // REVERSAL: the family declines after accepting - accepted -> withdrawn
    // is a legal decision (isLegalDecision), recorded as a NEW row.
    const withdrawnAfterAccept = await runWithContext(ctx, () =>
      decisions.recordDecision(fixture.tenantId, { applicationId, outcome: 'withdrawn', reason: 'Family declined after accepting' }),
    );
    expect(withdrawnAfterAccept.ok).toBe(true);

    // The full decision history survives every call above - nothing overwritten.
    const decisionHistory = await records.getDecisionHistory(fixture.tenantId, applicationId);
    expect(decisionHistory.map((d) => [d.fromStage, d.outcome])).toEqual([
      ['assessment', 'offered'],
      ['offered', 'accepted'],
      ['accepted', 'withdrawn'],
    ]);
    // The EARLIER 'accepted' row is untouched by the later reversal - it is
    // still exactly what it was written as, not edited in place.
    expect(decisionHistory[1]?.reason).toBeNull();
    expect(decisionHistory[1]?.outcome).toBe('accepted');

    const stageHistory = await records.getStageHistory(fixture.tenantId, applicationId);
    expect(stageHistory.map((s) => [s.fromStage, s.toStage])).toEqual([
      [null, 'enquiry'],
      ['enquiry', 'applied'],
      ['applied', 'assessment'],
    ]);
  });

  // ---------------------------------------------------------------------
  // 4. Accepting the same application twice produces exactly one enrolment
  //    and one person - the idempotent accept -> enrolment handoff.
  // ---------------------------------------------------------------------
  it('4. accepting the same application twice produces exactly one enrolment and one person', async () => {
    const fixture = await createFixture('idempotent-accept');
    const submitted = await submitFixtureApplication(fixture, 'Idempotent', 'Acceptee');
    if (!submitted.ok) throw submitted.error;
    const applicationId = submitted.value.id;
    const ctx = baseCtx(fixture.tenantId);

    await runWithContext(ctx, () => records.moveStage(fixture.tenantId, { applicationId, toStage: 'applied' }));
    await runWithContext(ctx, () => records.moveStage(fixture.tenantId, { applicationId, toStage: 'assessment' }));
    const offered = await runWithContext(ctx, () => decisions.recordDecision(fixture.tenantId, { applicationId, outcome: 'offered' }));
    if (!offered.ok) throw offered.error;

    // First accept: a REAL conversion - creates a person and an enrolment.
    const firstAccept = await runWithContext(ctx, () => decisions.recordDecision(fixture.tenantId, { applicationId, outcome: 'accepted' }));
    expect(firstAccept.ok).toBe(true);
    if (!firstAccept.ok) throw firstAccept.error;
    expect(firstAccept.value.conversion?.alreadyConverted).toBe(false);
    const personId = firstAccept.value.conversion?.personId;
    const enrollmentId = firstAccept.value.conversion?.enrollmentId;
    if (!personId || !enrollmentId) {
      throw new Error('Expected the first accept to have converted the application.');
    }

    // Second accept - a double-clicked/retried call, same application, same
    // outcome: must NOT create a second person or a second enrolment.
    const secondAccept = await runWithContext(ctx, () => decisions.recordDecision(fixture.tenantId, { applicationId, outcome: 'accepted' }));
    expect(secondAccept.ok).toBe(true);
    if (!secondAccept.ok) throw secondAccept.error;
    expect(secondAccept.value.conversion?.alreadyConverted).toBe(true);
    expect(secondAccept.value.conversion?.personId).toBe(personId);
    expect(secondAccept.value.conversion?.enrollmentId).toBe(enrollmentId);

    // No duplicate 'accepted' decision row was written by the replay.
    const decisionHistory = await records.getDecisionHistory(fixture.tenantId, applicationId);
    expect(decisionHistory.filter((d) => d.outcome === 'accepted')).toHaveLength(1);

    // Exactly one people.person row for this application's applicant...
    const personRows = await ownerSql`
      select count(*)::int as count from people.person
      where tenant_id = ${fixture.tenantId} and given_name = 'Idempotent' and family_name = 'Acceptee'
    `;
    expect((personRows[0] as { count: number }).count).toBe(1);

    // ...and exactly one enrollment.enrollment row for that person in the
    // desired academic year - proving the handoff went through
    // @sms/enrollment's own contract exactly once, not the admissions
    // schema faking it.
    const enrollmentRows = await ownerSql`
      select count(*)::int as count from enrollment.enrollment
      where tenant_id = ${fixture.tenantId} and person_id = ${personId} and academic_year_id = ${fixture.academicYearId}
    `;
    expect((enrollmentRows[0] as { count: number }).count).toBe(1);

    const enrollmentIdRows = await ownerSql`select id from enrollment.enrollment where tenant_id = ${fixture.tenantId} and person_id = ${personId}`;
    expect((enrollmentIdRows[0] as { id: string }).id).toBe(enrollmentId);
  });

  // ---------------------------------------------------------------------
  // 5. A caller holding only admissions.application:write is refused a
  //    decision endpoint (admissions.application:decide) - the same
  //    compiled-ability check PermissionGuard runs in production (see
  //    @sms/records' records.spec.ts test 7 for the established pattern of
  //    testing this at the ability layer rather than driving HTTP guards).
  // ---------------------------------------------------------------------
  it('5. a caller holding only admissions.application:write is refused admissions.application:decide', async () => {
    const fixture = await createFixture('write-only');
    await seedPermissionCatalogue();

    const writeOnlyUserId = await createUser(`write-only-${newId()}@example.com`);
    await createMembership(fixture.tenantId, writeOnlyUserId);
    await grantScopedRole(fixture.tenantId, writeOnlyUserId, 'admissions.application:write', 'tenant');

    const ability = await access.compileAbility(writeOnlyUserId, fixture.tenantId);
    expect(ability.can('decide', 'admissions.application')).toBe(false);
    // Sanity: the grant that WAS made compiled into something real, so the
    // `false` above is a genuine denial, not an empty/broken ability.
    expect(ability.can('write', 'admissions.application')).toBe(true);

    // The scope-constraint layer agrees: no constraint is even reported for
    // the permission this caller was never granted - PermissionGuard denies
    // the decide-gated route before AdmissionsController's own logic ever
    // runs.
    const constraints = await access.resolveScopeConstraints(writeOnlyUserId, fixture.tenantId);
    expect(constraints['admissions.application:decide']).toBeUndefined();
    expect(constraints['admissions.application:write']).toEqual({ kind: 'tenant' });
  });
});
