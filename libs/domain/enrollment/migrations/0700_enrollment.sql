-- =============================================================================
-- enrollment: school enrolment - which campus, grade level and academic year
--             a person belongs to, and the append-only history of how they
--             got there
-- =============================================================================
-- Distinct from academic.section_enrollment (which CLASS a student sits in).
-- This module owns SCHOOL enrolment: one row per (person, academic_year) -
-- see enrollment.enrollment's own comment below.
--
-- Enrolment status is an IMMUTABLE HISTORY, never a mutable column overwritten
-- in place. enrollment.enrollment.status is a denormalised "what is it right
-- now" cache, kept in sync with the newest enrollment.status_event row for
-- the same enrolment inside the SAME transaction (see @sms/enrollment's
-- EnrollmentRecordService.transitionStatus) - it is never written on its own.
-- "What was this student's status in March?" has to stay answerable (needed
-- for transcripts and leaving certificates), which a mutable column alone
-- could never provide - so status_event rows are append-only, enforced in the
-- database (trg_forbid_status_event_mutation below), not left as an
-- application-level promise a second code path could bypass.
--
-- Writes are gated by tenancy.assert_year_writable: directly via
-- academic_year_id on enrollment.enrollment, and via enrollment_id ->
-- enrollment.academic_year_id on enrollment.status_event - same reasoning
-- and same DB-trigger-not-application-code approach as academic's 0600
-- migration.
-- =============================================================================

create schema enrollment;

-- -----------------------------------------------------------------------------
-- enrollment.enrollment
-- -----------------------------------------------------------------------------
create table enrollment.enrollment (
  id               uuid primary key default uuidv7(),
  tenant_id        uuid not null references tenancy.tenant (id) on delete restrict,
  person_id        uuid not null references people.person (id) on delete restrict,
  academic_year_id uuid not null references tenancy.academic_year (id) on delete restrict,
  campus_id        uuid not null references tenancy.campus (id) on delete restrict,
  grade_level_id   uuid not null references academic.grade_level (id) on delete restrict,
  student_number   text,
  status           text not null check (status in ('applied', 'enrolled', 'withdrawn', 'graduated', 'transferred_out')),
  enrolled_on      date not null,
  exited_on        date,
  exit_reason      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, person_id, academic_year_id),
  constraint enrollment_exited_after_enrolled check (exited_on is null or exited_on >= enrolled_on)
);

comment on table enrollment.enrollment is
  'One row per (person, academic_year): which campus, grade level and school year a person belongs to. status is denormalised from the newest enrollment.status_event row for this enrolment - never written independently of it. Writes are gated by tenancy.assert_year_writable via trg_assert_year_writable below.';

create index enrollment_tenant_year_status_idx on enrollment.enrollment (tenant_id, academic_year_id, status);
create index enrollment_tenant_person_idx on enrollment.enrollment (tenant_id, person_id);
create index enrollment_tenant_campus_idx on enrollment.enrollment (tenant_id, campus_id);

-- -----------------------------------------------------------------------------
-- enrollment.status_event
-- -----------------------------------------------------------------------------
-- The immutable history enrollment.enrollment.status is only ever a cache of.
-- Append-only: trg_forbid_update/trg_forbid_delete below reject any UPDATE or
-- DELETE outright (and sms_app is not even granted those privileges - see the
-- grants section) - a database invariant, not a promise a second code path
-- could bypass.
create table enrollment.status_event (
  id            uuid primary key default uuidv7(),
  tenant_id     uuid not null references tenancy.tenant (id) on delete restrict,
  enrollment_id uuid not null references enrollment.enrollment (id) on delete restrict,
  from_status   text check (from_status in ('applied', 'enrolled', 'withdrawn', 'graduated', 'transferred_out')),
  to_status     text not null check (to_status in ('applied', 'enrolled', 'withdrawn', 'graduated', 'transferred_out')),
  effective_on  date not null,
  reason        text,
  actor_user_id uuid,
  created_at    timestamptz not null default now()
);

comment on table enrollment.status_event is
  'Append-only history of every enrolment status transition. Never updated or deleted - see trg_forbid_update/trg_forbid_delete below.';

