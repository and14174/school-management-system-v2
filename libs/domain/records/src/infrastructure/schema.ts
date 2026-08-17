import { boolean, date, integer, jsonb, numeric, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of `libs/domain/records/migrations/1200_records.sql`. Same
 * convention as `@sms/gradebook`'s `infrastructure/schema.ts`: a read/write
 * model for the application layer, not the source of truth - the SQL
 * migration is. Keep the two in sync by hand.
 */
export const recordsSchema = pgSchema('records');

export const reportCardRunTable = recordsSchema.table(
  'report_card_run',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    gradingPeriodId: uuid('grading_period_id').notNull(),
    sectionId: uuid('section_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull().default('draft'),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    issuedByUserId: uuid('issued_by_user_id'),
    documentCount: integer('document_count').notNull().default(0),
    bulkOperationId: uuid('bulk_operation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('report_card_run_tenant_id_idempotency_key_key').on(table.tenantId, table.idempotencyKey)],
);

export const reportCardTable = recordsSchema.table(
  'report_card',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    reportCardRunId: uuid('report_card_run_id').notNull(),
    personId: uuid('person_id').notNull(),
    enrollmentId: uuid('enrollment_id'),
    documentId: uuid('document_id').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    gpa: numeric('gpa', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('report_card_tenant_id_run_id_person_id_key').on(table.tenantId, table.reportCardRunId, table.personId)],
);

export const transcriptEntryTable = recordsSchema.table(
  'transcript_entry',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    personId: uuid('person_id').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    termId: uuid('term_id').notNull(),
    courseId: uuid('course_id').notNull(),
    sectionId: uuid('section_id').notNull(),
    courseCode: text('course_code').notNull(),
    courseName: text('course_name').notNull(),
    creditsAttempted: numeric('credits_attempted', { mode: 'number' }).notNull().default(0),
    creditsEarned: numeric('credits_earned', { mode: 'number' }).notNull().default(0),
    percentage: numeric('percentage', { mode: 'number' }),
    letter: text('letter'),
    gpaPoints: numeric('gpa_points', { mode: 'number' }),
    gradeScaleVersionId: uuid('grade_scale_version_id'),
    finalisedAt: timestamp('finalised_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('transcript_entry_tenant_id_person_id_section_id_key').on(table.tenantId, table.personId, table.sectionId)],
);

export const creditRuleSetTable = recordsSchema.table(
  'credit_rule_set',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('credit_rule_set_tenant_id_name_key').on(table.tenantId, table.name)],
);

export const creditRuleSetVersionTable = recordsSchema.table(
  'credit_rule_set_version',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    creditRuleSetId: uuid('credit_rule_set_id').notNull(),
    version: integer('version').notNull(),
    rules: jsonb('rules').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('credit_rule_set_version_set_id_version_key').on(table.creditRuleSetId, table.version)],
);
