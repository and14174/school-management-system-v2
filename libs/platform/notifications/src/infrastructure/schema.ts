import { boolean, index, integer, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const notifications = pgSchema('notifications');

/** Typed view of `notifications.template`. The SQL migration is the source of truth. */
export const template = notifications.table('template', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  key: text('key').notNull(),
  channel: text('channel').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

/** Typed view of `notifications.template_version`. Immutable at the DB level - see the migration's triggers. */
export const templateVersion = notifications.table(
  'template_version',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    templateId: uuid('template_id').notNull(),
    version: integer('version').notNull(),
    locale: text('locale').notNull(),
    subjectTemplate: text('subject_template').notNull(),
    bodyTemplate: text('body_template').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    createdByUserId: uuid('created_by_user_id'),
  },
  (t) => [index('notification_template_version_template_idx').on(t.templateId, t.version)],
);

/** Typed view of `notifications.preference`. */
export const preference = notifications.table(
  'preference',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    personId: uuid('person_id').notNull(),
    channel: text('channel').notNull(),
    category: text('category').notNull(),
    optedIn: boolean('opted_in').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('preference_tenant_person_idx').on(t.tenantId, t.personId)],
);

/** Typed view of `notifications.notification`. Insert-only - see the migration header. */
export const notification = notifications.table(
  'notification',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    templateVersionId: uuid('template_version_id').notNull(),
    category: text('category').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    payload: jsonb('payload').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('notification_tenant_subject_idx').on(t.tenantId, t.subjectType, t.subjectId, t.createdAt)],
);

/** Typed view of `notifications.delivery`. One row per recipient per channel. */
export const delivery = notifications.table(
  'delivery',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    notificationId: uuid('notification_id').notNull(),
    personId: uuid('person_id').notNull(),
    channel: text('channel').notNull(),
    address: text('address'),
    status: text('status').notNull(),
    suppressedReason: text('suppressed_reason'),
    providerMessageId: text('provider_message_id'),
    attempts: integer('attempts').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('delivery_tenant_notification_idx').on(t.tenantId, t.notificationId),
    index('delivery_tenant_person_idx').on(t.tenantId, t.personId),
  ],
);
