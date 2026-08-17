import { index, integer, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of `libs/platform/approvals/migrations/1700_approvals.sql`.
 * A read/write model for the application layer, not the source of truth -
 * the SQL migration is. Keep the two in sync by hand, same convention as
 * every other module's `infrastructure/schema.ts`.
 */
export const approvalsSchema = pgSchema('approvals');

export const policyTable = approvalsSchema.table(
  'policy',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    requestType: text('request_type').notNull(),
    permissionKey: text('permission_key').notNull(),
    approvalsRequired: integer('approvals_required').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('policy_tenant_id_request_type_key').on(table.tenantId, table.requestType)],
);

export const requestTable = approvalsSchema.table(
  'request',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    requestType: text('request_type').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    payload: jsonb('payload').notNull(),
    requestedByUserId: uuid('requested_by_user_id').notNull(),
    approvalsRequired: integer('approvals_required').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('request_tenant_status_idx').on(table.tenantId, table.status, table.createdAt),
    index('request_tenant_type_idx').on(table.tenantId, table.requestType, table.createdAt),
    index('request_tenant_subject_idx').on(table.tenantId, table.subjectType, table.subjectId),
  ],
);

export const decisionTable = approvalsSchema.table(
  'decision',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    requestId: uuid('request_id').notNull(),
    decidedByUserId: uuid('decided_by_user_id').notNull(),
    decision: text('decision').notNull(),
    reason: text('reason'),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('decision_request_id_decided_by_user_id_key').on(table.requestId, table.decidedByUserId)],
);
