import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Test, type TestingModule } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newId,
  todayDateOnly,
  unwrap,
  type AcademicYearId,
  type CampusId,
  type DateOnly,
  type PersonId,
  type TenantId,
  type UserId,
} from '@sms/kernel';
import { closeSqlClients, createSqlClient, runWithContext, type Sql } from '@sms/db';
import { ACCESS_CONTRACT, PERMISSION_CATALOGUE, type AccessContract } from '@sms/access';
import { ACADEMIC_CONTRACT, AcademicModule, type AcademicContract, type DayOfWeek } from '@sms/academic';
import { AttendanceController } from './api/attendance.controller.js';
import type { UnmarkedSessionsQueryDto } from './api/dto/attendance.dto.js';
import { AttendanceModule } from './api/attendance.module.js';
import { AttendanceCodeService } from './application/code.service.js';
import { AttendanceCorrectionService } from './application/correction.service.js';
import { AttendanceRecordService } from './application/attendance-record.service.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

/**
 * Applies the real `audit` + `tenancy` + `identity` + `access` + `people` +
 * `academic` + `outbox` migrations (read, never edited - see the module
 * report's constraints) and this module's own `0900` migration to a
 * throwaway container, then proves - through the real application services
 * and the real `AttendanceController` (built via Nest DI exactly like
 * `apps/api` wires it, importing `AcademicModule` alongside so
 * `SECTION_SCOPE_RESOLVER` resolves for real - same precedent as
 * `academic.spec.ts`'s own "full cross-module wiring" tests), not
 * reimplementations of them - the properties this module exists for. See the
 * module brief's TESTS section for the exact list; each `it` block below is
 * numbered to match.
 */
