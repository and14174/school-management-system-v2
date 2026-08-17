import { sql } from 'drizzle-orm';
import { index, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Typed view of `migrations/0100_audit.sql`. The SQL is the source of
 * truth - this file exists so application code gets typed query building,
 * not to define the schema. Keep it in lockstep with the migration by
 * hand; nothing here is ever pushed to the database via drizzle-kit
 * (`db:migrate` runs the raw `.sql` files - see `@sms/db`'s `migrate.ts`).
 */
export const auditSchema = pgSchema('audit');

/**
 * `audit.record_history` - append-only before/after images, written only by
 * the `audit.record_history()` SECURITY DEFINER trigger. Partitioned by
 * `occurred_at`, so the primary key must include it (Postgres requires the
 * partition key to be part of every unique/primary key on a partitioned
 * table).
 */
export const recordHistory = auditSchema.table(
  'record_history',
  {
    // Defaults to uuidv7() in the database (see the migration) - the
    // `.default(sql\`uuidv7()\`)` here only tells drizzle's insert type that
    // `id` is optional, it does not itself apply the default.
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),
    tableSchema: text('table_schema').notNull(),
    tableName: text('table_name').notNull(),
    recordId: text('record_id').notNull(),
    operation: text('operation').notNull(),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    changedByUserId: uuid('changed_by_user_id'),
    tenantId: uuid('tenant_id'),
    requestId: text('request_id'),
    bulkOperationId: uuid('bulk_operation_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.occurredAt] }),
    index('record_history_record_idx').on(table.tableSchema, table.tableName, table.recordId, table.occurredAt),
    index('record_history_tenant_idx').on(table.tenantId, table.occurredAt),
    index('record_history_bulk_idx').on(table.bulkOperationId),
  ],
);

/** `audit.access_log` - who read restricted data about whom. Written by the API, not a trigger. */
export const accessLog = auditSchema.table(
  'access_log',
  {
    id: uuid('id')
      .primaryKey()
      .notNull()
      .default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    actorId: uuid('actor_id'),
    personId: uuid('person_id'),
    resource: text('resource').notNull(),
    fieldNames: text('field_names').array().notNull(),
    reason: text('reason'),
    requestId: text('request_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('access_log_tenant_idx').on(table.tenantId, table.occurredAt),
    index('access_log_person_idx').on(table.personId, table.occurredAt),
  ],
);

/** `audit.bulk_operation` - groups row changes so an import or bulk edit can be reversed as a unit. */
export const bulkOperation = auditSchema.table(
  'bulk_operation',
  {
    id: uuid('id')
      .primaryKey()
      .notNull()
      .default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    kind: text('kind').notNull(),
    actorId: uuid('actor_id'),
    status: text('status').notNull().default('running'),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    revertedByOperationId: uuid('reverted_by_operation_id'),
  },
  (table) => [index('bulk_operation_tenant_idx').on(table.tenantId, table.startedAt)],
);
