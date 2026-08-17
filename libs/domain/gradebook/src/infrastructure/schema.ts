import { boolean, date, integer, jsonb, numeric, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of `libs/domain/gradebook/migrations/1000_gradebook.sql`.
 * Same convention as `@sms/attendance`'s `infrastructure/schema.ts`: a
 * read/write model for the application layer, not the source of truth - the
 * SQL migration is. Keep the two in sync by hand.
 */
export const gradebookSchema = pgSchema('gradebook');

export const gradeScaleTable = gradebookSchema.table(
  'grade_scale',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('grade_scale_tenant_id_name_key').on(table.tenantId, table.name)],
);

export const gradeScaleVersionTable = gradebookSchema.table(
  'grade_scale_version',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    gradeScaleId: uuid('grade_scale_id').notNull(),
    version: integer('version').notNull(),
    bands: jsonb('bands').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('grade_scale_version_scale_id_version_key').on(table.gradeScaleId, table.version)],
);

export const calculationRuleSetTable = gradebookSchema.table(
  'calculation_rule_set',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('calculation_rule_set_tenant_id_name_key').on(table.tenantId, table.name)],
);

export const calculationRuleSetVersionTable = gradebookSchema.table(
  'calculation_rule_set_version',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    calculationRuleSetId: uuid('calculation_rule_set_id').notNull(),
    version: integer('version').notNull(),
    rules: jsonb('rules').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('calc_rule_set_version_set_id_version_key').on(table.calculationRuleSetId, table.version)],
);

export const categoryTable = gradebookSchema.table(
  'category',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    sectionId: uuid('section_id').notNull(),
    name: text('name').notNull(),
    weight: numeric('weight', { mode: 'number' }).notNull().default(0),
    dropLowest: integer('drop_lowest').notNull().default(0),
    sequence: integer('sequence').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('category_tenant_section_name_key').on(table.tenantId, table.sectionId, table.name)],
);

export const assignmentTable = gradebookSchema.table('assignment', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  sectionId: uuid('section_id').notNull(),
  categoryId: uuid('category_id').notNull(),
  gradingPeriodId: uuid('grading_period_id').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  pointsPossible: numeric('points_possible', { mode: 'number' }).notNull(),
  dueOn: date('due_on'),
  published: boolean('published').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const scoreTable = gradebookSchema.table(
  'score',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    assignmentId: uuid('assignment_id').notNull(),
    personId: uuid('person_id').notNull(),
    points: numeric('points', { mode: 'number' }),
    status: text('status').notNull().default('graded'),
    gradeScaleVersionId: uuid('grade_scale_version_id'),
    comment: text('comment'),
    gradedByUserId: uuid('graded_by_user_id'),
    gradedAt: timestamp('graded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('score_assignment_id_person_id_key').on(table.assignmentId, table.personId)],
);

export const submissionTable = gradebookSchema.table(
  'submission',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    assignmentId: uuid('assignment_id').notNull(),
    submittedByUserId: uuid('submitted_by_user_id'),
    scoreCount: integer('score_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('gb_submission_tenant_id_idempotency_key_key').on(table.tenantId, table.idempotencyKey)],
);

export const gradingPeriodLockTable = gradebookSchema.table(
  'grading_period_lock',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    gradingPeriodId: uuid('grading_period_id').notNull(),
    locked: boolean('locked').notNull().default(false),
    lockedByUserId: uuid('locked_by_user_id'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    unlockedByUserId: uuid('unlocked_by_user_id'),
    unlockedAt: timestamp('unlocked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('grading_period_lock_tenant_id_grading_period_id_key').on(table.tenantId, table.gradingPeriodId)],
);

export const correctionTable = gradebookSchema.table('correction', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  scoreId: uuid('score_id').notNull(),
  fromPoints: numeric('from_points', { mode: 'number' }),
  toPoints: numeric('to_points', { mode: 'number' }),
  fromStatus: text('from_status').notNull(),
  toStatus: text('to_status').notNull(),
  reason: text('reason'),
  requestedByUserId: uuid('requested_by_user_id'),
  status: text('status').notNull().default('pending'),
  decidedByUserId: uuid('decided_by_user_id'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const learningOutcomeTable = gradebookSchema.table(
  'learning_outcome',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    subjectId: uuid('subject_id'),
    code: text('code').notNull(),
    description: text('description').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('learning_outcome_tenant_id_code_key').on(table.tenantId, table.code)],
);

export const outcomeResultTable = gradebookSchema.table('outcome_result', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  sectionId: uuid('section_id').notNull(),
  personId: uuid('person_id').notNull(),
  outcomeId: uuid('outcome_id').notNull(),
  assignmentId: uuid('assignment_id'),
  proficiencyLevel: text('proficiency_level').notNull(),
  comment: text('comment'),
  scoredByUserId: uuid('scored_by_user_id'),
  scoredAt: timestamp('scored_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
