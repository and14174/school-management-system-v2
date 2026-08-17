import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Test, type TestingModule } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newId,
  type AcademicYearId,
  type CampusId,
  type DateOnly,
  type PersonId,
  type TenantId,
  type UserId,
} from '@sms/kernel';
import { closeSqlClients, createSqlClient, runWithContext, type Sql } from '@sms/db';
import { ACCESS_CONTRACT, PERMISSION_CATALOGUE, type AccessContract } from '@sms/access';
import { EnrollmentModule } from './api/enrollment.module.js';
import { EnrollmentsController } from './api/enrollments.controller.js';
import { EnrollmentRecordService } from './application/enrollment-record.service.js';
import { RolloverService } from './application/rollover.service.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

/**
 * Applies the real `audit` + `tenancy` + `identity` + `access` + `people` +
 * `academic` migrations (read, never edited - see the module report's
 * constraints) and this module's own `0700` migration to a throwaway
 * container, then proves - through the real application services, not
 * reimplementations of them - the properties this module exists for. See
 * the module brief's TESTS section for the exact list; each `it` block
 * below is numbered to match.
 */
describe('enrollment (real Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: Sql;
  let moduleRef: TestingModule;
  let rolloverService: RolloverService;
  let enrollmentsController: EnrollmentsController;
  let access: AccessContract;

  const records = new EnrollmentRecordService();

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
    // academic.spec.ts/people.spec.ts for why. Numeric prefixes make lexical
    // order the real apply order (see migrate.ts).
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
    await applyMigrations(join(__dirname, '..', '..', '..', 'domain', 'people', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', '..', 'domain', 'academic', 'migrations'));
    await applyMigrations(join(__dirname, '..', 'migrations'));

    const appUrl = new URL(ownerUrl);
    appUrl.username = 'sms_app';
    appUrl.password = 'dev';

    process.env.DATABASE_URL = appUrl.toString();
    process.env.DATABASE_MIGRATION_URL = ownerUrl;

    // RolloverService needs a real AUDIT_CONTRACT, whose implementation
    // (AuditService) is @sms/audit's internal detail this package cannot
    // reach past its public contract - building the real EnrollmentModule
    // through Nest's DI (same as AcademicModule's own "full cross-module
    // wiring" test) is what wires it in, exactly as apps/api does.
    moduleRef = await Test.createTestingModule({ imports: [EnrollmentModule] }).compile();
    rolloverService = moduleRef.get(RolloverService);
    enrollmentsController = moduleRef.get(EnrollmentsController);
    access = moduleRef.get(ACCESS_CONTRACT);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await closeSqlClients();
    await ownerSql?.end({ timeout: 1 });
    await container?.stop();
  });

  // ---------------------------------------------------------------------
  // Fixture helpers - raw SQL against ownerSql (bypasses RLS, as sms_owner),
  // same precedent as academic.spec.ts's/access.spec.ts's own createTenant/
  // createUser/createCampus helpers.
  // ---------------------------------------------------------------------
  async function createTenant(slug: string, name: string): Promise<TenantId> {
    const rows = await ownerSql`insert into tenancy.tenant (slug, name) values (${slug}, ${name}) returning id`;
    return (rows[0] as { id: string }).id as TenantId;
  }

  async function createCampus(tenantId: TenantId, code: string): Promise<CampusId> {
    const rows = await ownerSql`insert into tenancy.campus (tenant_id, code, name) values (${tenantId}, ${code}, ${code}) returning id`;
    return (rows[0] as { id: string }).id as CampusId;
  }

  async function createAcademicYear(tenantId: TenantId, status: string): Promise<AcademicYearId> {
    const rows = await ownerSql`
      insert into tenancy.academic_year (tenant_id, name, starts_on, ends_on, status)
      values (${tenantId}, ${'AY-' + newId()}, '2025-09-01', '2026-06-30', ${status})
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

  async function createPerson(tenantId: TenantId, givenName: string, familyName: string): Promise<PersonId> {
    const rows = await ownerSql`
      insert into people.person (id, tenant_id, given_name, family_name) values (${newId()}, ${tenantId}, ${givenName}, ${familyName}) returning id
    `;
    return (rows[0] as { id: string }).id as PersonId;
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

  /** A role granting exactly `permissionKey` at `scope` (optionally pinned to `campusId`), assigned to `userId` in `tenantId`. */
  async function grantScopedRole(
    tenantId: TenantId,
    userId: UserId,
    permissionKey: string,
    scope: string,
    campusId?: CampusId,
  ): Promise<void> {
    const roleId = newId();
    await ownerSql`insert into access.role (id, tenant_id, key, name) values (${roleId}, ${tenantId}, ${'role-' + roleId}, 'Test role')`;
    const permissionRows = await ownerSql`select id from access.permission where key = ${permissionKey} limit 1`;
    const permissionId = (permissionRows[0] as { id: string }).id;
    await ownerSql`insert into access.role_permission (id, role_id, permission_id, scope, tenant_id) values (${newId()}, ${roleId}, ${permissionId}, ${scope}, ${tenantId})`;
    await ownerSql`
      insert into access.role_assignment (id, tenant_id, role_id, user_id, campus_id)
      values (${newId()}, ${tenantId}, ${roleId}, ${userId}, ${campusId ?? null})
    `;
  }

  // ---------------------------------------------------------------------
  // 1. RLS isolates enrolments across tenants.
  // ---------------------------------------------------------------------
  it('1. RLS isolates enrolments across tenants', async () => {
    const tenantX = await createTenant('tenant-enrollment-rls-x', 'Tenant Enrollment RLS X');
    const tenantY = await createTenant('tenant-enrollment-rls-y', 'Tenant Enrollment RLS Y');

    const campusX = await createCampus(tenantX, 'main');
    const yearX = await createAcademicYear(tenantX, 'open');
    const gradeX = await createGradeLevel(tenantX, 'G7');
    const personX = await createPerson(tenantX, 'RLS', 'StudentX');

    const enrolled = await records.enrolStudent(tenantX, { personId: personX, academicYearId: yearX, campusId: campusX, gradeLevelId: gradeX });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) throw enrolled.error;

    const listedInY = await records.listEnrollments(tenantY, {});
    expect(listedInY.items.find((e) => e.id === enrolled.value.id)).toBeUndefined();

    const listedInX = await records.listEnrollments(tenantX, {});
    expect(listedInX.items.find((e) => e.id === enrolled.value.id)).toBeDefined();

    // Directly against the table too, as the ordinary sms_app role with NO
    // app.tenant_id GUC set - rules out an application-level filter doing
    // the work RLS is supposed to.
    const appSqlNoContext = createSqlClient(process.env.DATABASE_URL!);
    try {
      const rows = await appSqlNoContext`select id from enrollment.enrollment where tenant_id = ${tenantX}`;
      expect(rows.length).toBe(0); // no app.tenant_id GUC set -> zero rows, never "every tenant"
    } finally {
      await appSqlNoContext.end({ timeout: 1 });
    }
  });

  // ---------------------------------------------------------------------
  // 2. Illegal transition rejected; legal transitions append status_events
  //    and update the enrollment; the history survives later transitions.
  // ---------------------------------------------------------------------
  it('2. an illegal status transition is rejected; a legal one appends a status_event and updates the enrollment; history survives a later transition', async () => {
    const tenantId = await createTenant('tenant-enrollment-transitions', 'Tenant Enrollment Transitions');
    const campusId = await createCampus(tenantId, 'main');
    const academicYearId = await createAcademicYear(tenantId, 'open');
    const gradeLevelId = await createGradeLevel(tenantId, 'G8');
    const personId = await createPerson(tenantId, 'Transition', 'Student');

    const enrolled = await records.enrolStudent(tenantId, {
      personId,
      academicYearId,
      campusId,
      gradeLevelId,
      enrolledOn: '2025-09-01' as DateOnly,
    });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) throw enrolled.error;
    const enrollmentId = enrolled.value.id;

    // Illegal: re-enrolling someone already enrolled (enrolled -> enrolled).
    const illegalReenrol = await records.transitionStatus(tenantId, { enrollmentId, toStatus: 'enrolled', effectiveOn: '2025-09-02' as DateOnly });
    expect(illegalReenrol.ok).toBe(false);
    if (!illegalReenrol.ok) expect(illegalReenrol.error.code).toBe('VALIDATION_ERROR');

    // Legal: enrolled -> withdrawn.
    const withdrawn = await records.transitionStatus(tenantId, {
      enrollmentId,
      toStatus: 'withdrawn',
      effectiveOn: '2025-10-01' as DateOnly,
      reason: 'Moved away',
    });
    expect(withdrawn.ok).toBe(true);
    if (!withdrawn.ok) throw withdrawn.error;
    expect(withdrawn.value.status).toBe('withdrawn');
    expect(withdrawn.value.exitedOn).toBe('2025-10-01');
    expect(withdrawn.value.exitReason).toBe('Moved away');

    // Illegal: transitioning to the SAME status again.
    const illegalSameStatus = await records.transitionStatus(tenantId, { enrollmentId, toStatus: 'withdrawn', effectiveOn: '2025-10-05' as DateOnly });
    expect(illegalSameStatus.ok).toBe(false);

    // Legal: withdrawn -> enrolled (re-admission).
    const reenrolled = await records.transitionStatus(tenantId, { enrollmentId, toStatus: 'enrolled', effectiveOn: '2025-11-01' as DateOnly });
    expect(reenrolled.ok).toBe(true);
    if (!reenrolled.ok) throw reenrolled.error;
    expect(reenrolled.value.status).toBe('enrolled');
    expect(reenrolled.value.exitedOn).toBeNull();

    // Legal: enrolled -> graduated (terminal).
    const graduated = await records.transitionStatus(tenantId, { enrollmentId, toStatus: 'graduated', effectiveOn: '2025-12-01' as DateOnly });
    expect(graduated.ok).toBe(true);

    // Illegal: cannot transition OUT of graduated - it is terminal.
    const outOfGraduated = await records.transitionStatus(tenantId, { enrollmentId, toStatus: 'enrolled', effectiveOn: '2025-12-02' as DateOnly });
    expect(outOfGraduated.ok).toBe(false);
    if (!outOfGraduated.ok) expect(outOfGraduated.error.code).toBe('VALIDATION_ERROR');

    // The full history survives every transition above - nothing overwritten.
    const history = await records.getStatusHistory(tenantId, enrollmentId);
    expect(history.map((event) => [event.fromStatus, event.toStatus])).toEqual([
      [null, 'enrolled'],
      ['enrolled', 'withdrawn'],
      ['withdrawn', 'enrolled'],
      ['enrolled', 'graduated'],
    ]);
    // The very first event is untouched: still exactly what it was written as.
    expect(history[0]?.reason).toBe('Initial enrolment');
    expect(history[1]?.reason).toBe('Moved away');
  });

  // ---------------------------------------------------------------------
  // 3. assert_year_writable blocks enrolling into a locked year.
  // ---------------------------------------------------------------------
  it('3. tenancy.assert_year_writable blocks enrolling into a locked year', async () => {
    const tenantId = await createTenant('tenant-enrollment-locked-year', 'Tenant Enrollment Locked Year');
    const campusId = await createCampus(tenantId, 'main');
    const lockedYearId = await createAcademicYear(tenantId, 'locked');
    const gradeLevelId = await createGradeLevel(tenantId, 'G9');
    const personId = await createPerson(tenantId, 'Locked', 'Student');

    const blocked = await records.enrolStudent(tenantId, { personId, academicYearId: lockedYearId, campusId, gradeLevelId });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('VALIDATION_ERROR');

    const openYearId = await createAcademicYear(tenantId, 'open');
    const allowed = await records.enrolStudent(tenantId, { personId, academicYearId: openYearId, campusId, gradeLevelId });
    expect(allowed.ok).toBe(true);
  });

  // ---------------------------------------------------------------------
  // 4. rollOverYear(dryRun: true) writes nothing but returns the same
  //    counts the real run then produces - same code path, see
  //    RolloverService's own comment.
  // ---------------------------------------------------------------------
  it('4. rollOverYear dryRun writes nothing but returns the same counts the real run then produces', async () => {
    const tenantId = await createTenant('tenant-enrollment-rollover', 'Tenant Enrollment Rollover');
    const campusId = await createCampus(tenantId, 'main');
    const fromYearId = await createAcademicYear(tenantId, 'open');
    const toYearId = await createAcademicYear(tenantId, 'open');
    const fromGradeLevelId = await createGradeLevel(tenantId, 'RO-G7');
    const toGradeLevelId = await createGradeLevel(tenantId, 'RO-G8');
    const unmappedGradeLevelId = await createGradeLevel(tenantId, 'RO-G12');

    for (let i = 0; i < 3; i += 1) {
      const personId = await createPerson(tenantId, `Rollover${i}`, 'Student');
      const enrolled = await records.enrolStudent(tenantId, { personId, academicYearId: fromYearId, campusId, gradeLevelId: fromGradeLevelId });
      if (!enrolled.ok) throw enrolled.error;
    }
    // One extra student in a grade level with NO promotion mapping - skipped, not guessed at.
    const unmappedPersonId = await createPerson(tenantId, 'Unmapped', 'Student');
    const unmappedEnrolled = await records.enrolStudent(tenantId, {
      personId: unmappedPersonId,
      academicYearId: fromYearId,
      campusId,
      gradeLevelId: unmappedGradeLevelId,
    });
    if (!unmappedEnrolled.ok) throw unmappedEnrolled.error;

    const promotionMap = { [fromGradeLevelId]: toGradeLevelId };

    const preview = await rolloverService.rollOverYear(tenantId, {
      fromAcademicYearId: fromYearId,
      toAcademicYearId: toYearId,
      promotionMap,
      dryRun: true,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw preview.error;
    expect(preview.value.dryRun).toBe(true);
    expect(preview.value.bulkOperationId).toBeNull();
    expect(preview.value.rolloverRunId).toBeNull();
    expect(preview.value.counts).toEqual({ consideredCount: 4, promotedCount: 3, skippedCount: 1 });

    // Writes NOTHING: no rows in the target year, no rollover_run row.
    const toYearRowsAfterDryRun = await ownerSql`
      select count(*)::int as count from enrollment.enrollment where tenant_id = ${tenantId} and academic_year_id = ${toYearId}
    `;
    expect((toYearRowsAfterDryRun[0] as { count: number }).count).toBe(0);
    const rolloverRunsAfterDryRun = await ownerSql`select count(*)::int as count from enrollment.rollover_run where tenant_id = ${tenantId}`;
    expect((rolloverRunsAfterDryRun[0] as { count: number }).count).toBe(0);

    const real = await rolloverService.rollOverYear(tenantId, { fromAcademicYearId: fromYearId, toAcademicYearId: toYearId, promotionMap });
    expect(real.ok).toBe(true);
    if (!real.ok) throw real.error;
    expect(real.value.dryRun).toBe(false);
    expect(real.value.counts).toEqual(preview.value.counts);
    expect(real.value.bulkOperationId).toBeTruthy();
    expect(real.value.rolloverRunId).toBeTruthy();

    const toYearRowsAfterRealRun = await ownerSql`
      select count(*)::int as count from enrollment.enrollment where tenant_id = ${tenantId} and academic_year_id = ${toYearId}
    `;
    expect((toYearRowsAfterRealRun[0] as { count: number }).count).toBe(3);
  });

  // ---------------------------------------------------------------------
  // 5. rollOverYear is reversible: every row it writes shares one
  //    bulk_operation_id, and that id is recorded on rollover_run.
  // ---------------------------------------------------------------------
  it('5. rollOverYear is reversible: record_history rows it produced share one bulk_operation_id, recorded on rollover_run', async () => {
    const tenantId = await createTenant('tenant-enrollment-reversible', 'Tenant Enrollment Reversible');
    const campusId = await createCampus(tenantId, 'main');
    const fromYearId = await createAcademicYear(tenantId, 'open');
    const toYearId = await createAcademicYear(tenantId, 'open');
    const fromGradeLevelId = await createGradeLevel(tenantId, 'REV-FROM');
    const toGradeLevelId = await createGradeLevel(tenantId, 'REV-TO');

    const personId = await createPerson(tenantId, 'Reversible', 'Student');
    const enrolled = await records.enrolStudent(tenantId, { personId, academicYearId: fromYearId, campusId, gradeLevelId: fromGradeLevelId });
    if (!enrolled.ok) throw enrolled.error;

    const result = await rolloverService.rollOverYear(tenantId, {
      fromAcademicYearId: fromYearId,
      toAcademicYearId: toYearId,
      promotionMap: { [fromGradeLevelId]: toGradeLevelId },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.counts.promotedCount).toBe(1);
    const newEnrollmentId = result.value.outcomes[0]?.toEnrollmentId;
    if (!newEnrollmentId) {
      throw new Error('Expected rollOverYear to have promoted the reversible student.');
    }

    const enrollmentHistoryRows = await ownerSql`
      select distinct bulk_operation_id from audit.record_history
      where table_schema = 'enrollment' and table_name = 'enrollment' and record_id = ${newEnrollmentId}
    `;
    expect(enrollmentHistoryRows).toHaveLength(1);
    expect(enrollmentHistoryRows[0]?.bulk_operation_id).toBe(result.value.bulkOperationId);

    const statusEventRows = await ownerSql`select id from enrollment.status_event where enrollment_id = ${newEnrollmentId}`;
    expect(statusEventRows).toHaveLength(1);
    const statusEventHistoryRows = await ownerSql`
      select distinct bulk_operation_id from audit.record_history
      where table_schema = 'enrollment' and table_name = 'status_event' and record_id = ${(statusEventRows[0] as { id: string }).id}
    `;
    expect(statusEventHistoryRows).toHaveLength(1);
    expect(statusEventHistoryRows[0]?.bulk_operation_id).toBe(result.value.bulkOperationId);

    const rolloverRunRows = await ownerSql`select bulk_operation_id from enrollment.rollover_run where id = ${result.value.rolloverRunId}`;
    expect(rolloverRunRows[0]?.bulk_operation_id).toBe(result.value.bulkOperationId);
  });

  // ---------------------------------------------------------------------
  // 6. A campus-scoped caller sees only their campus's enrolments from
  //    BOTH the list and the single-record read.
  // ---------------------------------------------------------------------
  it("6. a campus-scoped caller sees only their campus's enrolments from both list and single-record read", async () => {
    const tenantId = await createTenant('tenant-enrollment-campus-scope', 'Tenant Enrollment Campus Scope');
    const campusA = await createCampus(tenantId, 'campus-a');
    const campusB = await createCampus(tenantId, 'campus-b');
    const academicYearId = await createAcademicYear(tenantId, 'open');
    const gradeLevelId = await createGradeLevel(tenantId, 'SCOPE-G');

    const personA = await createPerson(tenantId, 'CampusA', 'Student');
    const personB = await createPerson(tenantId, 'CampusB', 'Student');
    const enrolledA = await records.enrolStudent(tenantId, { personId: personA, academicYearId, campusId: campusA, gradeLevelId });
    const enrolledB = await records.enrolStudent(tenantId, { personId: personB, academicYearId, campusId: campusB, gradeLevelId });
    if (!enrolledA.ok) throw enrolledA.error;
    if (!enrolledB.ok) throw enrolledB.error;

    await seedPermissionCatalogue();

    const scopedUserId = await createUser(`campus-scoped-${newId()}@example.com`);
    await createMembership(tenantId, scopedUserId);
    await grantScopedRole(tenantId, scopedUserId, 'enrollment.enrollment:read', 'campus', campusA);

    const constraintCheck = await access.resolveScopeConstraints(scopedUserId, tenantId);
    expect(constraintCheck['enrollment.enrollment:read']).toEqual({ kind: 'campus', campusIds: [campusA] });

    const ctx = { tenantId, userId: scopedUserId, roles: [], requestId: newId() };

    // --- list: only campus A's enrolment comes back, never campus B's.
    const listed = await runWithContext(ctx, () =>
      enrollmentsController.listEnrollments(academicYearId, undefined, undefined, undefined, undefined, undefined, undefined),
    );
    expect(listed.items.map((e) => e.id)).toEqual([enrolledA.value.id]);

    // --- single-record read: their own campus's enrolment is readable...
    const ownCampusRead = await runWithContext(ctx, () => enrollmentsController.getEnrollment(enrolledA.value.id));
    expect(ownCampusRead.id).toBe(enrolledA.value.id);

    // ...but the OTHER campus's enrolment, read directly by id, is forbidden -
    // proving the guard's coarse "may this user read enrolments at all" check
    // is not the only thing standing between a campus-scoped caller and a
    // record outside their campus.
    await expect(runWithContext(ctx, () => enrollmentsController.getEnrollment(enrolledB.value.id))).rejects.toThrow(
      /do not have access/i,
    );
  });
});
