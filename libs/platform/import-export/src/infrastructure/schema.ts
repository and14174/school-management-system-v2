import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Typed view of `migrations/0800_import_export.sql`. The SQL is the source
 * of truth - this file exists so application code gets typed query
 * building, not to define the schema. Keep it in lockstep with the
 * migration by hand; nothing here is ever pushed to the database via
 * drizzle-kit (`db:migrate` runs the raw `.sql` files - see `@sms/db`'s
 * `migrate.ts`). Same convention as `@sms/audit`'s `infrastructure/schema.ts`.
 */
export const importExportSchema = pgSchema('import_export');

export const importJob = importExportSchema.table(
  'import_job',
  {
    id: uuid('id')
      .primaryKey()
      .notNull()
      .default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    entityType: text('entity_type').notNull(),
    filename: text('filename').notNull(),
    status: text('status').notNull().default('mapping'),
    columnMapping: jsonb('column_mapping').$type<Record<string, string>>().notNull().default({}),
    options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),
    rowCount: integer('row_count').notNull().default(0),
    validCount: integer('valid_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    createdCount: integer('created_count').notNull().default(0),
    updatedCount: integer('updated_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    bulkOperationId: uuid('bulk_operation_id'),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [index('import_job_tenant_idx').on(table.tenantId, table.createdAt)],
);

export const importRow = importExportSchema.table(
  'import_row',
  {
    id: uuid('id')
      .primaryKey()
      .notNull()
      .default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    importJobId: uuid('import_job_id').notNull(),
    rowNumber: integer('row_number').notNull(),
    raw: jsonb('raw').$type<Record<string, string>>().notNull(),
    normalised: jsonb('normalised').$type<Record<string, unknown>>(),
    rowHash: text('row_hash').notNull(),
    outcome: text('outcome').notNull().default('pending'),
    errors: jsonb('errors').$type<Array<{ field?: string; message: string }>>().notNull().default([]),
    targetId: uuid('target_id'),
  },
  (table) => [index('import_row_job_outcome_idx').on(table.importJobId, table.outcome)],
);

/**
 * Cross-schema reads/writes against `@sms/audit`'s own tables -
 * `revert()`'s only way to (a) find every row a bulk operation wrote,
 * grouped by table (`AuditContract` only reads history by table+record, not
 * by bulk operation id) and (b) mark the original operation `'reverted'`
 * (`AuditContract.completeBulkOperation` only accepts `'completed'`/
 * `'failed'`). Both are read via `sms_app`'s EXISTING grants from
 * `0100_audit.sql` (select on `record_history`, select+insert+update on
 * `bulk_operation`) - `@sms/audit`'s own migrations are never edited by this
 * module (see the module report's constraints).
 *
 * Duplicated column defs rather than importing `@sms/audit`'s
 * `infrastructure/schema.ts` - that file is that module's internal
 * implementation detail, not part of its public contract (`AuditContract`);
 * reaching past it would be exactly the kind of deep import
 * `@nx/enforce-module-boundaries` exists to prevent, even between two
 * `type:platform` packages. Same "raw cross-schema read" precedent
 * `@sms/academic`'s `SectionScopeResolverService` already establishes.
 */
const auditSchemaRef = pgSchema('audit');

export const auditRecordHistory = auditSchemaRef.table(
  'record_history',
  {
    id: uuid('id').notNull(),
    tableSchema: text('table_schema').notNull(),
    tableName: text('table_name').notNull(),
    recordId: text('record_id').notNull(),
    operation: text('operation').notNull(),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    bulkOperationId: uuid('bulk_operation_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.id, table.occurredAt] })],
);

export const auditBulkOperation = auditSchemaRef.table('bulk_operation', {
  id: uuid('id').primaryKey().notNull(),
  tenantId: uuid('tenant_id').notNull(),
  status: text('status').notNull(),
  revertedByOperationId: uuid('reverted_by_operation_id'),
});
