import { boolean, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of `libs/domain/communications/migrations/1350_communications.sql`.
 * Same convention as `@sms/attendance`'s `infrastructure/schema.ts`: a
 * read/write model for the application layer, not the source of truth - the
 * SQL migration is. Keep the two in sync by hand.
 */
export const communicationsSchema = pgSchema('communications');

export const announcementTable = communicationsSchema.table('announcement', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  category: text('category').notNull(),
  audience: jsonb('audience').notNull(),
  campusId: uuid('campus_id'),
  status: text('status').notNull().default('draft'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  publishedByUserId: uuid('published_by_user_id'),
  supersededByAnnouncementId: uuid('superseded_by_announcement_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const announcementRecipientTable = communicationsSchema.table(
  'announcement_recipient',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    announcementId: uuid('announcement_id').notNull(),
    personId: uuid('person_id').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('announcement_recipient_announcement_id_person_id_key').on(table.announcementId, table.personId)],
);

export const threadTable = communicationsSchema.table('thread', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  subject: text('subject').notNull(),
  subjectType: text('subject_type').notNull(),
  subjectId: uuid('subject_id').notNull(),
  status: text('status').notNull().default('open'),
  createdByUserId: uuid('created_by_user_id'),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const threadParticipantTable = communicationsSchema.table(
  'thread_participant',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    threadId: uuid('thread_id').notNull(),
    personId: uuid('person_id').notNull(),
    role: text('role').notNull().default('participant'),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }),
    muted: boolean('muted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('thread_participant_thread_id_person_id_key').on(table.threadId, table.personId)],
);

export const messageTable = communicationsSchema.table(
  'message',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    threadId: uuid('thread_id').notNull(),
    authorPersonId: uuid('author_person_id').notNull(),
    body: text('body').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('message_tenant_id_thread_id_idempotency_key_key').on(table.tenantId, table.threadId, table.idempotencyKey)],
);
