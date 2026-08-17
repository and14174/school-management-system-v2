import { boolean, date, integer, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of `libs/domain/people/migrations/0500_people.sql`. Same
 * convention as `@sms/access`'s `infrastructure/schema.ts`: a read/write
 * model for the application layer, not the source of truth - the SQL
 * migration is. Keep the two in sync by hand.
 */
export const peopleSchema = pgSchema('people');

export const personTable = peopleSchema.table('person', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  givenName: text('given_name').notNull(),
  familyName: text('family_name').notNull(),
  preferredName: text('preferred_name'),
  dateOfBirth: date('date_of_birth'),
  gender: text('gender'),
  photoFileId: uuid('photo_file_id'),
  customFields: jsonb('custom_fields').notNull().default({}),
  mergedIntoId: uuid('merged_into_id'),
  // Withdrawn from view without being deleted - see migration 0502.
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  archivedReason: text('archived_reason'),
  nameNormalized: text('name_normalized'),
  matchKey: text('match_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const personRoleTable = peopleSchema.table('person_role', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  personId: uuid('person_id').notNull(),
  role: text('role').notNull(),
  campusId: uuid('campus_id'),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const householdTable = peopleSchema.table('household', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  primaryAddress: jsonb('primary_address').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const householdMemberTable = peopleSchema.table('household_member', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  householdId: uuid('household_id').notNull(),
  personId: uuid('person_id').notNull(),
  isPrimaryContact: boolean('is_primary_contact').notNull().default(false),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to'),
});

export const relationshipTable = peopleSchema.table(
  'relationship',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    fromPersonId: uuid('from_person_id').notNull(),
    toPersonId: uuid('to_person_id').notNull(),
    type: text('type').notNull(),
    hasCustody: boolean('has_custody').notNull().default(false),
    mayPickup: boolean('may_pickup').notNull().default(false),
    mayReceiveComms: boolean('may_receive_comms').notNull().default(false),
    priority: integer('priority').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('relationship_tenant_id_from_person_id_to_person_id_type_key').on(
      table.tenantId,
      table.fromPersonId,
      table.toPersonId,
      table.type,
    ),
  ],
);

export const personIdentifierTable = peopleSchema.table('person_identifier', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  personId: uuid('person_id').notNull(),
  type: text('type').notNull(),
  value: text('value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const personAlertTable = peopleSchema.table('person_alert', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  personId: uuid('person_id').notNull(),
  category: text('category').notNull(),
  severity: text('severity').notNull(),
  summary: text('summary').notNull(),
  detail: text('detail'),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const contactPointTable = peopleSchema.table('contact_point', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  personId: uuid('person_id').notNull(),
  kind: text('kind').notNull(),
  value: text('value').notNull(),
  label: text('label'),
  isPrimary: boolean('is_primary').notNull().default(false),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const personMergeTable = peopleSchema.table('person_merge', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  survivingPersonId: uuid('surviving_person_id').notNull(),
  mergedPersonId: uuid('merged_person_id').notNull(),
  mergedByUserId: uuid('merged_by_user_id').notNull(),
  reason: text('reason'),
  mergedAt: timestamp('merged_at', { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb('payload').notNull().default({}),
});