create index status_event_tenant_enrollment_idx on enrollment.status_event (tenant_id, enrollment_id, created_at);

-- -----------------------------------------------------------------------------
-- enrollment.rollover_run
-- -----------------------------------------------------------------------------
create table enrollment.rollover_run (
  id                    uuid primary key default uuidv7(),
  tenant_id             uuid not null references tenancy.tenant (id) on delete restrict,
  from_academic_year_id uuid not null references tenancy.academic_year (id) on delete restrict,
  to_academic_year_id   uuid not null references tenancy.academic_year (id) on delete restrict,
  bulk_operation_id     uuid references audit.bulk_operation (id),
  status                text not null default 'running' check (status in ('running', 'completed', 'failed')),
  counts                jsonb not null default '{}'::jsonb,
  started_at            timestamptz not null default now(),
  completed_at          timestamptz
);

comment on table enrollment.rollover_run is
  'One row per rollOverYear REAL run - never written for a dryRun preview, which writes nothing at all (see @sms/enrollment''s RolloverService). Links to the audit.bulk_operation every row the run wrote was stamped with, so the whole run can be identified and reversed as a unit.';

create index rollover_run_tenant_idx on enrollment.rollover_run (tenant_id, started_at desc);

-- -----------------------------------------------------------------------------
-- tenancy.assert_year_writable enforcement
-- -----------------------------------------------------------------------------
create or replace function enrollment.check_enrollment_year_writable()
returns trigger
language plpgsql
as $$
begin
  perform tenancy.assert_year_writable(new.academic_year_id);
  return new;
end;
$$;

create trigger trg_assert_year_writable before insert or update on enrollment.enrollment
  for each row execute function enrollment.check_enrollment_year_writable();

create or replace function enrollment.check_status_event_year_writable()
returns trigger
language plpgsql
as $$
declare
  v_academic_year_id uuid;
begin
  select academic_year_id into v_academic_year_id from enrollment.enrollment where id = new.enrollment_id;
  if v_academic_year_id is null then
    raise exception 'enrollment.status_event: enrollment % not found', new.enrollment_id;
  end if;
  perform tenancy.assert_year_writable(v_academic_year_id);
  return new;
end;
$$;

create trigger trg_assert_year_writable before insert on enrollment.status_event
  for each row execute function enrollment.check_status_event_year_writable();

-- -----------------------------------------------------------------------------
-- enrollment.status_event is append-only
-- -----------------------------------------------------------------------------
create or replace function enrollment.forbid_status_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'enrollment.status_event is append-only history and cannot be %', lower(tg_op);
end;
$$;

create trigger trg_forbid_update before update on enrollment.status_event
  for each row execute function enrollment.forbid_status_event_mutation();
create trigger trg_forbid_delete before delete on enrollment.status_event
  for each row execute function enrollment.forbid_status_event_mutation();

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function enrollment.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_set_updated_at before update on enrollment.enrollment
  for each row execute function enrollment.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
alter table enrollment.enrollment enable row level security;
create policy enrollment_tenant_isolation on enrollment.enrollment
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table enrollment.status_event enable row level security;
create policy status_event_tenant_isolation on enrollment.status_event
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table enrollment.rollover_run enable row level security;
create policy rollover_run_tenant_isolation on enrollment.rollover_run
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Audit history
-- -----------------------------------------------------------------------------
select audit.attach_history('enrollment.enrollment');
select audit.attach_history('enrollment.status_event');
select audit.attach_history('enrollment.rollover_run');

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Migrations run as sms_owner, which owns these tables; sms_app gets no
-- default privileges on objects sms_owner creates, so every table needs
-- explicit grants. sms_app is NOBYPASSRLS and owns nothing here (arch-check.ts
-- checks 3 and 4). Neither enrollment.enrollment nor enrollment.status_event
-- grants DELETE: an enrolment record is never deleted, only transitioned
-- (recorded as a new status_event), and status_event is additionally denied
-- UPDATE - append-only, belt and suspenders alongside the triggers above.
grant usage on schema enrollment to sms_app;
grant select, insert, update on enrollment.enrollment    to sms_app;
grant select, insert         on enrollment.status_event  to sms_app;
grant select, insert         on enrollment.rollover_run  to sms_app;
