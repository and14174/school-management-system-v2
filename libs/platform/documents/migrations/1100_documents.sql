-- =============================================================================
-- documents - issued artefacts (report cards, transcripts, certificates,
-- ID cards, invoices, ...) rendered once and never re-rendered on demand
-- =============================================================================
-- The property this schema exists to protect: a document handed to a parent
-- in March must still look, byte-for-byte, like what was handed to them in
-- March - even after the grades, the template's CSS, or the school's logo
-- have since changed. That is only true if generation writes an IMMUTABLE
-- artefact (the PDF in object storage, plus this row recording exactly which
-- template version and which input data produced it) instead of re-deriving
-- the document from live data on every read.
--
-- Consequences that follow directly from that:
--   * documents.template_version is append-only. Once published, its
--     html_source/css_source can never change - editing a template creates a
--     NEW version, so every document keeps pointing at the exact source that
--     rendered it. Enforced by triggers below, not merely by convention.
--   * Reissuing a document (@sms/documents' DocumentsContract.reissue) never
--     updates a document row in place. It INSERTs a new one and sets
--     superseded_by_document_id on the old one - the old row, and the PDF it
--     points at, are never touched.
--
-- This module (type:platform) has no idea what a "report card" is - see
-- DOCUMENT_TEMPLATE_REGISTRY in src/contract.ts for the inversion that keeps
-- it that way. subject_type/subject_id below are deliberately untyped
-- (text/uuid, no FK) for the same reason: this schema must not reference a
-- domain table it is not allowed to depend on.
-- =============================================================================

create schema if not exists documents;

-- -----------------------------------------------------------------------------
-- documents.template
-- -----------------------------------------------------------------------------
create table documents.template (
  id          uuid        primary key default uuidv7(),
  tenant_id   uuid        not null references tenancy.tenant (id) on delete restrict,
  key         text        not null,
  name        text        not null,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, key)
);

comment on table documents.template is
  'One row per registered DocumentTemplate key a tenant has published at least one version of. The code-level template (@sms/documents'' DOCUMENT_TEMPLATE_REGISTRY) owns the entity type, JSON schema and render() logic; this row is just the tenant''s published-content anchor for it.';

-- -----------------------------------------------------------------------------
-- documents.template_version
-- -----------------------------------------------------------------------------
-- Immutable once inserted - see the file header. html_source/css_source are
-- the tenant-editable presentation layer: a school restyles a report card by
-- publishing a new version with different CSS, never by asking a developer to
-- change code. See DocumentsContract.publishTemplateVersion / generate().
create table documents.template_version (
  id                 uuid        primary key default uuidv7(),
  tenant_id          uuid        not null references tenancy.tenant (id) on delete restrict,
  template_id        uuid        not null references documents.template (id) on delete restrict,
  version            integer     not null,
  html_source        text        not null,
  css_source          text        not null,
  published_at       timestamptz not null default now(),
  created_by_user_id uuid        references identity.user (id) on delete restrict,
  unique (template_id, version)
);

comment on table documents.template_version is
  'Immutable, append-only. A document.generated_at snapshot always points at exactly the version that produced it, so a template edit can never silently rewrite a document already issued. UPDATE/DELETE are refused at the table level - see trg_forbid_template_version_mutation below.';

create index template_version_template_idx on documents.template_version (template_id, version desc);

-- -----------------------------------------------------------------------------
-- documents.document
-- -----------------------------------------------------------------------------
-- The issued artefact. Never updated in place except to stamp
-- superseded_by_document_id when reissue() supersedes it - every other column
-- is written once, at INSERT, and never touched again.
create table documents.document (
  id                        uuid        primary key default uuidv7(),
  tenant_id                 uuid        not null references tenancy.tenant (id) on delete restrict,
  template_version_id       uuid        not null references documents.template_version (id) on delete restrict,

  -- Deliberately untyped: this module may not depend on the domain modules
  -- that own people.person / academic.section / etc. See the file header.
  subject_type              text        not null,
  subject_id                uuid        not null,

  title                     text        not null,
  storage_key               text        not null,
  content_hash              text        not null,
  data_snapshot             jsonb       not null,
  page_count                integer     not null,
  bytes                     bigint      not null,
  generated_by_user_id      uuid        references identity.user (id) on delete restrict,
  generated_at              timestamptz not null default now(),
  superseded_by_document_id uuid        references documents.document (id) on delete restrict
);

comment on table documents.document is
  'An issued, immutable artefact (PDF in object storage at storage_key) plus the template version and data it was rendered from. Reissuing writes a NEW row and sets superseded_by_document_id on the old one - never an update in place.';

create index document_tenant_subject_idx
  on documents.document (tenant_id, subject_type, subject_id, generated_at desc);
create index document_template_version_idx on documents.document (template_version_id);

-- -----------------------------------------------------------------------------
-- documents.template_version is immutable - UPDATE/DELETE refused outright
-- -----------------------------------------------------------------------------
create or replace function documents.forbid_template_version_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'documents.template_version is immutable and cannot be deleted - publish a new version instead';
  end if;

  raise exception 'documents.template_version is immutable and cannot be updated - publish a new version instead';
end;
$$;

create trigger trg_forbid_template_version_update
  before update on documents.template_version
  for each row execute function documents.forbid_template_version_mutation();

create trigger trg_forbid_template_version_delete
  before delete on documents.template_version
  for each row execute function documents.forbid_template_version_mutation();

-- -----------------------------------------------------------------------------
-- Audit history
-- -----------------------------------------------------------------------------
select audit.attach_history('documents.template');
select audit.attach_history('documents.template_version');
select audit.attach_history('documents.document');

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
alter table documents.template enable row level security;
create policy template_tenant_isolation on documents.template
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table documents.template_version enable row level security;
create policy template_version_tenant_isolation on documents.template_version
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table documents.document enable row level security;
create policy document_tenant_isolation on documents.document
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
grant usage on schema documents to sms_app;

grant select, insert on documents.template to sms_app;

-- No UPDATE/DELETE: the triggers above already refuse both, but withholding
-- the grant too means the refusal does not depend on the trigger alone.
grant select, insert on documents.template_version to sms_app;

-- UPDATE is needed for exactly one thing: stamping superseded_by_document_id
-- when reissue() supersedes a document. Every other column of an existing row
-- is never written again by the application.
grant select, insert, update on documents.document to sms_app;
