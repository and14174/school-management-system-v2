#!/usr/bin/env tsx
/**
 * Idempotent local-dev/CI seed data: grade levels 7-12, 4 departments, 8
 * subjects, 10 courses, 2 terms for the current academic year, 12 sections
 * across both campuses, teacher assignments, and enrolment of all 16
 * students `@sms/people`'s seed creates. Also assigns the `teacher` role
 * (`@sms/access`'s seed) to a NEW user `teacher@greenwood.test`, linked to
 * `Priya Nandakumar` - one of `@sms/people`'s seeded staff, already carrying
 * the "Teacher" title in that script's own data - and gives her a `lead`
 * assignment on at least one section, so signing in as that user is the
 * live demonstration that a `section`-scoped grant now resolves to
 * something real (see `@sms/access`'s `AbilityService` / this module's
 * `SectionScopeResolverService`).
 *
 * Complements (does not modify - see the module report's constraints)
 * `@sms/tenancy`'s, `@sms/identity`'s, `@sms/access`'s and `@sms/people`'s
 * own `seed.ts`: all four must have already run (this script looks up the
 * "greenwood" tenant, its campuses and current academic year, the "teacher"
 * role, and the seeded students/staff by name, and fails with a clear
 * message if any is missing).
 *
 * Grade levels are seeded 7-12 only (per the module brief), but
 * `@sms/people`'s seed spans Kindergarten-12 - most of its 16 students fall
 * outside 7-12. Nothing in this schema ties a `section_enrollment` to the
 * enrolled student's own grade level (that is a future gradebook/promotion
 * concern, not a structural one), so every student is still enrolled into a
 * section below, round-robin, purely to exercise the roster mechanism this
 * module exists to prove - not as a claim that the assignment is
 * pedagogically accurate.
 *
 * Usage: tsx src/seed.ts (run after tenancy's, identity's, access's and
 * people's). Not wired into `apps/api`'s `db:seed` chain - that script lives
 * at `apps/api/package.json`, outside this module's allowed edit paths (see
 * the module report's constraints); run this seed manually as the last step.
 */
import 'reflect-metadata';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { closeSqlClients, withSystemTx } from '@sms/db';
import { formatDateOnly, newId, type AcademicYearId, type CampusId, type DateOnly, type PersonId, type TenantId, type UserId } from '@sms/kernel';
import { getAuth } from '@sms/identity';
import { BellScheduleService } from './application/bell-schedule.service.js';
import { CourseService } from './application/course.service.js';
import { DepartmentService } from './application/department.service.js';
import { GradeLevelService } from './application/grade-level.service.js';
import { RoomService } from './application/room.service.js';
import { SectionEnrollmentService } from './application/section-enrollment.service.js';
import { SectionMeetingService } from './application/section-meeting.service.js';
import { SectionService } from './application/section.service.js';
import { SectionTeacherService } from './application/section-teacher.service.js';
import { SubjectService } from './application/subject.service.js';
import { TermService } from './application/term.service.js';
import type { DayOfWeek } from './domain/types.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// Resolved relative to this file, not process.cwd() - see @sms/tenancy's migrate.ts/seed.ts for why.
try {
  process.loadEnvFile(join(__dirname, '..', '..', '..', '..', '.env'));
} catch {
  // no .env file present - assume the environment already has what we need
}

const TEACHER_EMAIL = 'teacher@greenwood.test';
const TEACHER_PASSWORD = 'Passw0rd!demo';

const gradeLevels = new GradeLevelService();
const departments = new DepartmentService();
const subjects = new SubjectService();
const courses = new CourseService();
const terms = new TermService();
const sections = new SectionService();
const sectionTeachers = new SectionTeacherService();
const sectionEnrollments = new SectionEnrollmentService();
const rooms = new RoomService();
const bellSchedules = new BellScheduleService();
const sectionMeetings = new SectionMeetingService();

async function findGreenwoodTenantId(): Promise<TenantId> {
  const rows = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from tenancy.tenant where slug = 'greenwood' limit 1`));
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error('No tenant with slug "greenwood" found. Run @sms/tenancy\'s seed first.');
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

async function findCurrentAcademicYearId(tenantId: TenantId): Promise<AcademicYearId> {
  const rows = await withSystemTx((db) =>
    db.execute<{ id: string }>(sql`select id from tenancy.academic_year where tenant_id = ${tenantId} and is_current limit 1`),
  );
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error('No current academic year found for tenant "greenwood". Run @sms/tenancy\'s seed first.');
  }
  return row.id as AcademicYearId;
}

async function findPersonByNameAndDob(tenantId: TenantId, givenName: string, familyName: string, dateOfBirth: DateOnly): Promise<PersonId> {
  const rows = await withSystemTx((db) =>
    db.execute<{ id: string }>(
      sql`select id from people.person where tenant_id = ${tenantId} and given_name = ${givenName} and family_name = ${familyName} and date_of_birth = ${dateOfBirth} and merged_into_id is null limit 1`,
    ),
  );
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error(`No person "${givenName} ${familyName}" (dob ${dateOfBirth}) found. Run @sms/people's seed first.`);
  }
  return row.id as PersonId;
}

