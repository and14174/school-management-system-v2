import { boolean, date, integer, numeric, pgSchema, smallint, text, time, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of `libs/domain/academic/migrations/0600_academic.sql`. Same
 * convention as `@sms/people`'s `infrastructure/schema.ts`: a read/write
 * model for the application layer, not the source of truth - the SQL
 * migration is. Keep the two in sync by hand.
 */
export const academicSchema = pgSchema('academic');

export const termTable = academicSchema.table(
  'term',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    name: text('name').notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    sequence: integer('sequence').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('term_tenant_id_academic_year_id_name_key').on(table.tenantId, table.academicYearId, table.name)],
);

export const gradingPeriodTable = academicSchema.table('grading_period', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  termId: uuid('term_id').notNull(),
  name: text('name').notNull(),
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on').notNull(),
  sequence: integer('sequence').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const gradeLevelTable = academicSchema.table('grade_level', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  sequence: integer('sequence').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const departmentTable = academicSchema.table('department', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const subjectTable = academicSchema.table('subject', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  departmentId: uuid('department_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const courseTable = academicSchema.table('course', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  subjectId: uuid('subject_id').notNull(),
  gradeLevelId: uuid('grade_level_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  credits: numeric('credits'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const roomTable = academicSchema.table('room', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  campusId: uuid('campus_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  capacity: integer('capacity'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sectionTable = academicSchema.table('section', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  courseId: uuid('course_id').notNull(),
  termId: uuid('term_id').notNull(),
  campusId: uuid('campus_id').notNull(),
  roomId: uuid('room_id'),
  code: text('code').notNull(),
  name: text('name').notNull(),
  capacity: integer('capacity'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sectionTeacherTable = academicSchema.table('section_teacher', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  sectionId: uuid('section_id').notNull(),
  personId: uuid('person_id').notNull(),
  role: text('role').notNull(),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sectionEnrollmentTable = academicSchema.table('section_enrollment', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  sectionId: uuid('section_id').notNull(),
  personId: uuid('person_id').notNull(),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to'),
  status: text('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// -----------------------------------------------------------------------------
// Scheduling / timetabling - mirrors `libs/domain/academic/migrations/0610_scheduling.sql`.
// -----------------------------------------------------------------------------

export const bellScheduleTable = academicSchema.table('bell_schedule', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  campusId: uuid('campus_id').notNull(),
  academicYearId: uuid('academic_year_id').notNull(),
  name: text('name').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const periodTable = academicSchema.table('period', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  bellScheduleId: uuid('bell_schedule_id').notNull(),
  name: text('name').notNull(),
  sequence: integer('sequence').notNull().default(0),
  startsAt: time('starts_at').notNull(),
  endsAt: time('ends_at').notNull(),
  isInstructional: boolean('is_instructional').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sectionMeetingTable = academicSchema.table('section_meeting', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  sectionId: uuid('section_id').notNull(),
  periodId: uuid('period_id').notNull(),
  dayOfWeek: smallint('day_of_week').notNull(),
  roomId: uuid('room_id'),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const substitutionTable = academicSchema.table('substitution', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  sectionMeetingId: uuid('section_meeting_id').notNull(),
  date: date('date').notNull(),
  absentPersonId: uuid('absent_person_id').notNull(),
  substitutePersonId: uuid('substitute_person_id').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
