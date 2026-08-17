import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatDateOnly,
  newId,
  todayDateOnly,
  type AcademicYearId,
  type CampusId,
  type DateOnly,
  type PersonId,
  type TenantId,
  type UserId,
} from '@sms/kernel';
import { closeSqlClients, createSqlClient, runWithContext, type Sql } from '@sms/db';
import { ACCESS_CONTRACT, PERMISSION_CATALOGUE, type AccessContract } from '@sms/access';
import { AcademicModule } from './api/academic.module.js';
import { SchedulingController } from './api/scheduling.controller.js';
import type { TimetableRangeDto } from './api/dto/scheduling.dto.js';
import { BellScheduleService } from './application/bell-schedule.service.js';
import { CourseService } from './application/course.service.js';
import { DepartmentService } from './application/department.service.js';
import { GradeLevelService } from './application/grade-level.service.js';
import { RoomService } from './application/room.service.js';
import { SectionEnrollmentService } from './application/section-enrollment.service.js';
import { SectionMeetingService } from './application/section-meeting.service.js';
import { SectionScopeResolverService } from './application/section-scope-resolver.service.js';
import { SectionService } from './application/section.service.js';
import { SectionTeacherService } from './application/section-teacher.service.js';
import { SubjectService } from './application/subject.service.js';
import { TermService } from './application/term.service.js';
import type { DayOfWeek } from './domain/types.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

function shiftDateOnly(date: DateOnly, days: number): DateOnly {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(year, month - 1, day);
  shifted.setDate(shifted.getDate() + days);
  return formatDateOnly(shifted);
}

/** ISO 8601 day-of-week (1 = Monday ... 7 = Sunday) for `date` - a local copy of `SectionMeetingService`'s own private helper, needed here to pick a `dayOfWeek` for a meeting that matches "today" deterministically regardless of which day the suite happens to run on. */
function isoDayOfWeek(date: DateOnly): DayOfWeek {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const jsDay = new Date(year, month - 1, day).getDay();
  return (jsDay === 0 ? 7 : jsDay) as DayOfWeek;
}

/**
 * Applies the real `audit` + `tenancy` + `identity` + `access` + `people`
 * migrations (read, never edited - see the module report's constraints) and
 * this module's own `0600` migration to a throwaway container, then proves -
 * through the real application services, not reimplementations of them -
 * the properties this module exists for. See the module brief's TESTS
 * section for the exact list; each `it` block below is numbered to match.
 */