async function findTeacherRoleId(tenantId: TenantId): Promise<string> {
  const rows = await withSystemTx((db) =>
    db.execute<{ id: string }>(sql`select id from access.role where tenant_id = ${tenantId} and key = 'teacher' limit 1`),
  );
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error('No "teacher" role found. Run @sms/access\'s seed first.');
  }
  return row.id;
}

/**
 * Creates the Better Auth user directly (`getAuth().api.signUpEmail`, the
 * same public entrypoint `@sms/identity`'s own `seed.ts` and `access.spec.ts`
 * use) plus an `active` `identity.membership` row via raw SQL - this package
 * can reach `@sms/identity`'s public contract but not its internal
 * `MembershipService`, and a raw insert into another module's table is the
 * same established precedent `@sms/people`'s `seed.ts` already relies on for
 * `identity.membership`/`custom_fields.field_definition`.
 */
async function ensureTeacherUser(tenantId: TenantId): Promise<UserId> {
  const existingRows = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from identity.user where email = ${TEACHER_EMAIL} limit 1`));
  const existing = (existingRows as unknown as Array<{ id: string }>)[0];

  let userId: UserId;
  if (existing) {
    console.log(`  skip   user "${TEACHER_EMAIL}" (already exists)`);
    userId = existing.id as UserId;
  } else {
    const signUpResult = await getAuth().api.signUpEmail({ body: { name: 'Priya Nandakumar', email: TEACHER_EMAIL, password: TEACHER_PASSWORD } });
    userId = signUpResult.user.id as UserId;
    console.log(`  create user "${TEACHER_EMAIL}"`);
  }

  const membershipRows = await withSystemTx((db) =>
    db.execute<{ person_id: string | null }>(sql`select person_id from identity.membership where tenant_id = ${tenantId} and user_id = ${userId} limit 1`),
  );
  const membership = (membershipRows as unknown as Array<{ person_id: string | null }>)[0];
  if (membership) {
    console.log(`  skip   membership for "${TEACHER_EMAIL}" (already exists)`);
  } else {
    await withSystemTx((db) =>
      db.execute(sql`insert into identity.membership (id, tenant_id, user_id, status) values (${newId()}, ${tenantId}, ${userId}, 'active')`),
    );
    console.log(`  create membership for "${TEACHER_EMAIL}" on tenant "greenwood"`);
  }

  return userId;
}

async function linkTeacherPerson(tenantId: TenantId, userId: UserId, personId: PersonId): Promise<void> {
  const rows = await withSystemTx((db) =>
    db.execute<{ person_id: string | null }>(sql`select person_id from identity.membership where tenant_id = ${tenantId} and user_id = ${userId} limit 1`),
  );
  const row = (rows as unknown as Array<{ person_id: string | null }>)[0];
  if (row?.person_id) {
    console.log(`  skip   membership -> person link for "${TEACHER_EMAIL}" (already linked)`);
    return;
  }
  await withSystemTx((db) => db.execute(sql`update identity.membership set person_id = ${personId} where tenant_id = ${tenantId} and user_id = ${userId}`));
  console.log(`  link   membership for "${TEACHER_EMAIL}" -> person ${personId} (Priya Nandakumar)`);
}

async function ensureTeacherRoleAssignment(tenantId: TenantId, userId: UserId): Promise<void> {
  const roleId = await findTeacherRoleId(tenantId);
  const existing = await withSystemTx((db) =>
    db.execute<{ id: string }>(
      sql`select id from access.role_assignment where tenant_id = ${tenantId} and role_id = ${roleId} and user_id = ${userId} and valid_to is null limit 1`,
    ),
  );
  if ((existing as unknown as unknown[]).length > 0) {
    console.log(`  skip   role "teacher" assignment for "${TEACHER_EMAIL}" (already exists)`);
    return;
  }
  await withSystemTx((db) =>
    db.execute(sql`insert into access.role_assignment (id, tenant_id, role_id, user_id) values (${newId()}, ${tenantId}, ${roleId}, ${userId})`),
  );
  console.log(`  assign role "teacher" to "${TEACHER_EMAIL}"`);
}

async function ensureGradeLevel(tenantId: TenantId, code: string, name: string, sequence: number): Promise<string> {
  const existing = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from academic.grade_level where tenant_id = ${tenantId} and code = ${code} limit 1`));
  const row = (existing as unknown as Array<{ id: string }>)[0];
  if (row) return row.id;
  const created = await gradeLevels.create(tenantId, { code, name, sequence });
  if (!created.ok) throw created.error;
  console.log(`  create grade level "${code}"`);
  return created.value.id;
}

