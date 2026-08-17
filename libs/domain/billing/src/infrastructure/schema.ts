import { bigint, char, date, integer, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of `libs/domain/billing/migrations/1400_billing.sql`. Same
 * convention as `@sms/records`'s `infrastructure/schema.ts`: a read/write
 * model for the application layer, not the source of truth - the SQL
 * migration is. Keep the two in sync by hand.
 *
 * Every `amount_minor` column uses drizzle's `bigint(..., { mode: 'number' })`
 * - same choice `@sms/documents` makes for `document_version.bytes` - never
 * `numeric`/`float`. See the `1400` migration header on why money is never
 * floating point anywhere in this module.
 */
export const billingSchema = pgSchema('billing');

export const feeScheduleTable = billingSchema.table(
  'fee_schedule',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('fee_schedule_tenant_id_name_key').on(table.tenantId, table.name)],
);

export const feeScheduleVersionTable = billingSchema.table(
  'fee_schedule_version',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    feeScheduleId: uuid('fee_schedule_id').notNull(),
    version: integer('version').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    effectiveFrom: date('effective_from').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('fee_schedule_version_fee_schedule_id_version_key').on(table.feeScheduleId, table.version)],
);

export const feeComponentTable = billingSchema.table(
  'fee_component',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    feeScheduleVersionId: uuid('fee_schedule_version_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('fee_component_fee_schedule_version_id_code_key').on(table.feeScheduleVersionId, table.code)],
);

export const invoiceTable = billingSchema.table('invoice', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  studentPersonId: uuid('student_person_id').notNull(),
  payerPersonId: uuid('payer_person_id'),
  currency: char('currency', { length: 3 }).notNull(),
  status: text('status').notNull().default('draft'),
  dueDate: date('due_date'),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  issuedByUserId: uuid('issued_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const invoiceLineTable = billingSchema.table('invoice_line', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  feeComponentId: uuid('fee_component_id').notNull(),
  feeScheduleVersionId: uuid('fee_schedule_version_id').notNull(),
  description: text('description').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const paymentTable = billingSchema.table(
  'payment',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    payerPersonId: uuid('payer_person_id').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    method: text('method').notNull().default('other'),
    idempotencyKey: text('idempotency_key').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    recordedByUserId: uuid('recorded_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('payment_tenant_id_idempotency_key_key').on(table.tenantId, table.idempotencyKey)],
);

export const paymentAllocationTable = billingSchema.table(
  'payment_allocation',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    invoiceId: uuid('invoice_id').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('payment_allocation_payment_id_invoice_id_key').on(table.paymentId, table.invoiceId)],
);

export const creditNoteTable = billingSchema.table('credit_note', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  reason: text('reason').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  issuedByUserId: uuid('issued_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const creditNoteLineTable = billingSchema.table('credit_note_line', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  creditNoteId: uuid('credit_note_id').notNull(),
  invoiceLineId: uuid('invoice_line_id'),
  description: text('description').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const creditNoteApprovalPolicyTable = billingSchema.table(
  'credit_note_approval_policy',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    thresholdMinor: bigint('threshold_minor', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('credit_note_approval_policy_tenant_id_currency_key').on(table.tenantId, table.currency)],
);
