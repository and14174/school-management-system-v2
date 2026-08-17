import { index, jsonb, pgSchema, text, timestamp, uuid, integer } from 'drizzle-orm/pg-core';

const outbox = pgSchema('outbox');

/** Typed view of `outbox.message`. The SQL migration is the source of truth. */
export const outboxMessage = outbox.table(
  'message',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    topic: text('topic').notNull(),
    payload: jsonb('payload').notNull(),
    requestId: text('request_id'),
    actorUserId: uuid('actor_user_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    lastError: text('last_error'),
  },
  (table) => [index('message_tenant_topic_idx').on(table.tenantId, table.topic)],
);
