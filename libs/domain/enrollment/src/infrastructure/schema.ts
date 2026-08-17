import { date, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of `libs/domain/enrollment/migrations/0700_enrollment.sql`.
 * Same convention as `@sms/academic`'s `infrastructure/schema.ts`: a
 * read/write model for the application layer, not the source of truth - the
 * SQL migration is. Keep the two in sync by hand.
 */
export const enrollmentSchema = pgSchema('enrollment');

export const enrollmentTable = enrollmentSchema.table(
  'enrollment',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    personId: uuid('person_id').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    campusId: uuid('campus_id').notNull(),
    gradeLevelId: uuid('grade_level_id').notNull(),
    studentNumber: text('student_number'),
    status: text('status').notNull(),
    enrolledOn: date('enrolled_on').notNull(),
    exitedOn: date('exited_on'),
    exitReason: text('exit_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('enrollment_tenant_person_academic_year_key').on(table.tenantId, table.personId, table.academicYearId)],
);

export const statusEventTable = enrollmentSchema.table('status_event', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  enrollmentId: uuid('enrollment_id').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  effectiveOn: date('effective_on').notNull(),
  reason: text('reason'),
  actorUserId: uuid('actor_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rolloverRunTable = enrollmentSchema.table('rollover_run', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  fromAcademicYearId: uuid('from_academic_year_id').notNull(),
  toAcademicYearId: uuid('to_academic_year_id').notNull(),
  bulkOperationId: uuid('bulk_operation_id'),
  status: text('status').notNull().default('running'),
  counts: jsonb('counts').notNull().default({}),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
