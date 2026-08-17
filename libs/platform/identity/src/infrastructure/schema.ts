import { boolean, integer, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of `libs/platform/identity/migrations/0300_identity_auth.sql`
 * and `0301_identity_membership.sql`. Same convention as `@sms/tenancy`'s
 * `infrastructure/schema.ts`: a read/write model for the application layer,
 * not the source of truth - the SQL migrations are. Keep the two in sync by
 * hand.
 *
 * The Better Auth tables (`user`/`session`/`account`/`verification`/
 * `two_factor`) are additionally consumed by `application/auth.ts`'s
 * `drizzleAdapter(db, { schema: authDrizzleSchema })` - the JS property keys
 * on `authDrizzleSchema` (see the bottom of this file) are Better Auth's
 * *model* names (`user`, `session`, ... `twoFactor`, camelCase) and must
 * match exactly; the underlying Postgres table/column names are independent
 * and stay snake_case like the rest of this codebase.
 */
export const identitySchema = pgSchema('identity');

export const userTable = identitySchema.table('user', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  emailVerified: boolean('email_verified').notNull(),
  image: text('image'),
  twoFactorEnabled: boolean('two_factor_enabled').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessionTable = identitySchema.table('session', {
  id: uuid('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: uuid('user_id').notNull(),
  // This module's own extension to Better Auth's default session schema -
  // see the 0300 migration comment on identity.session.
  activeTenantId: uuid('active_tenant_id'),
});

export const accountTable = identitySchema.table('account', {
  id: uuid('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: uuid('user_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const verificationTable = identitySchema.table('verification', {
  id: uuid('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const twoFactorTable = identitySchema.table('two_factor', {
  id: uuid('id').primaryKey(),
  secret: text('secret').notNull(),
  backupCodes: text('backup_codes').notNull(),
  userId: uuid('user_id').notNull(),
  verified: boolean('verified').notNull(),
  failedVerificationCount: integer('failed_verification_count').notNull(),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const membershipTable = identitySchema.table(
  'membership',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    personId: uuid('person_id'),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('membership_user_id_tenant_id_key').on(table.userId, table.tenantId)],
);

/**
 * Keyed by Better Auth *model* name (see the file header) - passed directly
 * as `drizzleAdapter(authDb, { provider: 'pg', schema: authDrizzleSchema })`
 * in `application/auth.ts`.
 */
export const authDrizzleSchema = {
  user: userTable,
  session: sessionTable,
  account: accountTable,
  verification: verificationTable,
  twoFactor: twoFactorTable,
};