describe('attendance (real Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: Sql;
  let moduleRef: TestingModule;
  let academic: AcademicContract;
  let access: AccessContract;
  let attendanceController: AttendanceController;
  let codes: AttendanceCodeService;
  let records: AttendanceRecordService;
  let corrections: AttendanceCorrectionService;

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
    // this module brief's own "Test specs must read their module's
    // migrations folder" note (docs/decisions.md).
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
    await applyMigrations(join(__dirname, '..', '..', '..', 'platform', 'outbox', 'migrations'));
    await applyMigrations(join(__dirname, '..', 'migrations'));

    const appUrl = new URL(ownerUrl);
    appUrl.username = 'sms_app';
    appUrl.password = 'dev';

    process.env.DATABASE_URL = appUrl.toString();
    process.env.DATABASE_MIGRATION_URL = ownerUrl;

    moduleRef = await Test.createTestingModule({ imports: [AcademicModule, AttendanceModule] }).compile();
    academic = moduleRef.get(ACADEMIC_CONTRACT);
    access = moduleRef.get(ACCESS_CONTRACT);
    attendanceController = moduleRef.get(AttendanceController);
    codes = moduleRef.get(AttendanceCodeService);
    records = moduleRef.get(AttendanceRecordService);
    corrections = moduleRef.get(AttendanceCorrectionService);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await closeSqlClients();
    await ownerSql?.end({ timeout: 1 });
    await container?.stop();
  });

  // ---------------------------------------------------------------------
  // Fixture helpers - raw SQL against ownerSql (bypasses RLS, as sms_owner),
  // same precedent as academic.spec.ts's/enrollment.spec.ts's own
  // createTenant/createUser/createPerson helpers.
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
      values (${tenantId}, ${'AY-' + newId()}, '2020-01-01', '2035-01-01', 'open')
      returning id
    `;
    return (rows[0] as { id: string }).id as AcademicYearId;
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

  async function createMembership(tenantId: TenantId, userId: UserId, personId?: PersonId): Promise<void> {
    await ownerSql`
      insert into identity.membership (id, tenant_id, user_id, person_id, status)
      values (${newId()}, ${tenantId}, ${userId}, ${personId ?? null}, 'active')
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
    await ownerSql`insert into access.role_assignment (id, tenant_id, role_id, user_id) values (${newId()}, ${tenantId}, ${roleId}, ${userId})`;
  }

  interface SectionFixture {
    readonly sectionId: string;
    readonly meetingId: string;
  }

  /** A minimal but real section + one weekly meeting, through the REAL `AcademicContract` (not raw SQL) - so every trigger/invariant `@sms/academic` owns (assert_year_writable, room/teacher conflicts) is exercised exactly as it would be in production. */
  async function createSectionFixture(
    ctx: { tenantId: TenantId; roles: string[]; requestId: string },
    campusId: CampusId,
    academicYearId: AcademicYearId,
    dayOfWeek: DayOfWeek,
  ): Promise<SectionFixture> {
    return runWithContext(ctx, async () => {
      const suffix = newId();
      const department = unwrap(await academic.createDepartment({ code: `D-${suffix}`, name: `Dept ${suffix}` }));
      const subject = unwrap(await academic.createSubject({ departmentId: department.id, code: `S-${suffix}`, name: `Subj ${suffix}` }));
      const gradeLevel = unwrap(await academic.createGradeLevel({ code: `G-${suffix}`, name: `Grade ${suffix}` }));
      const course = unwrap(
        await academic.createCourse({ subjectId: subject.id, gradeLevelId: gradeLevel.id, code: `C-${suffix}`, name: `Course ${suffix}` }),
      );
      const term = unwrap(
        await academic.createTerm({ academicYearId, name: `Term-${suffix}`, startsOn: '2020-01-01' as DateOnly, endsOn: '2035-01-01' as DateOnly }),
      );
      const section = unwrap(
        await academic.createSection({ courseId: course.id, termId: term.id, campusId, code: `SEC-${suffix}`, name: `Section ${suffix}` }),
      );
      const bellSchedule = unwrap(await academic.createBellSchedule({ campusId, academicYearId, name: `Bell-${suffix}` }));
      const period = unwrap(
        await academic.createPeriod({ bellScheduleId: bellSchedule.id, name: `Period ${suffix}`, startsAt: '08:00:00', endsAt: '08:50:00' }),
      );
      const meetings = unwrap(
        await academic.setSectionMeetings(section.id, [
          { periodId: period.id, dayOfWeek, validFrom: '2020-01-01' as DateOnly, validTo: '2035-01-01' as DateOnly },
        ]),
      );
      return { sectionId: section.id, meetingId: meetings[0]!.id };
    });
  }

  async function enrolStudent(ctx: { tenantId: TenantId; roles: string[]; requestId: string }, sectionId: string, personId: PersonId): Promise<void> {
    await runWithContext(ctx, async () => {
      unwrap(await academic.enrolStudent({ sectionId, personId }));
    });
  }

  async function assignTeacher(ctx: { tenantId: TenantId; roles: string[]; requestId: string }, sectionId: string, personId: PersonId): Promise<void> {
    await runWithContext(ctx, async () => {
      unwrap(await academic.assignTeacher({ sectionId, personId, role: 'lead', validFrom: '2020-01-01' as DateOnly }));
    });
  }

  async function createPresentAndAbsentCodes(tenantId: TenantId): Promise<{ presentId: string; absentId: string }> {
    const present = unwrap(await codes.createCode(tenantId, { code: `PRESENT-${newId()}`, label: 'Present', category: 'present', countsAsPresent: true }));
    const absent = unwrap(await codes.createCode(tenantId, { code: `ABSENT-${newId()}`, label: 'Absent', category: 'absent', countsAsPresent: false }));
    return { presentId: present.id, absentId: absent.id };
  }

  function baseCtx(tenantId: TenantId, userId?: UserId): { tenantId: TenantId; userId?: UserId; actorUserId?: UserId; roles: string[]; requestId: string } {
    return { tenantId, ...(userId ? { userId, actorUserId: userId } : {}), roles: [], requestId: newId() };
  }

  function isoDayOfWeek(date: DateOnly): DayOfWeek {
    const [year, month, day] = date.split('-').map(Number) as [number, number, number];
    const jsDay = new Date(year, month - 1, day).getDay();
    return (jsDay === 0 ? 7 : jsDay) as DayOfWeek;
  }

  // ---------------------------------------------------------------------
  // 1. RLS isolates attendance across tenants.
  // ---------------------------------------------------------------------
  it('1. RLS isolates attendance across tenants', async () => {
    const tenantX = await createTenant('tenant-attendance-rls-x', 'Tenant Attendance RLS X');
    const tenantY = await createTenant('tenant-attendance-rls-y', 'Tenant Attendance RLS Y');
    const campusX = await createCampus(tenantX, 'main');
    const yearX = await createAcademicYear(tenantX);
    const personX = await createPerson(tenantX, 'RLS', 'StudentX');
    const ctxX = baseCtx(tenantX);

    const fixture = await createSectionFixture(ctxX, campusX, yearX, 1 as DayOfWeek);
    const { presentId } = await createPresentAndAbsentCodes(tenantX);

    const marked = await runWithContext(ctxX, () =>
      records.markSession(tenantX, {
        sectionMeetingId: fixture.meetingId,
        date: '2024-03-04' as DateOnly,
        idempotencyKey: `rls-${newId()}`,
        marks: [{ personId: personX, codeId: presentId }],
      }),
    );
    expect(marked.ok).toBe(true);
    if (!marked.ok) throw marked.error;

    // Cross-tenant read via the real service returns nothing for tenantY.
    const summaryFromY = await runWithContext(baseCtx(tenantY), () =>
      records.getAttendanceSummary(tenantY, { personId: personX, from: '2024-01-01' as DateOnly, to: '2024-12-31' as DateOnly }),
    );
    expect(summaryFromY.totalCount).toBe(0);

    const summaryFromX = await runWithContext(ctxX, () =>
      records.getAttendanceSummary(tenantX, { personId: personX, from: '2024-01-01' as DateOnly, to: '2024-12-31' as DateOnly }),
    );
    expect(summaryFromX.totalCount).toBe(1);

    // Directly against the table too, as the ordinary sms_app role with NO
    // app.tenant_id GUC set - rules out an application-level filter doing
    // the work RLS is supposed to (getAttendanceSummary's own query also
    // filters by tenant_id explicitly, so this is the proof that RLS - not
    // just that WHERE clause - is what actually blocks the row).
    const appSqlNoContext = createSqlClient(process.env.DATABASE_URL!);
    try {
      const rows = await appSqlNoContext`select id from attendance.record where tenant_id = ${tenantX}`;
      expect(rows.length).toBe(0); // no app.tenant_id GUC set -> zero rows, never "every tenant"
    } finally {
      await appSqlNoContext.end({ timeout: 1 });
    }
  });

  // ---------------------------------------------------------------------
  // 2. markSession is idempotent: the same idempotencyKey twice writes one
  //    set of records and one submission.
  // ---------------------------------------------------------------------
  it('2. markSession is idempotent: the same idempotencyKey twice writes one set of records and one submission', async () => {
    const tenantId = await createTenant('tenant-attendance-idempotent', 'Tenant Attendance Idempotent');
    const campusId = await createCampus(tenantId, 'main');
    const yearId = await createAcademicYear(tenantId);
    const ctx = baseCtx(tenantId);
    const fixture = await createSectionFixture(ctx, campusId, yearId, 2 as DayOfWeek);
    const { presentId } = await createPresentAndAbsentCodes(tenantId);
    const person1 = await createPerson(tenantId, 'Idem', 'One');
    const person2 = await createPerson(tenantId, 'Idem', 'Two');
    const date = '2024-03-05' as DateOnly; // a Tuesday
    const idempotencyKey = `idem-${newId()}`;

    const first = await runWithContext(ctx, () =>
      records.markSession(tenantId, {
        sectionMeetingId: fixture.meetingId,
        date,
        idempotencyKey,
        marks: [
          { personId: person1, codeId: presentId },
          { personId: person2, codeId: presentId },
        ],
      }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw first.error;
    expect(first.value.replayed).toBe(false);
    expect(first.value.records).toHaveLength(2);

    const second = await runWithContext(ctx, () =>
      records.markSession(tenantId, {
        sectionMeetingId: fixture.meetingId,
        date,
        idempotencyKey,
        marks: [
          { personId: person1, codeId: presentId },
          { personId: person2, codeId: presentId },
        ],
      }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw second.error;
    expect(second.value.replayed).toBe(true);
    expect(second.value.records.map((r) => r.id).sort()).toEqual(first.value.records.map((r) => r.id).sort());

    const recordRows = await ownerSql`select id from attendance.record where tenant_id = ${tenantId} and section_meeting_id = ${fixture.meetingId}`;
    expect(recordRows).toHaveLength(2); // not 4

    const submissionRows = await ownerSql`select id from attendance.submission where tenant_id = ${tenantId} and idempotency_key = ${idempotencyKey}`;
    expect(submissionRows).toHaveLength(1); // not 2
  });

  // ---------------------------------------------------------------------
  // 3. The outbox event is written in the SAME transaction as the mark;
  //    a failed marking transaction leaves neither the record nor the event.
  // ---------------------------------------------------------------------
  it('3. the outbox event is written in the same transaction as the mark; a failed transaction leaves neither', async () => {
    const tenantId = await createTenant('tenant-attendance-outbox', 'Tenant Attendance Outbox');
    const campusId = await createCampus(tenantId, 'main');
    const yearId = await createAcademicYear(tenantId);
    const ctx = baseCtx(tenantId);
    const fixture = await createSectionFixture(ctx, campusId, yearId, 3 as DayOfWeek);
    const { absentId } = await createPresentAndAbsentCodes(tenantId);
    const person1 = await createPerson(tenantId, 'Outbox', 'Absentee');
    const date = '2024-03-06' as DateOnly; // a Wednesday

    const marked = await runWithContext(ctx, () =>
      records.markSession(tenantId, {
        sectionMeetingId: fixture.meetingId,
        date,
        idempotencyKey: `outbox-ok-${newId()}`,
        marks: [{ personId: person1, codeId: absentId }],
      }),
    );
    expect(marked.ok).toBe(true);
    if (!marked.ok) throw marked.error;

    const eventRows = await ownerSql`
      select id, payload from outbox.message
      where tenant_id = ${tenantId} and topic = 'attendance.marked_absent' and payload->>'personId' = ${person1}
    `;
    expect(eventRows).toHaveLength(1);

    // --- Failure case: a batch whose SECOND mark references a code that does
    // not exist. mark[0] (an absence) would insert its record and publish its
    // event INSIDE the transaction before mark[1] throws - proving the whole
    // batch (record AND event) rolls back together, not just that a single
    // successful call writes both.
    const person2 = await createPerson(tenantId, 'Outbox', 'RolledBack');
    const person3 = await createPerson(tenantId, 'Outbox', 'AlsoRolledBack');
    const bogusCodeId = newId();

    const failed = await runWithContext(ctx, () =>
      records.markSession(tenantId, {
        sectionMeetingId: fixture.meetingId,
        date,
        idempotencyKey: `outbox-fail-${newId()}`,
        marks: [
          { personId: person2, codeId: absentId },
          { personId: person3, codeId: bogusCodeId },
        ],
      }),
    );
    expect(failed.ok).toBe(false);

    const rolledBackRecordRows = await ownerSql`
      select id from attendance.record where tenant_id = ${tenantId} and person_id = ${person2}
    `;
    expect(rolledBackRecordRows).toHaveLength(0);

    const rolledBackEventRows = await ownerSql`
      select id from outbox.message where tenant_id = ${tenantId} and payload->>'personId' = ${person2}
    `;
    expect(rolledBackEventRows).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // 4. A correction cannot be UPDATEd or DELETEd at table level.
  // ---------------------------------------------------------------------
  it('4. a correction cannot be UPDATEd or DELETEd at table level (append-only enforced by the database)', async () => {
    const tenantId = await createTenant('tenant-attendance-append-only', 'Tenant Attendance Append Only');
    const campusId = await createCampus(tenantId, 'main');
    const yearId = await createAcademicYear(tenantId);
    const ctx = baseCtx(tenantId);
    const fixture = await createSectionFixture(ctx, campusId, yearId, 4 as DayOfWeek);
    const { presentId, absentId } = await createPresentAndAbsentCodes(tenantId);
    const personId = await createPerson(tenantId, 'AppendOnly', 'Student');
    const date = '2024-03-07' as DateOnly; // a Thursday

    const marked = await runWithContext(ctx, () =>
      records.markSession(tenantId, {
        sectionMeetingId: fixture.meetingId,
        date,
        idempotencyKey: `append-only-${newId()}`,
        marks: [{ personId, codeId: presentId }],
      }),
    );
    if (!marked.ok) throw marked.error;
    const recordId = marked.value.records[0]!.id;

    const requested = await runWithContext(ctx, () =>
      corrections.requestCorrection(tenantId, { recordId, toCodeId: absentId, reason: 'Actually absent' }),
    );
    expect(requested.ok).toBe(true);
    if (!requested.ok) throw requested.error;
    const correctionId = requested.value.id;

    // UPDATE of an immutable field (not a decision field) is rejected...
    await expect(ownerSql`update attendance.correction set from_code_id = ${newId()} where id = ${correctionId}`).rejects.toThrow();

    // ...but the trigger is not "reject every UPDATE": a DECISION field alone
    // is allowed straight through the database, proving the trigger
    // discriminates rather than blanket-denying.
    await expect(
      ownerSql`update attendance.correction set status = 'approved', decided_at = now() where id = ${correctionId}`,
    ).resolves.toBeDefined();

    await expect(ownerSql`delete from attendance.correction where id = ${correctionId}`).rejects.toThrow();
  });

  // ---------------------------------------------------------------------
  // 5. Editing inside the lock window succeeds; outside it requires an
  //    approved correction.
  // ---------------------------------------------------------------------
  it('5. editing a record inside the lock window succeeds; outside it requires an approved correction', async () => {
    const tenantId = await createTenant('tenant-attendance-lock-window', 'Tenant Attendance Lock Window');
    const campusId = await createCampus(tenantId, 'main');
    const yearId = await createAcademicYear(tenantId);
    const ctx = baseCtx(tenantId);
    const fixture = await createSectionFixture(ctx, campusId, yearId, 5 as DayOfWeek);
    const { presentId, absentId } = await createPresentAndAbsentCodes(tenantId);
    const personId = await createPerson(tenantId, 'Lock', 'Window');
    const date = '2024-03-08' as DateOnly; // a Friday

    const first = await runWithContext(ctx, () =>
      records.markSession(tenantId, {
        sectionMeetingId: fixture.meetingId,
        date,
        idempotencyKey: `lock-first-${newId()}`,
        marks: [{ personId, codeId: presentId }],
      }),
    );
    if (!first.ok) throw first.error;
    const recordId = first.value.records[0]!.id;

    // Inside the window (just marked, seconds ago): a free edit succeeds.
    const editWithinWindow = await runWithContext(ctx, () =>
      records.markSession(tenantId, {
        sectionMeetingId: fixture.meetingId,
        date,
        idempotencyKey: `lock-edit-${newId()}`,
        marks: [{ personId, codeId: absentId }],
      }),
    );
    expect(editWithinWindow.ok).toBe(true);
    if (!editWithinWindow.ok) throw editWithinWindow.error;
    expect(editWithinWindow.value.records[0]?.codeId).toBe(absentId);

    // Push marked_at back past the free-edit window (25h > the 24h default).
    await ownerSql`update attendance.record set marked_at = now() - interval '25 hours' where id = ${recordId}`;

    const editOutsideWindow = await runWithContext(ctx, () =>
      records.markSession(tenantId, {
        sectionMeetingId: fixture.meetingId,
        date,
        idempotencyKey: `lock-late-${newId()}`,
        marks: [{ personId, codeId: presentId }],
      }),
    );
    expect(editOutsideWindow.ok).toBe(false);
    if (!editOutsideWindow.ok) {
      expect(editOutsideWindow.error.code).toBe('VALIDATION_ERROR');
    }

    // The record is untouched by the rejected attempt.
    const untouchedRows = await ownerSql`select code_id from attendance.record where id = ${recordId}`;
    expect((untouchedRows[0] as { code_id: string }).code_id).toBe(absentId);

    // The ONLY way to change it now: an approved correction.
    const correctionRequest = await runWithContext(ctx, () =>
      corrections.requestCorrection(tenantId, { recordId, toCodeId: presentId, reason: 'Parent called in' }),
    );
    expect(correctionRequest.ok).toBe(true);
    if (!correctionRequest.ok) throw correctionRequest.error;

    const decided = await runWithContext(ctx, () =>
      corrections.decideCorrection(tenantId, { correctionId: correctionRequest.value.id, approve: true }),
    );
    expect(decided.ok).toBe(true);
    if (!decided.ok) throw decided.error;
    expect(decided.value.status).toBe('approved');

    const correctedRows = await ownerSql`select code_id from attendance.record where id = ${recordId}`;
    expect((correctedRows[0] as { code_id: string }).code_id).toBe(presentId);
  });

  // ---------------------------------------------------------------------
  // 6. listUnmarkedSessions returns sessions with no submission and
  //    excludes those already marked.
  // ---------------------------------------------------------------------
  it('6. listUnmarkedSessions returns sessions with no submission and excludes those already marked', async () => {
    const tenantId = await createTenant('tenant-attendance-unmarked', 'Tenant Attendance Unmarked');
    const campusId = await createCampus(tenantId, 'main');
    const yearId = await createAcademicYear(tenantId);
    const ctx = baseCtx(tenantId);
    const date = '2024-03-11' as DateOnly; // a Monday
    const dayOfWeek = isoDayOfWeek(date);

    const marked = await createSectionFixture(ctx, campusId, yearId, dayOfWeek);
    const unmarked = await createSectionFixture(ctx, campusId, yearId, dayOfWeek);
    const { presentId } = await createPresentAndAbsentCodes(tenantId);
    const personId = await createPerson(tenantId, 'Unmarked', 'Student');

    const markedResult = await runWithContext(ctx, () =>
      records.markSession(tenantId, {
        sectionMeetingId: marked.meetingId,
        date,
        idempotencyKey: `unmarked-${newId()}`,
        marks: [{ personId, codeId: presentId }],
      }),
    );
    if (!markedResult.ok) throw markedResult.error;

    const sessions = await runWithContext(ctx, () => records.listUnmarkedSessions(tenantId, { date }));
    const sessionIds = sessions.map((session) => session.sectionMeetingId);
    expect(sessionIds).toContain(unmarked.meetingId);
    expect(sessionIds).not.toContain(marked.meetingId);
  });

  // ---------------------------------------------------------------------
  // 7. A section-scoped teacher can mark only their own sections and reads
  //    only their own attendance.
  // ---------------------------------------------------------------------
  it('7. a section-scoped teacher can mark only their own sections and reads only their own attendance', async () => {
    const tenantId = await createTenant('tenant-attendance-section-scope', 'Tenant Attendance Section Scope');
    const campusId = await createCampus(tenantId, 'main');
    const yearId = await createAcademicYear(tenantId);
    const systemCtx = baseCtx(tenantId);
    // Today, not a fixed calendar date: academic.section_enrollment's
    // valid_from defaults to today (SectionEnrollmentService.enrolStudent),
    // so getSessionRoster's roster query (which filters by the enrollment's
    // own effective-dated window) would come back empty for any date before
    // it - a fixed past date would silently break the roster assertion
    // below for a reason that has nothing to do with the scope check this
    // test exists to prove.
    const date = todayDateOnly();
    const dayOfWeek = isoDayOfWeek(date);

    const ownSection = await createSectionFixture(systemCtx, campusId, yearId, dayOfWeek);
    const otherSection = await createSectionFixture(systemCtx, campusId, yearId, dayOfWeek);
    const { presentId } = await createPresentAndAbsentCodes(tenantId);

    const teacherPersonId = await createPerson(tenantId, 'Section', 'Teacher');
    await assignTeacher(systemCtx, ownSection.sectionId, teacherPersonId);

    const studentId = await createPerson(tenantId, 'Section', 'Student');
    await enrolStudent(systemCtx, ownSection.sectionId, studentId);
    const otherStudentId = await createPerson(tenantId, 'Other', 'Student');
    await enrolStudent(systemCtx, otherSection.sectionId, otherStudentId);

    const teacherUserId = await createUser(`section-teacher-${newId()}@example.com`);
    await createMembership(tenantId, teacherUserId, teacherPersonId);

    await seedPermissionCatalogue();
    await grantScopedRole(tenantId, teacherUserId, 'attendance.record:read', 'section');
    await grantScopedRole(tenantId, teacherUserId, 'attendance.record:write', 'section');

    const teacherCtx = baseCtx(tenantId, teacherUserId);

    const constraintCheck = await access.resolveScopeConstraints(teacherUserId, tenantId);
    expect(constraintCheck['attendance.record:read']).toEqual({ kind: 'section', sectionIds: [ownSection.sectionId] });

    // --- roster read: own section succeeds...
    const ownRoster = await runWithContext(teacherCtx, () => attendanceController.getSessionRoster(ownSection.meetingId, { date }));
    expect(ownRoster.sectionId).toBe(ownSection.sectionId);
    expect(ownRoster.entries.map((entry) => entry.personId)).toContain(studentId);

    // ...but the OTHER section's roster, read directly by meeting id, is forbidden.
    await expect(runWithContext(teacherCtx, () => attendanceController.getSessionRoster(otherSection.meetingId, { date }))).rejects.toThrow(
      /do not have access/i,
    );

    // --- marking: own section succeeds...
    const ownMark = await runWithContext(teacherCtx, () =>
      attendanceController.markSession({
        sectionMeetingId: ownSection.meetingId,
        date,
        idempotencyKey: `scope-own-${newId()}`,
        marks: [{ personId: studentId, codeId: presentId }],
      }),
    );
    expect(ownMark.records).toHaveLength(1);

    // ...but marking the OTHER section is forbidden, before any write happens.
    await expect(
      runWithContext(teacherCtx, () =>
        attendanceController.markSession({
          sectionMeetingId: otherSection.meetingId,
          date,
          idempotencyKey: `scope-other-${newId()}`,
          marks: [{ personId: otherStudentId, codeId: presentId }],
        }),
      ),
    ).rejects.toThrow(/do not have access/i);

    const otherSectionRecordRows = await ownerSql`
      select id from attendance.record where tenant_id = ${tenantId} and section_id = ${otherSection.sectionId}
    `;
    expect(otherSectionRecordRows).toHaveLength(0);

    // --- listUnmarkedSessions: the teacher's own unmarked-but-scheduled
    // session is visible; the other section's is not, even though it too has
    // no submission yet as of this point.
    const otherStillUnmarked = await runWithContext(teacherCtx, () =>
      attendanceController.listUnmarkedSessions({ date } as UnmarkedSessionsQueryDto),
    );
    const otherIds = otherStillUnmarked.map((s: { sectionMeetingId: string }) => s.sectionMeetingId);
    expect(otherIds).not.toContain(otherSection.meetingId);
  });
});
