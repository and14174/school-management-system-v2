import { sql, type SQL } from 'drizzle-orm';
import { boolean, date, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of `libs/platform/tenancy/migrations/0200_tenancy.sql`.
 * This is a read/write model for the application layer, not the source of
 * truth for the schema - the SQL migration is. Keep the two in sync by hand;
 * `drizzle-kit generate` is not used to author migrations here (every
 * module hand-writes its own numbered SQL file, see `libs/shared/db/src/migrate.ts`).
 */
export const tenancySchema = pgSchema('tenancy');

export const tenantTable = tenancySchema.table('tenant', {
  id: uuid('id').primaryKey(),
  // Generated always as (id) stored - see the migration comment. Never write
  // to this column directly; Drizzle only needs it for reads/RLS reasoning.
  tenantId: uuid('tenant_id')
    .notNull()
    .generatedAlwaysAs((): SQL => sql`id`),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  locale: text('locale').notNull(),
  timezone: text('timezone').notNull(),
  currency: text('currency').notNull(),
  status: text('status').notNull(),
  branding: jsonb('branding').notNull(),
  featureFlags: jsonb('feature_flags').notNull(),
  terminology: jsonb('terminology').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const campusTable = tenancySchema.table(
  'campus',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    address: jsonb('address').notNull(),
    timezone: text('timezone').notNull(),
    locale: text('locale').notNull(),
    isDefault: boolean('is_default').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('campus_tenant_id_code_key').on(table.tenantId, table.code)],
);

export const academicYearTable = tenancySchema.table(
  'academic_year',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    status: text('status').notNull(),
    isCurrent: boolean('is_current').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('academic_year_tenant_id_name_key').on(table.tenantId, table.name)],
);
