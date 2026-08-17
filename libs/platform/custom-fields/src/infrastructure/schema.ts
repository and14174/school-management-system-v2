import { boolean, integer, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of `libs/platform/custom-fields/migrations/0450_custom_fields.sql`.
 * Same convention as `@sms/access`'s `infrastructure/schema.ts`: a read/write
 * model for the application layer, not the source of truth - the SQL
 * migration is. Keep the two in sync by hand.
 */
export const customFieldsSchema = pgSchema('custom_fields');

export const fieldDefinitionTable = customFieldsSchema.table(
  'field_definition',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    entityType: text('entity_type').notNull(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    dataType: text('data_type').notNull(),
    options: jsonb('options').notNull().default([]),
    required: boolean('required').notNull().default(false),
    reportable: boolean('reportable').notNull().default(true),
    displayOrder: integer('display_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('field_definition_tenant_id_entity_type_key_key').on(table.tenantId, table.entityType, table.key)],
);