describe('academic (real Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: Sql;

  const gradeLevels = new GradeLevelService();
  const departments = new DepartmentService();
  const subjects = new SubjectService();
  const courses = new CourseService();
  const terms = new TermService();
  const sections = new SectionService();
  const sectionTeachers = new SectionTeacherService();
  const sectionEnrollments = new SectionEnrollmentService();
  const sectionScopeResolver = new SectionScopeResolverService();
  const rooms = new RoomService();
  const bellSchedules = new BellScheduleService();
  const sectionMeetings = new SectionMeetingService();

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
    // people.spec.ts/access.spec.ts for why. Numeric prefixes make lexical
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

  // ---------------------------------------------------------------------
  // Fixture helpers - raw SQL against ownerSql (bypasses RLS, as sms_owner),
  // same precedent as people.spec.ts/access.spec.ts's own createTenant/
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

  async function createUser(email: string): Promise<UserId> {
    const rows = await ownerSql`insert into identity.user (id, name, email) values (${newId()}, ${email}, ${email}) returning id`;
    return (rows[0] as { id: string }).id as UserId;
  }

  async function createPerson(tenantId: TenantId, givenName: string, familyName: string): Promise<PersonId> {
    const rows = await ownerSql`
      insert into people.person (id, tenant_id, given_name, family_name) values (${newId()}, ${tenantId}, ${givenName}, ${familyName}) returning id
    `;
    return (rows[0] as { id: string }).id as PersonId;
  }

  async function createMembership(tenantId: TenantId, userId: UserId, personId: PersonId): Promise<void> {
    await ownerSql`
      insert into identity.membership (id, tenant_id, user_id, person_id, status) values (${newId()}, ${tenantId}, ${userId}, ${personId}, 'active')
    `;
  }

  /** Grade level -> department -> subject -> course, the minimum a section needs to exist. */
  async function setupCourse(tenantId: TenantId): Promise<string> {
    const gradeLevel = await gradeLevels.create(tenantId, { code: `GL-${newId()}`, name: 'Grade X' });
    if (!gradeLevel.ok) throw gradeLevel.error;
    const department = await departments.create(tenantId, { code: `DPT-${newId()}`, name: 'Dept X' });
    if (!department.ok) throw department.error;
    const subject = await subjects.create(tenantId, { departmentId: department.value.id, code: `SUB-${newId()}`, name: 'Subject X' });
    if (!subject.ok) throw subject.error;
    const course = await courses.create(tenantId, { subjectId: subject.value.id, gradeLevelId: gradeLevel.value.id, code: `CRS-${newId()}`, name: 'Course X' });
    if (!course.ok) throw course.error;
    return course.value.id;
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

  // ---------------------------------------------------------------------
  // 1. RLS isolates academic rows across tenants.
  // ---------------------------------------------------------------------
  it('1. RLS isolates academic rows across tenants', async () => {
    const tenantX = await createTenant('tenant-academic-rls-x', 'Tenant Academic RLS X');
    const tenantY = await createTenant('tenant-academic-rls-y', 'Tenant Academic RLS Y');

    const created = await gradeLevels.create(tenantX, { code: 'RLS-X', name: 'RLS Test Grade' });
    if (!created.ok) throw created.error;

    const listedInY = await gradeLevels.list(tenantY);
    expect(listedInY.find((gl) => gl.id === created.value.id)).toBeUndefined();

    const listedInX = await gradeLevels.list(tenantX);
    expect(listedInX.find((gl) => gl.id === created.value.id)).toBeDefined();

    // Directly against the table too, as the ordinary sms_app role with NO
    // app.tenant_id GUC set - rules out an application-level filter doing
    // the work RLS is supposed to.
    const appSqlNoContext = createSqlClient(process.env.DATABASE_URL!);
    try {
      const rows = await appSqlNoContext`select id from academic.grade_level where tenant_id = ${tenantX}`;
      expect(rows.length).toBe(0); // no app.tenant_id GUC set -> zero rows, never "every tenant"
    } finally {
      await appSqlNoContext.end({ timeout: 1 });
    }
  });

  // ---------------------------------------------------------------------
  // 2. assert_year_writable blocks creating a term/section in a locked year.
  // ---------------------------------------------------------------------
  it('2. tenancy.assert_year_writable blocks creating a term (and, transitively, a section) in a locked year', async () => {
    const tenantId = await createTenant('tenant-academic-locked-year', 'Tenant Academic Locked Year');
    const lockedYearId = await createAcademicYear(tenantId, 'locked');

    const blockedTerm = await terms.createTerm(tenantId, {
      academicYearId: lockedYearId,
      name: 'Term 1',
      startsOn: '2025-09-01' as DateOnly,
      endsOn: '2026-01-30' as DateOnly,
    });
    expect(blockedTerm.ok).toBe(false);
    if (!blockedTerm.ok) expect(blockedTerm.error.code).toBe('VALIDATION_ERROR');

    // A term created while the year is OPEN succeeds; the year is then
    // locked, and creating a SECTION under that term (whose only path to
    // academic_year_id is term_id -> term.academic_year_id) is blocked too -
    // proving the section trigger really resolves the chain, not just
    // re-checking a column section doesn't have.
    const openYearId = await createAcademicYear(tenantId, 'open');
    const openTerm = await terms.createTerm(tenantId, {
      academicYearId: openYearId,
      name: 'Term 1',
      startsOn: '2025-09-01' as DateOnly,
      endsOn: '2026-01-30' as DateOnly,
    });
    expect(openTerm.ok).toBe(true);
    if (!openTerm.ok) throw openTerm.error;

    const campusId = await createCampus(tenantId, 'main');
    const courseId = await setupCourse(tenantId);

    const sectionBeforeLock = await sections.create(tenantId, {
      courseId,
      termId: openTerm.value.id,
      campusId,
      code: 'SEC-BEFORE-LOCK',
      name: 'Section before lock',
    });
    expect(sectionBeforeLock.ok).toBe(true);

    await ownerSql`update tenancy.academic_year set status = 'locked' where id = ${openYearId}`;

    const sectionAfterLock = await sections.create(tenantId, {
      courseId,
      termId: openTerm.value.id,
      campusId,
      code: 'SEC-AFTER-LOCK',
      name: 'Section after lock',
    });
    expect(sectionAfterLock.ok).toBe(false);
    if (!sectionAfterLock.ok) expect(sectionAfterLock.error.code).toBe('VALIDATION_ERROR');
  });

  // ---------------------------------------------------------------------
  // 3. Effective-dated section_enrollment: a transferred student is in the
  //    old section as-of an earlier date and the new one as-of today;
  //    overlapping identical enrolments are rejected.
  // ---------------------------------------------------------------------
  it('3. transferStudent end-dates the old enrollment and starts the new one; overlapping identical enrolments are rejected', async () => {
    const tenantId = await createTenant('tenant-academic-transfer', 'Tenant Academic Transfer');
    const campusId = await createCampus(tenantId, 'main');
    const academicYearId = await createAcademicYear(tenantId, 'open');
    const term = await terms.createTerm(tenantId, {
      academicYearId,
      name: 'Term 1',
      startsOn: '2025-09-01' as DateOnly,
      endsOn: '2026-06-30' as DateOnly,
    });
    if (!term.ok) throw term.error;
    const courseId = await setupCourse(tenantId);

    const sectionA = await sections.create(tenantId, { courseId, termId: term.value.id, campusId, code: 'SEC-A', name: 'Section A' });
    const sectionB = await sections.create(tenantId, { courseId, termId: term.value.id, campusId, code: 'SEC-B', name: 'Section B' });
    if (!sectionA.ok) throw sectionA.error;
    if (!sectionB.ok) throw sectionB.error;

    const studentId = await createPerson(tenantId, 'Transfer', 'Student');
    const today = todayDateOnly();
    const enrolledSince = shiftDateOnly(today, -30);

    const initialEnrollment = await sectionEnrollments.enrolStudent(tenantId, { sectionId: sectionA.value.id, personId: studentId, validFrom: enrolledSince });
    expect(initialEnrollment.ok).toBe(true);

    const transferred = await sectionEnrollments.transferStudent(tenantId, {
      personId: studentId,
      fromSectionId: sectionA.value.id,
      toSectionId: sectionB.value.id,
      effectiveFrom: today,
    });
    expect(transferred.ok).toBe(true);
    if (!transferred.ok) throw transferred.error;
    expect(transferred.value.endedEnrollment.sectionId).toBe(sectionA.value.id);
    expect(transferred.value.newEnrollment.sectionId).toBe(sectionB.value.id);

    // As of a date BEFORE the transfer: still in the OLD section only.
    const beforeTransfer = shiftDateOnly(today, -1);
    const oldRosterBefore = await sectionEnrollments.listStudentsInSection(tenantId, sectionA.value.id, beforeTransfer);
    expect(oldRosterBefore.some((s) => s.personId === studentId)).toBe(true);
    const newRosterBefore = await sectionEnrollments.listStudentsInSection(tenantId, sectionB.value.id, beforeTransfer);
    expect(newRosterBefore.some((s) => s.personId === studentId)).toBe(false);

    // As of TODAY: in the NEW section only - last term's gradebook (as-of a
    // past date) does not change, but "today" reflects the transfer.
    const oldRosterToday = await sectionEnrollments.listStudentsInSection(tenantId, sectionA.value.id, today);
    expect(oldRosterToday.some((s) => s.personId === studentId)).toBe(false);
    const newRosterToday = await sectionEnrollments.listStudentsInSection(tenantId, sectionB.value.id, today);
    expect(newRosterToday.some((s) => s.personId === studentId)).toBe(true);

    // Overlapping identical enrollment (same section, same person, still
    // open) is rejected by section_enrollment_no_overlap.
    const duplicateEnrollment = await sectionEnrollments.enrolStudent(tenantId, { sectionId: sectionB.value.id, personId: studentId });
    expect(duplicateEnrollment.ok).toBe(false);
    if (!duplicateEnrollment.ok) expect(duplicateEnrollment.error.code).toBe('CONFLICT');
  });

  // ---------------------------------------------------------------------
  // 4. THE HEADLINE TEST: a user with the teacher role and a
  //    section_teacher assignment resolves a NON-EMPTY section constraint,
  //    and listStudentsInSection returns only that section's students. A
  //    teacher with no assignment still resolves to nothing.
  // ---------------------------------------------------------------------
  it('4. headline: a section_teacher assignment resolves a non-empty section scope constraint and gates listStudentsInSection; no assignment resolves to nothing', async () => {
    const tenantId = await createTenant('tenant-academic-headline', 'Tenant Academic Headline');
    const campusId = await createCampus(tenantId, 'main');
    const academicYearId = await createAcademicYear(tenantId, 'open');
    const term = await terms.createTerm(tenantId, {
      academicYearId,
      name: 'Term 1',
      startsOn: '2025-09-01' as DateOnly,
      endsOn: '2026-06-30' as DateOnly,
    });
    if (!term.ok) throw term.error;
    const courseId = await setupCourse(tenantId);

    const sectionMine = await sections.create(tenantId, { courseId, termId: term.value.id, campusId, code: 'SEC-MINE', name: 'My section' });
    const sectionOther = await sections.create(tenantId, { courseId, termId: term.value.id, campusId, code: 'SEC-OTHER', name: 'Someone else\'s section' });
    if (!sectionMine.ok) throw sectionMine.error;
    if (!sectionOther.ok) throw sectionOther.error;

    const teacherPersonId = await createPerson(tenantId, 'Teaches', 'OneSection');
    const teacherUserId = await createUser(`teacher-headline-${newId()}@example.com`);
    await createMembership(tenantId, teacherUserId, teacherPersonId);

    const untaughtTeacherUserId = await createUser(`teacher-no-assignment-${newId()}@example.com`);
    const untaughtTeacherPersonId = await createPerson(tenantId, 'Teaches', 'Nothing');
    await createMembership(tenantId, untaughtTeacherUserId, untaughtTeacherPersonId);

    const assigned = await sectionTeachers.assignTeacher(tenantId, { sectionId: sectionMine.value.id, personId: teacherPersonId, role: 'lead' });
    expect(assigned.ok).toBe(true);

    const mineStudentId = await createPerson(tenantId, 'InMy', 'Section');
    const otherStudentId = await createPerson(tenantId, 'InOther', 'Section');
    const enrolledMine = await sectionEnrollments.enrolStudent(tenantId, { sectionId: sectionMine.value.id, personId: mineStudentId });
    const enrolledOther = await sectionEnrollments.enrolStudent(tenantId, { sectionId: sectionOther.value.id, personId: otherStudentId });
    expect(enrolledMine.ok).toBe(true);
    expect(enrolledOther.ok).toBe(true);

    // --- 4a. SectionScopeResolverService (this module's port implementation) ---
    const taughtSectionIds = await sectionScopeResolver.resolveTeachingSectionIds(teacherUserId, tenantId);
    expect(taughtSectionIds).toEqual([sectionMine.value.id]);

    const untaughtSectionIds = await sectionScopeResolver.resolveTeachingSectionIds(untaughtTeacherUserId, tenantId);
    expect(untaughtSectionIds).toEqual([]);

    // --- 4b. listStudentsInSection returns only that section's students ---
    const mineRoster = await sectionEnrollments.listStudentsInSection(tenantId, sectionMine.value.id);
    expect(mineRoster.map((s) => s.personId)).toEqual([mineStudentId]);
    const otherRoster = await sectionEnrollments.listStudentsInSection(tenantId, sectionOther.value.id);
    expect(otherRoster.map((s) => s.personId)).toEqual([otherStudentId]);

    // --- 4c. The full cross-module wiring: @sms/access's AbilityService,
    // via the REAL SECTION_SCOPE_RESOLVER binding AcademicModule provides
    // (see that module's own comment), resolves a NON-EMPTY `section`
    // constraint for the teacher with an assignment, and `none` for the one
    // without - proving the inversion actually reaches AbilityService, not
    // just this module's own resolver in isolation.
    await seedPermissionCatalogue();
    await grantScopedRole(tenantId, teacherUserId, 'people.student:read', 'section');
    await grantScopedRole(tenantId, untaughtTeacherUserId, 'people.student:read', 'section');

    const moduleRef = await Test.createTestingModule({ imports: [AcademicModule] }).compile();
    const access = moduleRef.get<AccessContract>(ACCESS_CONTRACT);

    const taughtConstraints = await access.resolveScopeConstraints(teacherUserId, tenantId);
    const taughtConstraint = taughtConstraints['people.student:read'];
    expect(taughtConstraint).toEqual({ kind: 'section', sectionIds: [sectionMine.value.id] });

    const taughtAbility = await access.compileAbility(teacherUserId, tenantId);
    expect(taughtAbility.can('read', 'people.student')).toBe(true);
    expect(taughtAbility.rules.length).toBeGreaterThan(0);

    const untaughtConstraints = await access.resolveScopeConstraints(untaughtTeacherUserId, tenantId);
    expect(untaughtConstraints['people.student:read']).toEqual({ kind: 'none' });

    const untaughtAbility = await access.compileAbility(untaughtTeacherUserId, tenantId);
    expect(untaughtAbility.can('read', 'people.student')).toBe(false);
    expect(untaughtAbility.rules.length).toBe(0);

    // --- 4d. The LIST endpoint must narrow to the caller's sections.
    //
    // Regression guard. `@RequirePermission('academic.section:read')` answers
    // only "may this user read sections at all" - a list request names no
    // section for it to test - so `GET /academic/sections` returned every
    // section in the school to a teacher who teaches one. A list endpoint
    // cannot be secured by a per-row check it never performs; the controller
    // has to apply the resolved constraint itself.
    await grantScopedRole(tenantId, teacherUserId, 'academic.section:read', 'section');
    await grantScopedRole(tenantId, untaughtTeacherUserId, 'academic.section:read', 'section');

    const sectionConstraints = await access.resolveScopeConstraints(teacherUserId, tenantId);
    const sectionConstraint = sectionConstraints['academic.section:read'];
    expect(sectionConstraint).toEqual({ kind: 'section', sectionIds: [sectionMine.value.id] });

    const allSections = await sections.list(tenantId, {});
    expect(allSections.map((s) => s.id).sort()).toEqual(
      [sectionMine.value.id, sectionOther.value.id].sort(),
    );

    // What the controller must return once the constraint is applied: its own
    // section only, never the other one.
    const narrowed =
      sectionConstraint?.kind === 'section'
        ? allSections.filter((s) => sectionConstraint.sectionIds.includes(s.id))
        : [];
    expect(narrowed.map((s) => s.id)).toEqual([sectionMine.value.id]);

    // And a teacher with no assignment at all sees none of them.
    const untaughtSectionConstraint = (await access.resolveScopeConstraints(untaughtTeacherUserId, tenantId))[
      'academic.section:read'
    ];
    expect(untaughtSectionConstraint).toEqual({ kind: 'none' });

    await moduleRef.close();
  }, 60_000);

  // ---------------------------------------------------------------------
  // Scheduling / timetabling (0610).
  // ---------------------------------------------------------------------

  it('5. room conflict: section_meeting_room_no_overlap rejects a double-booking, inserted directly against the table', async () => {
    const tenantId = await createTenant('tenant-academic-room-conflict', 'Tenant Academic Room Conflict');
    const campusId = await createCampus(tenantId, 'main');
    const academicYearId = await createAcademicYear(tenantId, 'open');
    const term = await terms.createTerm(tenantId, { academicYearId, name: 'Term 1', startsOn: '2025-09-01' as DateOnly, endsOn: '2026-06-30' as DateOnly });
    if (!term.ok) throw term.error;
    const courseId = await setupCourse(tenantId);

    const sectionA = await sections.create(tenantId, { courseId, termId: term.value.id, campusId, code: 'RM-A', name: 'Room Conflict A' });
    const sectionB = await sections.create(tenantId, { courseId, termId: term.value.id, campusId, code: 'RM-B', name: 'Room Conflict B' });
    if (!sectionA.ok) throw sectionA.error;
    if (!sectionB.ok) throw sectionB.error;

    const bellSchedule = await bellSchedules.createBellSchedule(tenantId, { campusId, academicYearId, name: 'Standard' });
    if (!bellSchedule.ok) throw bellSchedule.error;
    const period = await bellSchedules.createPeriod(tenantId, { bellScheduleId: bellSchedule.value.id, name: 'Period 1', sequence: 1, startsAt: '08:00:00', endsAt: '08:50:00' });
    if (!period.ok) throw period.error;
    const room = await rooms.create(tenantId, { campusId, code: 'RM-101', name: 'Room 101' });
    if (!room.ok) throw room.error;

    // First meeting - direct table insert (as sms_owner, bypassing this
    // module's service layer entirely) proves the DATABASE enforces this,
    // not an application-level check a second write path could skip.
    await ownerSql`
      insert into academic.section_meeting (id, tenant_id, section_id, period_id, day_of_week, room_id, valid_from)
      values (${newId()}, ${tenantId}, ${sectionA.value.id}, ${period.value.id}, 1, ${room.value.id}, '2025-09-01')
    `;

    // Second meeting: same room, same period, same day, overlapping validity.
    await expect(
      ownerSql`
        insert into academic.section_meeting (id, tenant_id, section_id, period_id, day_of_week, room_id, valid_from)
        values (${newId()}, ${tenantId}, ${sectionB.value.id}, ${period.value.id}, 1, ${room.value.id}, '2025-09-01')
      `,
    ).rejects.toThrow(/section_meeting_room_no_overlap/);
  });

  it('6. teacher conflict: trg_check_teacher_conflict rejects a double-booking, inserted directly against the table', async () => {
    const tenantId = await createTenant('tenant-academic-teacher-conflict', 'Tenant Academic Teacher Conflict');
    const campusId = await createCampus(tenantId, 'main');
    const academicYearId = await createAcademicYear(tenantId, 'open');
    const term = await terms.createTerm(tenantId, { academicYearId, name: 'Term 1', startsOn: '2025-09-01' as DateOnly, endsOn: '2026-06-30' as DateOnly });
    if (!term.ok) throw term.error;
    const courseId = await setupCourse(tenantId);

    const sectionA = await sections.create(tenantId, { courseId, termId: term.value.id, campusId, code: 'TC-A', name: 'Teacher Conflict A' });
    const sectionB = await sections.create(tenantId, { courseId, termId: term.value.id, campusId, code: 'TC-B', name: 'Teacher Conflict B' });
    if (!sectionA.ok) throw sectionA.error;
    if (!sectionB.ok) throw sectionB.error;

    const teacherId = await createPerson(tenantId, 'Double', 'Booked');
    const assignedA = await sectionTeachers.assignTeacher(tenantId, { sectionId: sectionA.value.id, personId: teacherId, role: 'lead' });
    const assignedB = await sectionTeachers.assignTeacher(tenantId, { sectionId: sectionB.value.id, personId: teacherId, role: 'lead' });
    expect(assignedA.ok).toBe(true);
    expect(assignedB.ok).toBe(true);

    const bellSchedule = await bellSchedules.createBellSchedule(tenantId, { campusId, academicYearId, name: 'Standard' });
    if (!bellSchedule.ok) throw bellSchedule.error;
    const period = await bellSchedules.createPeriod(tenantId, { bellScheduleId: bellSchedule.value.id, name: 'Period 1', sequence: 1, startsAt: '08:00:00', endsAt: '08:50:00' });
    if (!period.ok) throw period.error;

    // No room on either row (null both sides) - isolates the assertion to the
    // TEACHER trigger; section_meeting_room_no_overlap is exempt for a null room.
    await ownerSql`
      insert into academic.section_meeting (id, tenant_id, section_id, period_id, day_of_week, valid_from)
      values (${newId()}, ${tenantId}, ${sectionA.value.id}, ${period.value.id}, 2, '2025-09-01')
    `;

    await expect(
      ownerSql`
        insert into academic.section_meeting (id, tenant_id, section_id, period_id, day_of_week, valid_from)
        values (${newId()}, ${tenantId}, ${sectionB.value.id}, ${period.value.id}, 2, '2025-09-01')
      `,
    ).rejects.toThrow(/already teaches section/);
  });

  it('7. effective dating: a meeting that ended before today does not conflict with a new one in the same slot', async () => {
    const tenantId = await createTenant('tenant-academic-meeting-effective-dating', 'Tenant Academic Meeting Effective Dating');
    const campusId = await createCampus(tenantId, 'main');
    const academicYearId = await createAcademicYear(tenantId, 'open');
    const term = await terms.createTerm(tenantId, { academicYearId, name: 'Term 1', startsOn: '2020-09-01' as DateOnly, endsOn: '2026-06-30' as DateOnly });
    if (!term.ok) throw term.error;
    const courseId = await setupCourse(tenantId);

    const sectionA = await sections.create(tenantId, { courseId, termId: term.value.id, campusId, code: 'ED-A', name: 'Effective Dating A' });
    const sectionB = await sections.create(tenantId, { courseId, termId: term.value.id, campusId, code: 'ED-B', name: 'Effective Dating B' });
    if (!sectionA.ok) throw sectionA.error;
    if (!sectionB.ok) throw sectionB.error;

    const bellSchedule = await bellSchedules.createBellSchedule(tenantId, { campusId, academicYearId, name: 'Standard' });
    if (!bellSchedule.ok) throw bellSchedule.error;
    const period = await bellSchedules.createPeriod(tenantId, { bellScheduleId: bellSchedule.value.id, name: 'Period 1', sequence: 1, startsAt: '08:00:00', endsAt: '08:50:00' });
    if (!period.ok) throw period.error;
    const room = await rooms.create(tenantId, { campusId, code: 'ED-101', name: 'Room 101' });
    if (!room.ok) throw room.error;

    const today = todayDateOnly();
    const yesterday = shiftDateOnly(today, -1);
    const longAgo = shiftDateOnly(today, -400);

    // Old meeting for section A, ENDED yesterday.
    await ownerSql`
      insert into academic.section_meeting (id, tenant_id, section_id, period_id, day_of_week, room_id, valid_from, valid_to)
      values (${newId()}, ${tenantId}, ${sectionA.value.id}, ${period.value.id}, 1, ${room.value.id}, ${longAgo}, ${yesterday})
    `;

    // New meeting for section B, starting TODAY, same room/period/day - does
    // NOT overlap the old (ended) meeting's date range, so it is accepted.
    await expect(
      ownerSql`
        insert into academic.section_meeting (id, tenant_id, section_id, period_id, day_of_week, room_id, valid_from)
        values (${newId()}, ${tenantId}, ${sectionB.value.id}, ${period.value.id}, 1, ${room.value.id}, ${today})
      `,
    ).resolves.toBeDefined();
  });

  it("8. getTimetableForTeacher returns only that teacher's meetings and reflects a substitution on the substituted date", async () => {
    const tenantId = await createTenant('tenant-academic-teacher-timetable', 'Tenant Academic Teacher Timetable');
    const campusId = await createCampus(tenantId, 'main');
    const academicYearId = await createAcademicYear(tenantId, 'open');
    const today = todayDateOnly();
    const term = await terms.createTerm(tenantId, {
      academicYearId,
      name: 'Term 1',
      startsOn: shiftDateOnly(today, -60),
      endsOn: shiftDateOnly(today, 120),
    });
    if (!term.ok) throw term.error;
    const courseId = await setupCourse(tenantId);

    const sectionMine = await sections.create(tenantId, { courseId, termId: term.value.id, campusId, code: 'TT-MINE', name: 'Mine' });
    const sectionOther = await sections.create(tenantId, { courseId, termId: term.value.id, campusId, code: 'TT-OTHER', name: 'Other' });
    if (!sectionMine.ok) throw sectionMine.error;
    if (!sectionOther.ok) throw sectionOther.error;

    const teacherId = await createPerson(tenantId, 'Timetable', 'Teacher');
    const otherTeacherId = await createPerson(tenantId, 'Other', 'Teacher');
    const assignedMine = await sectionTeachers.assignTeacher(tenantId, { sectionId: sectionMine.value.id, personId: teacherId, role: 'lead' });
    const assignedOther = await sectionTeachers.assignTeacher(tenantId, { sectionId: sectionOther.value.id, personId: otherTeacherId, role: 'lead' });
    expect(assignedMine.ok).toBe(true);
    expect(assignedOther.ok).toBe(true);

    const bellSchedule = await bellSchedules.createBellSchedule(tenantId, { campusId, academicYearId, name: 'Standard' });
    if (!bellSchedule.ok) throw bellSchedule.error;
    const period1 = await bellSchedules.createPeriod(tenantId, { bellScheduleId: bellSchedule.value.id, name: 'Period 1', sequence: 1, startsAt: '08:00:00', endsAt: '08:50:00' });
    const period2 = await bellSchedules.createPeriod(tenantId, { bellScheduleId: bellSchedule.value.id, name: 'Period 2', sequence: 2, startsAt: '09:00:00', endsAt: '09:50:00' });
    if (!period1.ok) throw period1.error;
    if (!period2.ok) throw period2.error;

    const todayDow = isoDayOfWeek(today);
    const meetingsMine = await sectionMeetings.setSectionMeetings(tenantId, sectionMine.value.id, [
      { periodId: period1.value.id, dayOfWeek: todayDow, validFrom: shiftDateOnly(today, -14) },
    ]);
    const meetingsOther = await sectionMeetings.setSectionMeetings(tenantId, sectionOther.value.id, [
      { periodId: period2.value.id, dayOfWeek: todayDow, validFrom: shiftDateOnly(today, -14) },
    ]);
    if (!meetingsMine.ok) throw meetingsMine.error;
    if (!meetingsOther.ok) throw meetingsOther.error;

    const range = { from: shiftDateOnly(today, -7), to: shiftDateOnly(today, 7) };

    const before = await sectionMeetings.getTimetableForTeacher(tenantId, teacherId, range);
    expect(before.length).toBeGreaterThan(0);
    // ONLY this teacher's own section - never sectionOther's.
    expect(before.every((entry) => entry.sectionId === sectionMine.value.id)).toBe(true);
    const todaysEntryBefore = before.find((entry) => entry.date === today);
    expect(todaysEntryBefore).toBeDefined();
    expect(todaysEntryBefore?.isSubstituted).toBe(false);

    const meetingId = meetingsMine.value[0]!.id;
    const substituted = await sectionMeetings.assignSubstitute(tenantId, {
      sectionMeetingId: meetingId,
      date: today,
      substitutePersonId: otherTeacherId,
      reason: 'Sick day',
    });
    expect(substituted.ok).toBe(true);
    if (!substituted.ok) throw substituted.error;
    // The absent teacher is RESOLVED (the section's assigned lead), never
    // accepted as caller input - see AssignSubstituteInput's own comment.
    expect(substituted.value.absentPersonId).toBe(teacherId);

    const after = await sectionMeetings.getTimetableForTeacher(tenantId, teacherId, range);
    const todaysEntryAfter = after.find((entry) => entry.date === today);
    expect(todaysEntryAfter?.isSubstituted).toBe(true);
    expect(todaysEntryAfter?.substitutePersonId).toBe(otherTeacherId);

    // The SUBSTITUTE's own timetable now includes this occurrence too.
    const substituteTimetable = await sectionMeetings.getTimetableForTeacher(tenantId, otherTeacherId, range);
    const covered = substituteTimetable.find((entry) => entry.date === today && entry.sectionId === sectionMine.value.id);
    expect(covered).toBeDefined();
    expect(covered?.isSubstituting).toBe(true);
  });

  it('9. getTeacherWorkload counts periods-per-week per teacher correctly', async () => {
    const tenantId = await createTenant('tenant-academic-workload', 'Tenant Academic Workload');
    const campusId = await createCampus(tenantId, 'main');
    const academicYearId = await createAcademicYear(tenantId, 'open');
    const term = await terms.createTerm(tenantId, { academicYearId, name: 'Term 1', startsOn: '2025-09-01' as DateOnly, endsOn: '2026-06-30' as DateOnly });
    if (!term.ok) throw term.error;
    const courseId = await setupCourse(tenantId);

    const sectionA = await sections.create(tenantId, { courseId, termId: term.value.id, campusId, code: 'WL-A', name: 'Workload A' });
    const sectionB = await sections.create(tenantId, { courseId, termId: term.value.id, campusId, code: 'WL-B', name: 'Workload B' });
    if (!sectionA.ok) throw sectionA.error;
    if (!sectionB.ok) throw sectionB.error;

    // Explicit validFrom within the academic year's own [starts_on, ends_on]
    // (2025-09-01/2026-06-30 - see createAcademicYear) - getTeacherWorkload
    // evaluates "as of" a reference date CLAMPED to those bounds, so relying
    // on assignTeacher's default (today) would wrongly exclude this row
    // whenever the suite runs after the academic year has "ended".
    const workloadValidFrom = '2025-09-01' as DateOnly;
    const teacherId = await createPerson(tenantId, 'Busy', 'Teacher');
    const assignedA = await sectionTeachers.assignTeacher(tenantId, { sectionId: sectionA.value.id, personId: teacherId, role: 'lead', validFrom: workloadValidFrom });
    const assignedB = await sectionTeachers.assignTeacher(tenantId, { sectionId: sectionB.value.id, personId: teacherId, role: 'lead', validFrom: workloadValidFrom });
    expect(assignedA.ok).toBe(true);
    expect(assignedB.ok).toBe(true);

    const bellSchedule = await bellSchedules.createBellSchedule(tenantId, { campusId, academicYearId, name: 'Standard' });
    if (!bellSchedule.ok) throw bellSchedule.error;
    const period1 = await bellSchedules.createPeriod(tenantId, { bellScheduleId: bellSchedule.value.id, name: 'Period 1', sequence: 1, startsAt: '08:00:00', endsAt: '08:50:00' });
    const period2 = await bellSchedules.createPeriod(tenantId, { bellScheduleId: bellSchedule.value.id, name: 'Period 2', sequence: 2, startsAt: '09:00:00', endsAt: '09:50:00' });
    const period3 = await bellSchedules.createPeriod(tenantId, { bellScheduleId: bellSchedule.value.id, name: 'Period 3', sequence: 3, startsAt: '10:00:00', endsAt: '10:50:00' });
    if (!period1.ok) throw period1.error;
    if (!period2.ok) throw period2.error;
    if (!period3.ok) throw period3.error;

    // Section A: 2 meetings/week. Section B: 1 meeting/week. Total: 3.
    const meetingsA = await sectionMeetings.setSectionMeetings(tenantId, sectionA.value.id, [
      { periodId: period1.value.id, dayOfWeek: 1 as DayOfWeek, validFrom: workloadValidFrom },
      { periodId: period2.value.id, dayOfWeek: 3 as DayOfWeek, validFrom: workloadValidFrom },
    ]);
    const meetingsB = await sectionMeetings.setSectionMeetings(tenantId, sectionB.value.id, [
      { periodId: period3.value.id, dayOfWeek: 5 as DayOfWeek, validFrom: workloadValidFrom },
    ]);
    expect(meetingsA.ok).toBe(true);
    expect(meetingsB.ok).toBe(true);

    const workload = await sectionMeetings.getTeacherWorkload(tenantId, academicYearId);
    const mine = workload.find((entry) => entry.personId === teacherId);
    expect(mine).toBeDefined();
    expect(mine?.periodsPerWeek).toBe(3);
    expect(mine?.sectionCount).toBe(2);
  });

  it('10. a section-scoped teacher sees only their own timetable from both the personId-keyed timetable read and the sections/:id/meetings list', async () => {
    const tenantId = await createTenant('tenant-academic-timetable-scope', 'Tenant Academic Timetable Scope');
    const campusId = await createCampus(tenantId, 'main');
    const academicYearId = await createAcademicYear(tenantId, 'open');
    const today = todayDateOnly();
    const term = await terms.createTerm(tenantId, {
      academicYearId,
      name: 'Term 1',
      startsOn: shiftDateOnly(today, -60),
      endsOn: shiftDateOnly(today, 120),
    });
    if (!term.ok) throw term.error;
    const courseId = await setupCourse(tenantId);

    const sectionMine = await sections.create(tenantId, { courseId, termId: term.value.id, campusId, code: 'SCOPE-MINE', name: 'Mine' });
    const sectionOther = await sections.create(tenantId, { courseId, termId: term.value.id, campusId, code: 'SCOPE-OTHER', name: 'Other' });
    if (!sectionMine.ok) throw sectionMine.error;
    if (!sectionOther.ok) throw sectionOther.error;

    const teacherPersonId = await createPerson(tenantId, 'Scoped', 'Teacher');
    const teacherUserId = await createUser(`scoped-teacher-${newId()}@example.com`);
    await createMembership(tenantId, teacherUserId, teacherPersonId);

    const otherPersonId = await createPerson(tenantId, 'Other', 'Teacher');
    const assignedMine = await sectionTeachers.assignTeacher(tenantId, { sectionId: sectionMine.value.id, personId: teacherPersonId, role: 'lead' });
    const assignedOther = await sectionTeachers.assignTeacher(tenantId, { sectionId: sectionOther.value.id, personId: otherPersonId, role: 'lead' });
    expect(assignedMine.ok).toBe(true);
    expect(assignedOther.ok).toBe(true);

    const bellSchedule = await bellSchedules.createBellSchedule(tenantId, { campusId, academicYearId, name: 'Standard' });
    if (!bellSchedule.ok) throw bellSchedule.error;
    const period1 = await bellSchedules.createPeriod(tenantId, { bellScheduleId: bellSchedule.value.id, name: 'Period 1', sequence: 1, startsAt: '08:00:00', endsAt: '08:50:00' });
    const period2 = await bellSchedules.createPeriod(tenantId, { bellScheduleId: bellSchedule.value.id, name: 'Period 2', sequence: 2, startsAt: '09:00:00', endsAt: '09:50:00' });
    if (!period1.ok) throw period1.error;
    if (!period2.ok) throw period2.error;

    const meetingsMine = await sectionMeetings.setSectionMeetings(tenantId, sectionMine.value.id, [
      { periodId: period1.value.id, dayOfWeek: 1 as DayOfWeek, validFrom: shiftDateOnly(today, -14) },
    ]);
    const meetingsOther = await sectionMeetings.setSectionMeetings(tenantId, sectionOther.value.id, [
      { periodId: period2.value.id, dayOfWeek: 2 as DayOfWeek, validFrom: shiftDateOnly(today, -14) },
    ]);
    expect(meetingsMine.ok).toBe(true);
    expect(meetingsOther.ok).toBe(true);

    await seedPermissionCatalogue();
    await grantScopedRole(tenantId, teacherUserId, 'academic.timetable:read', 'section');

    const moduleRef = await Test.createTestingModule({ imports: [AcademicModule] }).compile();
    const controller = moduleRef.get(SchedulingController);
    const range = { from: shiftDateOnly(today, -7), to: shiftDateOnly(today, 7) };

    await runWithContext({ tenantId, userId: teacherUserId, personId: teacherPersonId, roles: [], requestId: newId() }, async () => {
      // personId-keyed read of THEIR OWN timetable: only their own section.
      const own = await controller.teacherTimetable(teacherPersonId, range as TimetableRangeDto);
      expect(own.length).toBeGreaterThan(0);
      expect(own.every((entry) => entry.sectionId === sectionMine.value.id)).toBe(true);

      // The SAME endpoint, asked for the OTHER teacher's personId: the
      // section-scoped constraint filters to sections THIS caller teaches -
      // sectionOther isn't among them, so nothing comes back. It never
      // returns the other teacher's real timetable.
      const other = await controller.teacherTimetable(otherPersonId, range as TimetableRangeDto);
      expect(other).toEqual([]);

      // "list": GET .../sections/:id/meetings for their OWN section succeeds...
      const ownMeetings = await controller.listMeetingsForSection(sectionMine.value.id);
      expect(ownMeetings.length).toBeGreaterThan(0);

      // ...but the identical endpoint for a section they do NOT teach is
      // forbidden outright - the single-record-read half of "apply
      // resolveScopeConstraints to every read", same reasoning as
      // SectionsController.getSection.
      await expect(controller.listMeetingsForSection(sectionOther.value.id)).rejects.toThrow();
    });

    await moduleRef.close();
  }, 60_000);
});
