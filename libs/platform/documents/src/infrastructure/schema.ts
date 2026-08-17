import { bigint, index, integer, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const documents = pgSchema('documents');

/** Typed view of `documents.template`. The SQL migration is the source of truth. */
export const template = documents.table('template', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

/** Typed view of `documents.template_version`. Immutable at the DB level - see the migration's triggers. */
export const templateVersion = documents.table(
  'template_version',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    templateId: uuid('template_id').notNull(),
    version: integer('version').notNull(),
    htmlSource: text('html_source').notNull(),
    cssSource: text('css_source').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    createdByUserId: uuid('created_by_user_id'),
  },
  (t) => [index('template_version_template_idx').on(t.templateId, t.version)],
);

/** Typed view of `documents.document`. The issued artefact - see the migration header. */
export const document = documents.table(
  'document',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    templateVersionId: uuid('template_version_id').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    title: text('title').notNull(),
    storageKey: text('storage_key').notNull(),
    contentHash: text('content_hash').notNull(),
    dataSnapshot: jsonb('data_snapshot').notNull(),
    pageCount: integer('page_count').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    generatedByUserId: uuid('generated_by_user_id'),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
    supersededByDocumentId: uuid('superseded_by_document_id'),
  },
  (t) => [index('document_tenant_subject_idx').on(t.tenantId, t.subjectType, t.subjectId, t.generatedAt)],
);
