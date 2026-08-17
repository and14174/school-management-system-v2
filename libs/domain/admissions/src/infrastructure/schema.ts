import { date, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of `libs/domain/admissions/migrations/1500_admissions.sql`.
 * Same convention as `@sms/enrollment`'s `infrastructure/schema.ts`: a
 * read/write model for the application layer, not the source of truth - the
 * SQL migration is. Keep the two in sync by hand.
 */
export const admissionsSchema = pgSchema('admissions');

export const applicationTable = admissionsSchema.table('application', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  personId: uuid('person_id'),
  applicantGivenName: text('applicant_given_name').notNull(),
  applicantFamilyName: text('applicant_family_name').notNull(),
  applicantDateOfBirth: date('applicant_date_of_birth'),
  applicantGender: text('applicant_gender'),
  guardianName: text('guardian_name'),
  guardianEmail: text('guardian_email'),
  guardianPhone: text('guardian_phone'),
  desiredAcademicYearId: uuid('desired_academic_year_id').notNull(),
  desiredCampusId: uuid('desired_campus_id').notNull(),
  desiredGradeLevelId: uuid('desired_grade_level_id').notNull(),
  source: text('source'),
  currentStage: text('current_stage').notNull().default('enquiry'),
  convertedAt: timestamp('converted_at', { withTimezone: true }),
  convertedEnrollmentId: uuid('converted_enrollment_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const applicationStageHistoryTable = admissionsSchema.table('application_stage_history', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  applicationId: uuid('application_id').notNull(),
  fromStage: text('from_stage'),
  toStage: text('to_stage').notNull(),
  note: text('note'),
  actorUserId: uuid('actor_user_id'),
  occurredOn: date('occurred_on').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const applicationDecisionTable = admissionsSchema.table('application_decision', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  applicationId: uuid('application_id').notNull(),
  fromStage: text('from_stage').notNull(),
  outcome: text('outcome').notNull(),
  reason: text('reason'),
  decidedByUserId: uuid('decided_by_user_id'),
  decidedOn: date('decided_on').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