async function ensureDepartment(tenantId: TenantId, code: string, name: string): Promise<string> {
  const existing = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from academic.department where tenant_id = ${tenantId} and code = ${code} limit 1`));
  const row = (existing as unknown as Array<{ id: string }>)[0];
  if (row) return row.id;
  const created = await departments.create(tenantId, { code, name });
  if (!created.ok) throw created.error;
  console.log(`  create department "${code}"`);
  return created.value.id;
}

async function ensureSubject(tenantId: TenantId, departmentId: string, code: string, name: string): Promise<string> {
  const existing = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from academic.subject where tenant_id = ${tenantId} and code = ${code} limit 1`));
  const row = (existing as unknown as Array<{ id: string }>)[0];
  if (row) return row.id;
  const created = await subjects.create(tenantId, { departmentId, code, name });
  if (!created.ok) throw created.error;
  console.log(`  create subject "${code}"`);
  return created.value.id;
}

async function ensureCourse(tenantId: TenantId, subjectId: string, gradeLevelId: string, code: string, name: string, creditsValue: number): Promise<string> {
  const existing = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from academic.course where tenant_id = ${tenantId} and code = ${code} limit 1`));
  const row = (existing as unknown as Array<{ id: string }>)[0];
  if (row) return row.id;
  const created = await courses.create(tenantId, { subjectId, gradeLevelId, code, name, credits: creditsValue });
  if (!created.ok) throw created.error;
  console.log(`  create course "${code}"`);
  return created.value.id;
}

/** The seeded academic year's own span - terms are cut from it rather than hardcoded. */
async function getAcademicYearRange(academicYearId: AcademicYearId): Promise<{ startsOn: DateOnly; endsOn: DateOnly }> {
  const rows = await withSystemTx((db) =>
    db.execute<{ starts_on: string; ends_on: string }>(
      sql`select starts_on::text, ends_on::text from tenancy.academic_year where id = ${academicYearId} limit 1`,
    ),
  );
  const row = (rows as unknown as Array<{ starts_on: string; ends_on: string }>)[0];
  if (!row) throw new Error(`Academic year ${academicYearId} not found - run @sms/tenancy's seed first.`);
  return { startsOn: row.starts_on as DateOnly, endsOn: row.ends_on as DateOnly };
}

function addDays(date: DateOnly, days: number): DateOnly {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10) as DateOnly;
}

function midpointDate(from: DateOnly, to: DateOnly): DateOnly {
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  return new Date(start + (end - start) / 2).toISOString().slice(0, 10) as DateOnly;
}

async function ensureTerm(tenantId: TenantId, academicYearId: AcademicYearId, name: string, startsOn: DateOnly, endsOn: DateOnly, sequence: number): Promise<string> {
  const existing = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from academic.term where tenant_id = ${tenantId} and academic_year_id = ${academicYearId} and name = ${name} limit 1`));
  const row = (existing as unknown as Array<{ id: string }>)[0];
  if (row) return row.id;
  const created = await terms.createTerm(tenantId, { academicYearId, name, startsOn, endsOn, sequence });
  if (!created.ok) throw created.error;
  console.log(`  create term "${name}"`);
  return created.value.id;
}

async function ensureSection(tenantId: TenantId, courseId: string, termId: string, campusId: CampusId, code: string, name: string): Promise<string> {
  const existing = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from academic.section where tenant_id = ${tenantId} and term_id = ${termId} and code = ${code} limit 1`));
  const row = (existing as unknown as Array<{ id: string }>)[0];
  if (row) return row.id;
  const created = await sections.create(tenantId, { courseId, termId, campusId, code, name, capacity: 25 });
  if (!created.ok) throw created.error;
  console.log(`  create section "${code}"`);
  return created.value.id;
}

/**
 * `validFrom` defaults to today (via `SectionTeacherService.assignTeacher`)
 * when omitted, which is wrong for THIS seed's purposes: scheduling needs
 * the teacher's assignment window to actually overlap the term's meeting
 * dates (2025-09-01 onward), not "whenever this script happens to run" -
 * `assignSubstitute` resolves the absent teacher by querying who is
 * assigned AS OF the substitution date, so an assignment that only starts
 * "today" would leave every date in the term with no assigned teacher to
 * substitute for. Passing the term's own start date is also simply more
 * correct: a teacher assigned to a section should be considered "on the
 * job" from when the section's term begins, not from seed-script run time.
 */
async function ensureTeacherAssignment(tenantId: TenantId, sectionId: string, personId: PersonId, validFrom?: DateOnly): Promise<void> {
  const assigned = await sectionTeachers.assignTeacher(tenantId, { sectionId, personId, role: 'lead', ...(validFrom ? { validFrom } : {}) });
  if (assigned.ok || assigned.error.code === 'CONFLICT') return;
  throw assigned.error;
}

/**
 * `validFrom` is pinned to the term's start, not left to default to "today".
 *
 * A student enrolled as of the day the seed happened to run is not enrolled on
 * any earlier date, so a roster for a past session comes back empty even though
 * attendance history exists for it - the register looks like it lost the class.
 * Seeded students belong to their section for the whole term, which is also
 * what a real roster means.
 */
