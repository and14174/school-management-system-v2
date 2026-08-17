import { date, numeric, pgSchema, text, uuid } from 'drizzle-orm/pg-core';

/**
 * Read-only, PARTIAL drizzle mirrors of tables owned by other modules
 * (`academic.grading_period`/`term`/`section`/`course`, `tenancy.academic_year`,
 * `enrollment.enrollment`) - only the columns `application/academic-lookup.ts`
 * actually reads. This module never writes through these refs.
 *
 * Modules share one Postgres database; RLS (never the TypeScript module
 * graph) is what enforces the tenant boundary on a cross-schema read, same
 * reasoning as `@sms/gradebook`'s `ScoreService` and `@sms/attendance`'s
 * `AttendanceRecordService` querying `academic.section_enrollment`/
 * `academic.section_meeting` directly - they use a raw `sql` tag where this
 * module uses drizzle's typed query builder instead (so `inArray` etc. are
 * available for cross-schema reads exactly like they are for this module's
 * own tables), for the exact same "read someone else's schema" purpose.
 */

const academicSchema = pgSchema('academic');

export const gradingPeriodRef = academicSchema.table('grading_period', {
  id: uuid('id'),
  tenantId: uuid('tenant_id'),
  termId: uuid('term_id'),
  name: text('name'),
  startsOn: date('starts_on'),
  endsOn: date('ends_on'),
});

export const termRef = academicSchema.table('term', {
  id: uuid('id'),
  tenantId: uuid('tenant_id'),
  academicYearId: uuid('academic_year_id'),
  name: text('name'),
});

export const sectionRef = academicSchema.table('section', {
  id: uuid('id'),
  tenantId: uuid('tenant_id'),
  courseId: uuid('course_id'),
  termId: uuid('term_id'),
});

export const courseRef = academicSchema.table('course', {
  id: uuid('id'),
  tenantId: uuid('tenant_id'),
  code: text('code'),
  name: text('name'),
  credits: numeric('credits', { mode: 'number' }),
});

export const sectionEnrollmentRef = academicSchema.table('section_enrollment', {
  tenantId: uuid('tenant_id'),
  sectionId: uuid('section_id'),
  personId: uuid('person_id'),
  validFrom: date('valid_from'),
  validTo: date('valid_to'),
});

const gradebookSchema = pgSchema('gradebook');

export const assignmentRef = gradebookSchema.table('assignment', {
  id: uuid('id'),
  tenantId: uuid('tenant_id'),
  sectionId: uuid('section_id'),
  gradingPeriodId: uuid('grading_period_id'),
});

const tenancySchema = pgSchema('tenancy');

export const academicYearRef = tenancySchema.table('academic_year', {
  id: uuid('id'),
  tenantId: uuid('tenant_id'),
  name: text('name'),
});

const enrollmentSchema = pgSchema('enrollment');

export const enrollmentRef = enrollmentSchema.table('enrollment', {
  id: uuid('id'),
  tenantId: uuid('tenant_id'),
  personId: uuid('person_id'),
  academicYearId: uuid('academic_year_id'),
  gradeLevelId: uuid('grade_level_id'),
});
