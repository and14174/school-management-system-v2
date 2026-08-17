import { bigint, boolean, index, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const publicApi = pgSchema('public_api');

/** Typed view of `public_api.api_key`. The SQL migration is the source of truth. */
export const apiKey = publicApi.table(
  'api_key',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    grantedPermissions: text('granted_permissions').array().notNull(),
    createdByUserId: uuid('created_by_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    neverExpires: boolean('never_expires').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: uuid('revoked_by_user_id'),
    revokeReason: text('revoke_reason'),
  },
  (t) => [index('api_key_tenant_idx').on(t.tenantId, t.createdAt)],
);

/** Typed view of `public_api.api_key_usage`. One row per key - see the 1600 migration header. */
export const apiKeyUsage = publicApi.table('api_key_usage', {
  apiKeyId: uuid('api_key_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull(),
  useCount: bigint('use_count', { mode: 'number' }).notNull(),
});

/** Typed view of `public_api.api_key_request_log`. Append-only - see the 1600 migration header. */
export const apiKeyRequestLog = publicApi.table(
  'api_key_request_log',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    apiKeyId: uuid('api_key_id').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('api_key_request_log_key_idx').on(t.apiKeyId, t.occurredAt),
    index('api_key_request_log_tenant_idx').on(t.tenantId, t.occurredAt),
  ],
);