async function ensureEnrollment(
  tenantId: TenantId,
  sectionId: string,
  personId: PersonId,
  validFrom?: DateOnly,
): Promise<void> {
  const enrolled = await sectionEnrollments.enrolStudent(tenantId, {
    sectionId,
    personId,
    ...(validFrom ? { validFrom } : {}),
  });
  if (enrolled.ok || enrolled.error.code === 'CONFLICT') return;
  throw enrolled.error;
}

async function ensureRoom(tenantId: TenantId, campusId: CampusId, code: string, name: string, capacity: number): Promise<string> {
  const existing = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from academic.room where tenant_id = ${tenantId} and campus_id = ${campusId} and code = ${code} limit 1`));
  const row = (existing as unknown as Array<{ id: string }>)[0];
  if (row) return row.id;
  const created = await rooms.create(tenantId, { campusId, code, name, capacity });
  if (!created.ok) throw created.error;
  console.log(`  create room "${code}"`);
  return created.value.id;
}

async function ensureBellSchedule(tenantId: TenantId, campusId: CampusId, academicYearId: AcademicYearId, name: string): Promise<string> {
  const existing = await withSystemTx((db) =>
    db.execute<{ id: string }>(sql`select id from academic.bell_schedule where tenant_id = ${tenantId} and campus_id = ${campusId} and academic_year_id = ${academicYearId} and name = ${name} limit 1`),
  );
  const row = (existing as unknown as Array<{ id: string }>)[0];
  if (row) return row.id;
  const created = await bellSchedules.createBellSchedule(tenantId, { campusId, academicYearId, name, isDefault: true });
  if (!created.ok) throw created.error;
  console.log(`  create bell schedule "${name}" for campus`);
  return created.value.id;
}

async function ensurePeriod(tenantId: TenantId, bellScheduleId: string, name: string, sequence: number, startsAt: string, endsAt: string): Promise<string> {
  const existing = await withSystemTx((db) =>
    db.execute<{ id: string }>(sql`select id from academic.period where tenant_id = ${tenantId} and bell_schedule_id = ${bellScheduleId} and sequence = ${sequence} limit 1`),
  );
  const row = (existing as unknown as Array<{ id: string }>)[0];
  if (row) return row.id;
  const created = await bellSchedules.createPeriod(tenantId, { bellScheduleId, name, sequence, startsAt, endsAt, isInstructional: true });
  if (!created.ok) throw created.error;
  console.log(`  create period "${name}"`);
  return created.value.id;
}

/** Idempotent: skips if `sectionId` already has any meeting rows (bulk-insert semantics would otherwise conflict with itself on a re-run). */
async function ensureSectionMeetings(
  tenantId: TenantId,
  sectionId: string,
  meetings: Array<{ periodId: string; dayOfWeek: DayOfWeek; roomId: string; validFrom: DateOnly; validTo: DateOnly }>,
): Promise<void> {
  const existing = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from academic.section_meeting where tenant_id = ${tenantId} and section_id = ${sectionId} limit 1`));
  if ((existing as unknown as unknown[]).length > 0) {
    console.log(`  skip   meetings for section (already scheduled)`);
    return;
  }
  const created = await sectionMeetings.setSectionMeetings(tenantId, sectionId, meetings);
  if (!created.ok) throw created.error;
  console.log(`  create ${meetings.length} meeting(s) for section`);
}

