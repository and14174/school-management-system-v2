import { boolean, date, integer, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of `libs/domain/attendance/migrations/0900_attendance.sql`.
 * Same convention as `@sms/enrollment`'s `infrastructure/schema.ts`: a
 * read/write model for the application layer, not the source of truth - the
 * SQL migration is. Keep the two in sync by hand.
 */
export const attendanceSchema = pgSchema('attendance');

export const codeTable = attendanceSchema.table(
  'code',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    code: text('code').notNull(),
    label: text('label').notNull(),
    category: text('category').notNull(),
    countsAsPresent: boolean('counts_as_present').notNull().default(false),
    isDefault: boolean('is_default').notNull().default(false),
    requiresReason: boolean('requires_reason').notNull().default(false),
    sequence: integer('sequence').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('code_tenant_id_code_key').on(table.tenantId, table.code)],
);

export const recordTable = attendanceSchema.table('record', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  personId: uuid('person_id').notNull(),
  sectionId: uuid('section_id'),
  sectionMeetingId: uuid('section_meeting_id'),
  date: date('date').notNull(),
  codeId: uuid('code_id').notNull(),
  minutesLate: integer('minutes_late'),
  note: text('note'),
  markedByUserId: uuid('marked_by_user_id'),
  markedAt: timestamp('marked_at', { withTimezone: true }).notNull().defaultNow(),
});

export const correctionTable = attendanceSchema.table('correction', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  recordId: uuid('record_id').notNull(),
  fromCodeId: uuid('from_code_id').notNull(),
  toCodeId: uuid('to_code_id').notNull(),
  reason: text('reason'),
  requestedByUserId: uuid('requested_by_user_id'),
  status: text('status').notNull().default('pending'),
  decidedByUserId: uuid('decided_by_user_id'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const submissionTable = attendanceSchema.table(
  'submission',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    sectionMeetingId: uuid('section_meeting_id').notNull(),
    date: date('date').notNull(),
    submittedByUserId: uuid('submitted_by_user_id'),
    recordCount: integer('record_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('submission_tenant_id_idempotency_key_key').on(table.tenantId, table.idempotencyKey)],
);
