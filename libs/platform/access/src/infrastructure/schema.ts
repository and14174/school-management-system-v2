import { boolean, date, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of `libs/platform/access/migrations/0400_access.sql`. Same
 * convention as `@sms/tenancy`/`@sms/identity`'s `infrastructure/schema.ts`:
 * a read/write model for the application layer, not the source of truth -
 * the SQL migration is. Keep the two in sync by hand.
 */
export const accessSchema = pgSchema('access');

// drizzle-orm's `pgEnum` would create-or-replace the Postgres enum type
// itself, which this package must not do (migrations run as sms_owner via
// the 0400 SQL file, never via drizzle push/generate against this schema
// module) - so `permission_scope` is typed as plain `text` here and narrowed
// in the mappers, exactly like `identity.membership.status` and
// `tenancy.tenant.status` are.
export const permissionTable = accessSchema.table('permission', {
  id: uuid('id').primaryKey(),
  key: text('key').notNull(),
  resource: text('resource').notNull(),
  action: text('action').notNull(),
  description: text('description').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const roleTable = accessSchema.table('role', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rolePermissionTable = accessSchema.table(
  'role_permission',
  {
    id: uuid('id').primaryKey(),
    roleId: uuid('role_id').notNull(),
    permissionId: uuid('permission_id').notNull(),
    scope: text('scope').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [uniqueIndex('role_permission_role_id_permission_id_key').on(table.roleId, table.permissionId)],
);

export const roleAssignmentTable = accessSchema.table('role_assignment', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  roleId: uuid('role_id').notNull(),
  userId: uuid('user_id').notNull(),
  campusId: uuid('campus_id'),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const impersonationTable = accessSchema.table('impersonation', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  actorUserId: uuid('actor_user_id').notNull(),
  targetUserId: uuid('target_user_id').notNull(),
  reason: text('reason').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
});
