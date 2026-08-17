-- =============================================================================
-- import_export: parse -> dry run -> commit, one code path, every commit reversible
-- =============================================================================
-- A polished import is what gets a pilot school's data in, and the first thing
-- that loses their trust if it goes wrong. Two properties are non-negotiable:
--
--   * The dry run must execute the SAME validation/transformation code as the
--     commit, differing only in that it does not write - see @sms/import-export's
--     application/pipeline.service.ts. A preview computed by different logic
--     than the commit is a preview that lies.
--   * Every commit runs inside @sms/audit's `AuditContract.withBulkOperation`,
--     which stamps every row it writes with `bulk_operation_id` - the single
--     column that makes an entire import reversible as a unit later. That
--     machinery has existed since the `audit` module (0100) but nothing has
--     used it until this module.
--
-- Two tables: one row per upload (`import_job`), one row per CSV data row
-- (`import_row`) so a school can see exactly which of 1,200 rows failed and
-- why, without re-parsing the file.
-- =============================================================================

create schema import_export;

-- -----------------------------------------------------------------------------
-- import_export.import_job
-- -----------------------------------------------------------------------------
create table import_export.import_job (
  id                  uuid primary key default uuidv7(),
  tenant_id           uuid not null references tenancy.tenant (id) on delete restrict,
  -- Dotted module.entity string matching an @sms/import-export ImportTarget's
  -- entityType (e.g. 'people.person') - not a foreign key to anything, same
  -- reasoning as custom_fields.field_definition.entity_type: the set of valid
  -- entity types is defined by which targets are registered in code, across
  -- modules this one cannot see (see application/import-target-registry.ts).
  entity_type         text not null,
  filename            text not null,
  status              text not null default 'mapping'
                      check (status in ('mapping', 'validating', 'previewed', 'committing', 'completed', 'failed', 'reverted')),
  -- Target field key -> source CSV header name.
  column_mapping      jsonb not null default '{}'::jsonb,
  options             jsonb not null default '{}'::jsonb,
  row_count           integer not null default 0,
  valid_count         integer not null default 0,
  error_count         integer not null default 0,
  created_count       integer not null default 0,
  updated_count       integer not null default 0,
  skipped_count       integer not null default 0,
  -- Set once commit() opens its bulk operation. Nullable: a job that never
  -- got past dry run has none. No FK - audit.bulk_operation lives in a
  -- schema this module can read/write (grants below) but does not own, and
  -- @sms/audit's own migrations (0100-0199) are never edited by this module -
  -- see the module report's constraints. Referential integrity here is
  -- enforced in application code (AuditContract.withBulkOperation is the only
  -- writer of audit.bulk_operation.id), same precedent as
  -- custom_fields.field_definition.entity_type being unenforced by FK.
  bulk_operation_id   uuid,
  created_by_user_id  uuid,
  created_at          timestamptz not null default now(),
  completed_at        timestamptz
);

comment on table import_export.import_job is
  'One row per upload: parse -> mapping -> dry run -> commit -> (optionally) revert. status drives which of those phases is legal next - see @sms/import-export''s application/job.service.ts.';

create index import_job_tenant_idx on import_export.import_job (tenant_id, created_at desc);

-- -----------------------------------------------------------------------------
-- import_export.import_row
-- -----------------------------------------------------------------------------
create table import_export.import_row (
  id               uuid primary key default uuidv7(),
  tenant_id        uuid not null references tenancy.tenant (id) on delete restrict,
  import_job_id    uuid not null references import_export.import_job (id) on delete cascade,
  row_number       integer not null,
  -- The row exactly as read from the CSV: source header -> raw string value.
  -- Never mutated once written by createJob() - re-running dryRun/commit
  -- after the mapping changes re-derives `normalised` from this, which is
  -- what makes "dry run and commit agree" possible: both start from the
  -- same immutable input and run the same ImportTarget.parseRow().
  raw              jsonb not null,
  -- ImportTarget.parseRow()'s output for this row, once parsed successfully -
  -- null while outcome is 'pending' or 'error'.
  normalised       jsonb,
  -- Content fingerprint of `raw` (sha256 of its canonical JSON - see
  -- domain/hash.ts). Not itself the create-vs-update key (that is
  -- ImportTarget.findExisting(), which a target may implement via an
  -- external-id column or its own natural key) - this is an observability
  -- aid: "was this exact row seen before, in this job or another one".
  row_hash         text not null,
  outcome          text not null default 'pending'
                   check (outcome in ('pending', 'valid', 'error', 'created', 'updated', 'skipped')),
  errors           jsonb not null default '[]'::jsonb,
  -- The id ImportTarget.create()/update() returned, once outcome is
  -- 'created' or 'updated'. No FK - the target table lives in a schema this
  -- module does not know about at migration time (that is the entire point
  -- of the ImportTarget inversion - see the module report).
  target_id        uuid
);

comment on table import_export.import_row is
  'One row per CSV data row. raw is immutable once written; normalised/outcome/errors/target_id are rewritten by dryRun and again by commit - see @sms/import-export''s application/pipeline.service.ts.';

create index import_row_job_outcome_idx on import_export.import_row (import_job_id, outcome);
create index import_row_tenant_idx on import_export.import_row (tenant_id);

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
alter table import_export.import_job enable row level security;
create policy import_job_tenant_isolation on import_export.import_job
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table import_export.import_row enable row level security;
create policy import_row_tenant_isolation on import_export.import_row
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Audit history
-- -----------------------------------------------------------------------------
select audit.attach_history('import_export.import_job');
select audit.attach_history('import_export.import_row');

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Migrations run as sms_owner, which owns these tables; sms_app gets no
-- default privileges on objects sms_owner creates, so it needs explicit
-- grants. sms_app is NOBYPASSRLS and owns nothing here (arch-check.ts checks
-- 3 and 4).
grant usage on schema import_export to sms_app;
grant select, insert, update, delete on import_export.import_job to sms_app;
grant select, insert, update, delete on import_export.import_row to sms_app;

-- revert() reads audit.record_history by bulk_operation_id (a query
-- @sms/audit's own AuditContract does not expose - it only reads by table+
-- record - so this module reads the table directly, the same "raw
-- cross-schema read" precedent @sms/academic's SectionScopeResolverService
-- already establishes for a platform/domain inversion) and marks the
-- original audit.bulk_operation 'reverted'. Both tables already grant
-- sms_app select; audit.bulk_operation already grants update (0100_audit.sql)
-- for exactly this kind of application-level bookkeeping, so no further
-- grant is needed here - restated for readability only, not executable:
--   audit.record_history:  select (existing grant, 0100_audit.sql)
--   audit.bulk_operation:  select, insert, update (existing grant, 0100_audit.sql)