async function ensureSubstitution(tenantId: TenantId, sectionMeetingId: string, date: DateOnly, substitutePersonId: PersonId, reason: string): Promise<void> {
  const existing = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from academic.substitution where tenant_id = ${tenantId} and section_meeting_id = ${sectionMeetingId} and date = ${date} limit 1`));
  if ((existing as unknown as unknown[]).length > 0) {
    console.log(`  skip   substitution (already exists)`);
    return;
  }
  const created = await sectionMeetings.assignSubstitute(tenantId, { sectionMeetingId, date, substitutePersonId, reason });
  if (!created.ok) throw created.error;
  console.log(`  create substitution on ${date}`);
}

/** The first calendar date on/after `from` whose ISO day-of-week is `dayOfWeek` (1 = Monday). */
function firstDateOnOrAfter(from: DateOnly, dayOfWeek: DayOfWeek): DateOnly {
  const [year, month, day] = from.split('-').map(Number) as [number, number, number];
  const cursor = new Date(year, month - 1, day);
  for (let i = 0; i < 7; i++) {
    const jsDay = cursor.getDay();
    const iso = jsDay === 0 ? 7 : jsDay;
    if (iso === dayOfWeek) {
      return formatDateOnly(cursor);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  throw new Error(`Could not find a date on/after ${from} for ISO day-of-week ${dayOfWeek}.`);
}

const GRADE_LEVELS = [
  { code: 'G7', name: 'Grade 7', sequence: 7 },
  { code: 'G8', name: 'Grade 8', sequence: 8 },
  { code: 'G9', name: 'Grade 9', sequence: 9 },
  { code: 'G10', name: 'Grade 10', sequence: 10 },
  { code: 'G11', name: 'Grade 11', sequence: 11 },
  { code: 'G12', name: 'Grade 12', sequence: 12 },
] as const;

const DEPARTMENTS = [
  { code: 'MATH', name: 'Mathematics' },
  { code: 'SCI', name: 'Science' },
  { code: 'ENG', name: 'English' },
  { code: 'HUM', name: 'Humanities' },
] as const;

const SUBJECTS = [
  { code: 'ALG', name: 'Algebra', department: 'MATH' },
  { code: 'GEO', name: 'Geometry', department: 'MATH' },
  { code: 'BIO', name: 'Biology', department: 'SCI' },
  { code: 'CHEM', name: 'Chemistry', department: 'SCI' },
  { code: 'ELA', name: 'English Language Arts', department: 'ENG' },
  { code: 'LIT', name: 'Literature', department: 'ENG' },
  { code: 'WHIST', name: 'World History', department: 'HUM' },
  { code: 'CIV', name: 'Civics', department: 'HUM' },
] as const;

const COURSES = [
  { code: 'ALG1', name: 'Algebra I', subject: 'ALG', gradeLevel: 'G7', credits: 1 },
  { code: 'ALG2', name: 'Algebra II', subject: 'ALG', gradeLevel: 'G9', credits: 1 },
  { code: 'GEOM', name: 'Geometry', subject: 'GEO', gradeLevel: 'G9', credits: 1 },
  { code: 'BIO1', name: 'Biology', subject: 'BIO', gradeLevel: 'G8', credits: 1 },
  { code: 'BIO2', name: 'Advanced Biology', subject: 'BIO', gradeLevel: 'G11', credits: 1 },
  { code: 'CHEM1', name: 'Chemistry', subject: 'CHEM', gradeLevel: 'G10', credits: 1 },
  { code: 'ENG7', name: 'English 7', subject: 'ELA', gradeLevel: 'G7', credits: 1 },
  { code: 'LIT11', name: 'Literature', subject: 'LIT', gradeLevel: 'G11', credits: 1 },
  { code: 'WH10', name: 'World History', subject: 'WHIST', gradeLevel: 'G10', credits: 1 },
  { code: 'CIV12', name: 'Civics', subject: 'CIV', gradeLevel: 'G12', credits: 0.5 },
] as const;

// (courseCode, campus, term sequence 1|2)
const SECTIONS = [
  { code: 'ALG1-T1-M', course: 'ALG1', campus: 'main', term: 1, name: 'Algebra I - Section M1' },
  { code: 'BIO1-T1-M', course: 'BIO1', campus: 'main', term: 1, name: 'Biology - Section M1' },
  { code: 'ENG7-T1-M', course: 'ENG7', campus: 'main', term: 1, name: 'English 7 - Section M1' },
  { code: 'WH10-T1-M', course: 'WH10', campus: 'main', term: 1, name: 'World History - Section M1' },
  { code: 'GEOM-T1-M', course: 'GEOM', campus: 'main', term: 1, name: 'Geometry - Section M1' },
  { code: 'LIT11-T1-M', course: 'LIT11', campus: 'main', term: 1, name: 'Literature - Section M1' },
  { code: 'CHEM1-T1-N', course: 'CHEM1', campus: 'north', term: 1, name: 'Chemistry - Section N1' },
  { code: 'CIV12-T1-N', course: 'CIV12', campus: 'north', term: 1, name: 'Civics - Section N1' },
  { code: 'ALG2-T1-N', course: 'ALG2', campus: 'north', term: 1, name: 'Algebra II - Section N1' },
  { code: 'BIO2-T2-M', course: 'BIO2', campus: 'main', term: 2, name: 'Advanced Biology - Section M2' },
  { code: 'GEOM-T2-N', course: 'GEOM', campus: 'north', term: 2, name: 'Geometry - Section N2' },
  { code: 'ALG1-T2-M', course: 'ALG1', campus: 'main', term: 2, name: 'Algebra I - Section M2' },
] as const;

// Every student @sms/people's seed creates (see that module's FAMILIES/
// EMERGENCY_CONTACTS - this list mirrors just the `children` entries).
const STUDENTS: Array<{ givenName: string; familyName: string; dateOfBirth: DateOnly }> = [
  { givenName: 'Emily', familyName: 'Carter', dateOfBirth: '2014-08-01' as DateOnly },
  { givenName: 'Emilie', familyName: 'Carter', dateOfBirth: '2014-08-01' as DateOnly },
  { givenName: 'Anh', familyName: 'Nguyen', dateOfBirth: '2011-02-18' as DateOnly },
  { givenName: 'Minh', familyName: 'Nguyen', dateOfBirth: '2016-09-09' as DateOnly },
  { givenName: 'Chidi', familyName: 'Okafor', dateOfBirth: '2013-04-27' as DateOnly },
  { givenName: 'Sofia', familyName: 'Alvarez', dateOfBirth: '2017-11-03' as DateOnly },
  { givenName: 'Mateo', familyName: 'Alvarez', dateOfBirth: '2019-01-21' as DateOnly },
  { givenName: 'Piotr', familyName: 'Kowalski', dateOfBirth: '2009-05-16' as DateOnly },
  { givenName: 'Layla', familyName: 'Haddad', dateOfBirth: '2012-07-12' as DateOnly },
  { givenName: 'Omar', familyName: 'Haddad', dateOfBirth: '2015-03-24' as DateOnly },
  { givenName: 'Elsa', familyName: 'Larsson', dateOfBirth: '2008-10-30' as DateOnly },
  { givenName: 'Efua', familyName: 'Mensah', dateOfBirth: '2007-01-09' as DateOnly },
  { givenName: 'Ivan', familyName: 'Petrov', dateOfBirth: '2016-06-06' as DateOnly },
  { givenName: 'Sora', familyName: 'Suzuki', dateOfBirth: '2010-12-19' as DateOnly },
  { givenName: 'Ren', familyName: 'Suzuki', dateOfBirth: '2018-04-02' as DateOnly },
  { givenName: 'Hugo', familyName: 'Dubois', dateOfBirth: '2013-09-23' as DateOnly },
];

async function main(): Promise<void> {
  const tenantId = await findGreenwoodTenantId();
  const mainCampusId = await findCampusId(tenantId, 'main');
  const northCampusId = await findCampusId(tenantId, 'north');
  const academicYearId = await findCurrentAcademicYearId(tenantId);

  const gradeLevelIdByCode = new Map<string, string>();
  for (const gl of GRADE_LEVELS) {
    gradeLevelIdByCode.set(gl.code, await ensureGradeLevel(tenantId, gl.code, gl.name, gl.sequence));
  }

  const departmentIdByCode = new Map<string, string>();
  for (const dept of DEPARTMENTS) {
    departmentIdByCode.set(dept.code, await ensureDepartment(tenantId, dept.code, dept.name));
  }

  const subjectIdByCode = new Map<string, string>();
  for (const subj of SUBJECTS) {
    const departmentId = departmentIdByCode.get(subj.department);
    if (!departmentId) throw new Error(`Unknown department "${subj.department}" for subject "${subj.code}".`);
    subjectIdByCode.set(subj.code, await ensureSubject(tenantId, departmentId, subj.code, subj.name));
  }

  const courseIdByCode = new Map<string, string>();
  for (const course of COURSES) {
    const subjectId = subjectIdByCode.get(course.subject);
    const gradeLevelId = gradeLevelIdByCode.get(course.gradeLevel);
    if (!subjectId || !gradeLevelId) throw new Error(`Unknown subject/grade level for course "${course.code}".`);
    courseIdByCode.set(course.code, await ensureCourse(tenantId, subjectId, gradeLevelId, course.code, course.name, course.credits));
  }

  // Terms are derived from the academic year the tenancy seed created, which is
  // itself computed relative to today (see `demoAcademicYears` there). Hardcoded
  // term dates rot the same way: once the clock passes them, no term contains
  // today and every "this week"/"today" screen is empty for reasons unrelated to
  // the code. Splitting the year in half guarantees today lands inside a term.
  const { startsOn: yearStart, endsOn: yearEnd } = await getAcademicYearRange(academicYearId);
  const midpoint = midpointDate(yearStart, yearEnd);
  const term1Range = { startsOn: yearStart, endsOn: midpoint };
  const term2Range = { startsOn: addDays(midpoint, 1), endsOn: yearEnd };
  const term1Id = await ensureTerm(tenantId, academicYearId, 'Term 1', term1Range.startsOn, term1Range.endsOn, 1);
  const term2Id = await ensureTerm(tenantId, academicYearId, 'Term 2', term2Range.startsOn, term2Range.endsOn, 2);
  const termIdBySequence = new Map<number, string>([[1, term1Id], [2, term2Id]]);
  const campusIdByCode = new Map<string, CampusId>([['main', mainCampusId], ['north', northCampusId]]);

  const sectionIdByCode = new Map<string, string>();
  for (const section of SECTIONS) {
    const courseId = courseIdByCode.get(section.course);
    const termId = termIdBySequence.get(section.term);
    const campusId = campusIdByCode.get(section.campus);
    if (!courseId || !termId || !campusId) throw new Error(`Unknown course/term/campus for section "${section.code}".`);
    sectionIdByCode.set(section.code, await ensureSection(tenantId, courseId, termId, campusId, section.code, section.name));
  }

  // Teacher assignments: the two pre-existing @sms/people staff teachers
  // (Priya Nandakumar, Marco Bianchi) each lead a couple of sections;
  // Priya's assignment is also what "teacher@greenwood.test" inherits once
  // linked below - the live demonstration of the section-scope resolver.
  const priyaId = await findPersonByNameAndDob(tenantId, 'Priya', 'Nandakumar', '1988-06-23' as DateOnly);
  const marcoId = await findPersonByNameAndDob(tenantId, 'Marco', 'Bianchi', '1975-01-30' as DateOnly);


  // Teachers are assigned in BOTH terms, deliberately.
  //
  // Assigning them to term 1 only meant that once "today" fell in term 2, the
  // demo teacher had no classes running: their timetable was empty and there
  // was no register to take. A section's meetings are only valid inside their
  // own term, so a teacher who teaches nothing this term genuinely has nothing
  // to mark - the data was wrong, not the code.
  const priyaSections = [
    ['ALG1-T1-M', term1Range.startsOn],
    ['ENG7-T1-M', term1Range.startsOn],
    ['GEOM-T1-M', term1Range.startsOn],
    ['ALG1-T2-M', term2Range.startsOn],
    ['GEOM-T2-N', term2Range.startsOn],
  ] as const;
  for (const [code, from] of priyaSections) {
    const sectionId = sectionIdByCode.get(code);
    if (sectionId) await ensureTeacherAssignment(tenantId, sectionId, priyaId, from);
  }
  const marcoSections = [
    ['BIO1-T1-M', term1Range.startsOn],
    ['CHEM1-T1-N', term1Range.startsOn],
    ['WH10-T1-M', term1Range.startsOn],
    ['BIO2-T2-M', term2Range.startsOn],
  ] as const;
  for (const [code, from] of marcoSections) {
    const sectionId = sectionIdByCode.get(code);
    if (sectionId) await ensureTeacherAssignment(tenantId, sectionId, marcoId, from);
  }

  // teacher@greenwood.test: a NEW login, linked to Priya Nandakumar's
  // EXISTING person record (already teaching ALG1-T1-M/ENG7-T1-M/GEOM-T1-M
  // above), with the "teacher" role assigned.
  const teacherUserId = await ensureTeacherUser(tenantId);
  await linkTeacherPerson(tenantId, teacherUserId, priyaId);
  await ensureTeacherRoleAssignment(tenantId, teacherUserId);

  // Enrol every seeded student ONCE PER TERM, round-robin within that term's
  // own sections - see this file's own header comment for why grade-level
  // accuracy is not the point here.
  //
  // A single round-robin across all 12 sections at once looked fine but rotted
  // with the calendar: 9 of the 12 sections belong to Term 1, whose meetings
  // stop at that term's end, so once "today" moved into Term 2 only 3 of 16
  // students still had a section that meets. Everyone else was "currently
  // enrolled" with an empty timetable - a student with no classes, which reads
  // as a broken timetable rather than as seed drift, and leaves the parent and
  // student portals showing nothing at all.
  //
  // Enrolling in one section per term is also simply what a real student
  // record looks like, and it guarantees a live timetable whichever term the
  // seed happens to be run in.
  const sectionsByTerm = new Map<number, string[]>();
  for (const section of SECTIONS) {
    const codes = sectionsByTerm.get(section.term) ?? [];
    codes.push(section.code);
    sectionsByTerm.set(section.term, codes);
  }

  for (const [index, student] of STUDENTS.entries()) {
    const personId = await findPersonByNameAndDob(tenantId, student.givenName, student.familyName, student.dateOfBirth);
    for (const [term, codes] of sectionsByTerm) {
      const sectionCode = codes[index % codes.length]!;
      const sectionId = sectionIdByCode.get(sectionCode)!;
      // From the start of the section's own term - see ensureEnrollment's comment.
      const enrolFrom = term === 2 ? term2Range.startsOn : term1Range.startsOn;
      await ensureEnrollment(tenantId, sectionId, personId, enrolFrom);
    }
  }

  // -------------------------------------------------------------------------
  // Scheduling: a 6-period bell schedule per campus, meetings for all 12
  // sections across the week, one substitution.
  //
  // Each section is given a period UNIQUE within its (term, campus) group
  // (there are at most 6 sections per group - see SECTIONS below), so no two
  // sections ever share (period, room, day) - the seed itself proves out
  // without tripping the exclusion constraint/trigger it's demonstrating.
  // Sections in DIFFERENT terms may reuse the same period/room, which is
  // safe: their meetings' valid_from/valid_to are the term's own dates, and
  // term 1 (ends 2026-01-30) and term 2 (starts 2026-02-02) never overlap.
  // -------------------------------------------------------------------------
  // Derived from the terms created above, which are themselves cut from the
  // academic year the tenancy seed computes relative to today. Hardcoding these
  // put every meeting in a window that no longer contained today once the clock
  // moved past it - the marking screen and this week's timetable then render
  // empty for reasons that have nothing to do with the code.
  const termDatesBySequence = new Map<number, { startsOn: DateOnly; endsOn: DateOnly }>([
    [1, { startsOn: term1Range.startsOn, endsOn: term1Range.endsOn }],
    [2, { startsOn: term2Range.startsOn, endsOn: term2Range.endsOn }],
  ]);

  const mainRoomIds = [
    await ensureRoom(tenantId, mainCampusId, 'M-101', 'Main Room 101', 30),
    await ensureRoom(tenantId, mainCampusId, 'M-102', 'Main Room 102', 30),
    await ensureRoom(tenantId, mainCampusId, 'M-103', 'Main Room 103', 25),
  ];
  const northRoomIds = [
    await ensureRoom(tenantId, northCampusId, 'N-201', 'North Room 201', 28),
    await ensureRoom(tenantId, northCampusId, 'N-202', 'North Room 202', 28),
  ];
  const roomIdsByCampus = new Map<string, string[]>([
    ['main', mainRoomIds],
    ['north', northRoomIds],
  ]);

  const PERIOD_TIMES: Array<{ name: string; startsAt: string; endsAt: string }> = [
    { name: 'Period 1', startsAt: '08:00:00', endsAt: '08:50:00' },
    { name: 'Period 2', startsAt: '09:00:00', endsAt: '09:50:00' },
    { name: 'Period 3', startsAt: '10:00:00', endsAt: '10:50:00' },
    { name: 'Period 4', startsAt: '11:00:00', endsAt: '11:50:00' },
    { name: 'Period 5', startsAt: '13:00:00', endsAt: '13:50:00' },
    { name: 'Period 6', startsAt: '14:00:00', endsAt: '14:50:00' },
  ];

  const bellScheduleIdByCampus = new Map<string, string>();
  const periodIdsByCampus = new Map<string, string[]>();
  for (const [campusCode, campusId] of campusIdByCode) {
    const bellScheduleId = await ensureBellSchedule(tenantId, campusId, academicYearId, `${campusCode === 'main' ? 'Main' : 'North'} Campus - Standard Week`);
    bellScheduleIdByCampus.set(campusCode, bellScheduleId);
    const periodIds: string[] = [];
    for (const [index, period] of PERIOD_TIMES.entries()) {
      periodIds.push(await ensurePeriod(tenantId, bellScheduleId, period.name, index + 1, period.startsAt, period.endsAt));
    }
    periodIdsByCampus.set(campusCode, periodIds);
  }

  // Group sections by (term, campus) so each gets a period unique within its group.
  const groupIndexByCode = new Map<string, number>();
  const groupCounters = new Map<string, number>();
  for (const section of SECTIONS) {
    const groupKey = `${section.term}:${section.campus}`;
    const nextIndex = groupCounters.get(groupKey) ?? 0;
    groupIndexByCode.set(section.code, nextIndex);
    groupCounters.set(groupKey, nextIndex + 1);
  }

  const meetingIdBySectionCode = new Map<string, string[]>();
  for (const section of SECTIONS) {
    const sectionId = sectionIdByCode.get(section.code);
    const termDates = termDatesBySequence.get(section.term);
    const periodIds = periodIdsByCampus.get(section.campus);
    const roomIds = roomIdsByCampus.get(section.campus);
    if (!sectionId || !termDates || !periodIds || !roomIds) {
      throw new Error(`Missing scheduling prerequisites for section "${section.code}".`);
    }
    const groupIndex = groupIndexByCode.get(section.code)!;
    const periodId = periodIds[groupIndex % periodIds.length]!;
    const roomId = roomIds[groupIndex % roomIds.length]!;

    await ensureSectionMeetings(tenantId, sectionId, [
      { periodId, dayOfWeek: 1 as DayOfWeek, roomId, validFrom: termDates.startsOn, validTo: termDates.endsOn },
      { periodId, dayOfWeek: 3 as DayOfWeek, roomId, validFrom: termDates.startsOn, validTo: termDates.endsOn },
      { periodId, dayOfWeek: 5 as DayOfWeek, roomId, validFrom: termDates.startsOn, validTo: termDates.endsOn },
    ]);

    const meetingRows = await withSystemTx((db) =>
      db.execute<{ id: string }>(sql`select id from academic.section_meeting where tenant_id = ${tenantId} and section_id = ${sectionId} order by day_of_week`),
    );
    meetingIdBySectionCode.set(section.code, (meetingRows as unknown as Array<{ id: string }>).map((row) => row.id));
  }

  // One substitution: Priya is absent from ALG1-T1-M's Monday meeting; Marco covers.
  const alg1MondayMeetingId = meetingIdBySectionCode.get('ALG1-T1-M')?.[0];
  if (alg1MondayMeetingId) {
    // Derived from the term, not a fixed calendar date: a hardcoded one falls
    // outside the (relative) term window as soon as the clock moves, and the
    // teacher it needs is not assigned then, so the seed itself fails.
    const substitutionDate = firstDateOnOrAfter(term1Range.startsOn, 1 as DayOfWeek);
    await ensureSubstitution(tenantId, alg1MondayMeetingId, substitutionDate, marcoId, 'Priya Nandakumar is attending a conference.');
  }

  console.log('seed complete');
  console.log('');
  console.log('  Seeded teacher credentials:');
  console.log(`    email:    ${TEACHER_EMAIL}`);
  console.log(`    password: ${TEACHER_PASSWORD}`);
  console.log('    tenant:   greenwood');
  console.log('    teaches:  ALG1-T1-M, ENG7-T1-M, GEOM-T1-M (as Priya Nandakumar)');
}

main()
  .catch((error: unknown) => {
    console.error('seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSqlClients();
  });
