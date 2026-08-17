-- =============================================================================
-- records: report cards (issued as immutable document snapshots), append-only
--          transcripts, GPA, and versioned credit/promotion rules
-- =============================================================================
-- These are the artefacts a school hands to a parent, a university, or a
-- court. Correctness matters more than features. Three decisions worth
-- calling out up front:
--
--   * AN ISSUED REPORT CARD IS A SNAPSHOT, NOT A LIVE VIEW. records.report_card
--     carries its own `snapshot` jsonb (the computed grades/GPA/attendance at
--     the moment of issue) AND a document_id pointing at the immutable PDF
--     @sms/documents rendered from that exact snapshot (see that module's
--     `1100` migration header - a document is never re-rendered from live
--     data). Re-opening a report card later shows what was issued, not what
--     the gradebook says today. This table never grants sms_app UPDATE - see
--     the grants section below.
--   * TRANSCRIPT ENTRIES ARE FINALISED ONCE AND NEVER RE-GRADED.
--     records.transcript_entry carries grade_scale_version_id - the SAME
--     scale version @sms/gradebook's gradebook.score.grade_scale_version_id
--     was stamped with at grading time (see that module's `1000` migration
--     header) - and percentage/letter/gpa_points are copied in AT FINALISE
--     TIME, never recomputed from a live join. A later grade-scale republish
--     therefore cannot silently reword a transcript already handed to a
--     university. Enforced in the database (trg_forbid_transcript_entry_mutation
--     below refuses UPDATE and DELETE outright, same posture as
--     documents.template_version and enrollment.status_event) - not merely a
--     service-layer promise.
--   * CREDITS AND PROMOTION ELIGIBILITY ARE RULES AS DATA, not `if` branches.
--     records.credit_rule_set/_version follows the exact same
--     named-set/immutable-version shape as gradebook.grade_scale/_version:
--     a rule set's `rules` jsonb (required credits per grade level, minimum
--     GPA) is interpreted by ONE evaluator
--     (application/transcript.service.ts's checkPromotionEligibility), never
--     branched on by scheme in code, so a school's promotion policy changes
--     by publishing a new version, and every already-decided prior year's
--     eligibility keeps resolving through the version in force when it was
--     decided.
-- =============================================================================

create schema records;

-- -----------------------------------------------------------------------------
-- records.report_card_run
-- -----------------------------------------------------------------------------
-- One batch issue. section_id null = the whole school (every currently
-- enrolled student); non-null narrows WHICH STUDENTS get a report card this
-- run to one section's roster - the resulting report card for each of those
-- students still covers every section they take, not just that one (see
-- records.report_card.snapshot). idempotency_key makes a resubmitted issue
-- request (a registrar's browser retrying a slow request) a no-op rather than
-- a duplicate batch - same idiom as gradebook.submission /
-- attendance.submission, folded directly onto the run row since one run IS
-- one idempotent batch action.
create table records.report_card_run (
  id                 uuid primary key default uuidv7(),
  tenant_id          uuid not null references tenancy.tenant (id) on delete restrict,
  grading_period_id  uuid not null references academic.grading_period (id) on delete restrict,
  section_id         uuid references academic.section (id) on delete restrict,
  idempotency_key    text not null,
  status             text not null default 'draft' check (status in ('draft', 'issued')),
  issued_at          timestamptz,
  issued_by_user_id  uuid references identity.user (id) on delete restrict,
  document_count     integer not null default 0,
  -- So a mis-issued batch is reversible - @sms/audit's AuditContract.
  -- withBulkOperation stamps every row RecordsService.issueReportCards writes
  -- (this row, every records.report_card row, and the documents.document rows
  -- @sms/documents writes) with the SAME bulk_operation_id.
  bulk_operation_id  uuid references audit.bulk_operation (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

comment on table records.report_card_run is
  'One batch issue of report cards for a grading period (optionally narrowed to one section''s roster). Reversible via bulk_operation_id -> audit.bulk_operation. Idempotent on (tenant_id, idempotency_key).';

create index report_card_run_tenant_grading_period_idx on records.report_card_run (tenant_id, grading_period_id);

-- -----------------------------------------------------------------------------
-- records.report_card
-- -----------------------------------------------------------------------------
-- One per student per run. snapshot is the FULL computed report (per-course
-- percentage/letter/credits, GPA, attendance summary if available, comments)
-- exactly as handed to @sms/documents' DocumentsContract.generate to render
-- document_id - see this file's own header. Never updated after insert (no
-- UPDATE grant below): re-opening this row is what "show what was issued"
-- means.
create table records.report_card (
  id                  uuid primary key default uuidv7(),
  tenant_id           uuid not null references tenancy.tenant (id) on delete restrict,
  report_card_run_id  uuid not null references records.report_card_run (id) on delete restrict,
  person_id           uuid not null references people.person (id) on delete restrict,
  enrollment_id       uuid references enrollment.enrollment (id) on delete restrict,
  document_id         uuid not null references documents.document (id) on delete restrict,
  snapshot            jsonb not null,
  gpa                 numeric,
  created_at          timestamptz not null default now(),
  unique (tenant_id, report_card_run_id, person_id)
);

comment on table records.report_card is
  'One issued report card for one student in one run. snapshot is the computed report AT ISSUE TIME - re-opening this row never reflects a later grade change. document_id points at the immutable rendered PDF (documents.document).';

create index report_card_tenant_person_idx on records.report_card (tenant_id, person_id, created_at desc);
create index report_card_tenant_run_idx on records.report_card (tenant_id, report_card_run_id);

-- -----------------------------------------------------------------------------
-- records.transcript_entry
-- -----------------------------------------------------------------------------
-- The permanent academic record. Append-only once finalised - see this
-- file's own header and trg_forbid_transcript_entry_mutation below. unique
-- (tenant_id, person_id, section_id) is also finaliseTranscriptEntries'
-- idempotency key: re-finalising the same student's same section is a
-- no-op (ON CONFLICT DO NOTHING), never a duplicate row or a silent
-- overwrite of what was already recorded.
create table records.transcript_entry (
  id                      uuid primary key default uuidv7(),
  tenant_id               uuid not null references tenancy.tenant (id) on delete restrict,
  person_id               uuid not null references people.person (id) on delete restrict,
  academic_year_id        uuid not null references tenancy.academic_year (id) on delete restrict,
  term_id                 uuid not null references academic.term (id) on delete restrict,
  course_id               uuid not null references academic.course (id) on delete restrict,
  section_id              uuid not null references academic.section (id) on delete restrict,
  -- Copied in at finalise time (not joined live) so the entry reads correctly
  -- even if the course is later renamed/recoded.
  course_code             text not null,
  course_name             text not null,
  credits_attempted       numeric not null default 0,
  credits_earned          numeric not null default 0,
  percentage              numeric,
  letter                  text,
  -- Copied from gradebook.student_section_grade.gpaPoints, NOT recomputed
  -- from letter+scale later - see this file's own header. calculateGpa
  -- (application/transcript.service.ts) weights ONLY off this stored column.
  gpa_points              numeric,
  -- The scale version the underlying scores were entered under
  -- (@sms/gradebook's ScoreService.pickScaleVersionForStudent) - carried
  -- through so the entry's provenance is auditable, even though gpa_points/
  -- letter/percentage are themselves already-resolved, immutable copies.
  grade_scale_version_id  uuid references gradebook.grade_scale_version (id) on delete restrict,
  finalised_at            timestamptz not null default now(),
  unique (tenant_id, person_id, section_id)
);

comment on table records.transcript_entry is
  'One finalised course result for one student. Append-only history (see the file header) - percentage/letter/gpa_points are resolved and copied in ONCE, at finalise time, and never recomputed from a live grade-scale join. trg_forbid_transcript_entry_mutation below refuses UPDATE and DELETE outright.';

create index transcript_entry_tenant_person_idx on records.transcript_entry (tenant_id, person_id, academic_year_id);
create index transcript_entry_tenant_term_idx on records.transcript_entry (tenant_id, term_id);

-- -----------------------------------------------------------------------------
-- records.credit_rule_set / records.credit_rule_set_version
-- -----------------------------------------------------------------------------
create table records.credit_rule_set (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenancy.tenant (id) on delete restrict,
  name        text not null,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, name)
);

comment on table records.credit_rule_set is
  'A named credits/promotion-eligibility policy (e.g. "Standard Promotion Policy"). Never edited in place past its first version - see records.credit_rule_set_version and this file''s own header.';

create index credit_rule_set_tenant_idx on records.credit_rule_set (tenant_id);

create unique index credit_rule_set_one_default_idx on records.credit_rule_set (tenant_id) where is_default;

create table records.credit_rule_set_version (
  id                    uuid primary key default uuidv7(),
  tenant_id             uuid not null references tenancy.tenant (id) on delete restrict,
  credit_rule_set_id    uuid not null references records.credit_rule_set (id) on delete restrict,
  version               integer not null,
  -- { "defaultRequiredCredits": 6, "minGpa": 1.0,
  --   "gradeLevelOverrides": { "<gradeLevelId>": { "requiredCredits": 7, "minGpa": 1.5 } } }
  -- Interpreted by ONE evaluator (application/transcript.service.ts's
  -- checkPromotionEligibility), never branched on by scheme - same posture
  -- as gradebook.calculation_rule_set_version.
  rules                 jsonb not null,
  effective_from        date not null default current_date,
  created_at            timestamptz not null default now(),
  unique (credit_rule_set_id, version)
);

comment on table records.credit_rule_set_version is
  'An IMMUTABLE snapshot of one credit_rule_set''s promotion policy, effective from a date. Never UPDATEd or DELETEd past creation (trg_forbid_credit_rule_set_version_mutation below).';

create index credit_rule_set_version_tenant_set_idx on records.credit_rule_set_version (tenant_id, credit_rule_set_id, effective_from desc);

-- -----------------------------------------------------------------------------
-- Immutability: transcript_entry is append-only (unconditionally - contrast
-- gradebook.correction, which permits updating its decision fields; a
-- transcript entry has no "decision" left to make once finalised).
-- -----------------------------------------------------------------------------
create or replace function records.forbid_transcript_entry_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'records.transcript_entry is append-only history and cannot be deleted';
  end if;
  raise exception 'records.transcript_entry is append-only history and cannot be updated';
end;
$$;

create trigger trg_forbid_transcript_entry_update before update on records.transcript_entry
  for each row execute function records.forbid_transcript_entry_mutation();
create trigger trg_forbid_transcript_entry_delete before delete on records.transcript_entry
  for each row execute function records.forbid_transcript_entry_mutation();

-- -----------------------------------------------------------------------------
-- Immutability: credit_rule_set_version
-- -----------------------------------------------------------------------------
create or replace function records.forbid_credit_rule_set_version_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'records.credit_rule_set_version is an immutable version and cannot be % - publish a new version instead', lower(tg_op);
end;
$$;

create trigger trg_forbid_crsv_update before update on records.credit_rule_set_version
  for each row execute function records.forbid_credit_rule_set_version_mutation();
create trigger trg_forbid_crsv_delete before delete on records.credit_rule_set_version
  for each row execute function records.forbid_credit_rule_set_version_mutation();

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function records.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_set_updated_at before update on records.report_card_run
  for each row execute function records.set_updated_at();
create trigger trg_set_updated_at before update on records.credit_rule_set
  for each row execute function records.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
alter table records.report_card_run enable row level security;
create policy report_card_run_tenant_isolation on records.report_card_run
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table records.report_card enable row level security;
create policy report_card_tenant_isolation on records.report_card
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table records.transcript_entry enable row level security;
create policy transcript_entry_tenant_isolation on records.transcript_entry
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table records.credit_rule_set enable row level security;
create policy credit_rule_set_tenant_isolation on records.credit_rule_set
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table records.credit_rule_set_version enable row level security;
create policy credit_rule_set_version_tenant_isolation on records.credit_rule_set_version
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Audit history
-- -----------------------------------------------------------------------------
select audit.attach_history('records.report_card_run');
select audit.attach_history('records.report_card');
select audit.attach_history('records.transcript_entry');
select audit.attach_history('records.credit_rule_set');
select audit.attach_history('records.credit_rule_set_version');

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Migrations run as sms_owner, which owns these tables; sms_app gets no
-- default privileges on objects sms_owner creates, so every table needs
-- explicit grants. sms_app is NOBYPASSRLS and owns nothing here (arch-check.ts
-- checks 3 and 4).
--
-- report_card_run: UPDATE is needed to transition draft -> issued and stamp
-- issued_at/issued_by_user_id/document_count/bulk_operation_id.
-- report_card: INSERT/SELECT only - written once at issue time, never
-- updated in place (see this file's own header on snapshots), same posture
-- as documents.document_version.
-- transcript_entry: INSERT/SELECT only - the trigger above already refuses
-- UPDATE/DELETE, but withholding the grant too means the refusal does not
-- depend on the trigger alone (same belt-and-suspenders posture as
-- enrollment.status_event / documents.template_version).
-- credit_rule_set / credit_rule_set_version: UPDATE is granted (the version
-- table's is immaterial - the trigger rejects every attempt outright, same
-- posture as gradebook.grade_scale_version).
grant usage on schema records to sms_app;
grant select, insert, update  on records.report_card_run          to sms_app;
grant select, insert           on records.report_card              to sms_app;
grant select, insert           on records.transcript_entry         to sms_app;
grant select, insert, update  on records.credit_rule_set           to sms_app;
grant select, insert, update  on records.credit_rule_set_version   to sms_app;
