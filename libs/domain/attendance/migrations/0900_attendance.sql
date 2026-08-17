-- =============================================================================
-- attendance: daily/per-period attendance marking, corrections and the
--             tenant-owned code catalogue teachers mark against
-- =============================================================================
-- The screen teachers touch every single day, and the first real producer of
-- domain events (attendance.marked_absent, published through the outbox -
-- see @sms/outbox's 0850 migration header).
--
-- Two decisions worth calling out up front:
--
--   * Attendance codes are CONFIGURATION, not an enum. Schools differ:
--     "authorised absence", "late - bus", "off-site sports" are all real
--     labels a school wants to use verbatim. attendance.code is a tenant-
--     owned row with a fixed `category` (present/absent/late/excused) the
--     SYSTEM reasons about (which category drives the marked_absent event,
--     which counts toward an attendance percentage), and a `label` the
--     school chooses freely. Same shape as academic.grade_level/department:
--     a closed system vocabulary of categories, an open tenant vocabulary of
--     labels.
--   * A correction is a NEW ROW, not an edit. attendance.record is a legal
--     record - "was this child marked absent on the 14th?" must stay
--     answerable regardless of any later correction. attendance.correction
--     is append-only history, same idea and same DB-level enforcement as
--     enrollment.status_event (see enrollment's 0700 migration header):
--     triggers refuse UPDATE of anything but the decision fields and refuse
--     DELETE outright, and sms_app is granted no DELETE on either table.
--
-- attendance.record's uniqueness needs a nullable column expressed correctly:
-- daily attendance (no section) and per-period attendance (tied to one
-- section_meeting) share the same table, so "one person cannot have two
-- marks for the same period" is a unique INDEX (not a plain UNIQUE table
-- constraint, which cannot take an expression) on
-- (tenant_id, person_id, date, coalesce(section_meeting_id, <nil uuid>)) -
-- Postgres treats two NULLs as DISTINCT in a unique constraint, so without
-- the coalesce a person could be marked twice for "no section" on the same
-- day. The nil UUID is an arbitrary fixed sentinel that can never collide
-- with a real uuidv7 section_meeting id (uuidv7's version nibble is never
-- 0), used purely so the expression is deterministic.
-- =============================================================================

create schema attendance;

-- -----------------------------------------------------------------------------
-- attendance.code
-- -----------------------------------------------------------------------------
create table attendance.code (
  id                uuid primary key default uuidv7(),
  tenant_id         uuid not null references tenancy.tenant (id) on delete restrict,
  code              text not null,
  label             text not null,
  category          text not null check (category in ('present', 'absent', 'late', 'excused')),
  counts_as_present boolean not null default false,
  is_default        boolean not null default false,
  requires_reason   boolean not null default false,
  sequence          integer not null default 0,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, code)
);

comment on table attendance.code is
  'Tenant-owned attendance code catalogue: a fixed system category (present/absent/late/excused - what marked_absent/attendance-percentage logic reasons about) plus a label the school chooses freely. Not an enum - schools describe absences in their own words.';

create index code_tenant_active_idx on attendance.code (tenant_id, active);

-- At most one default code per tenant - a partial unique index, not an
-- application-level "only one" promise a second write path could bypass.
-- Same technique as tenancy.campus's one-default-campus index.
create unique index code_one_default_idx on attendance.code (tenant_id) where is_default;

-- -----------------------------------------------------------------------------
-- attendance.record
-- -----------------------------------------------------------------------------
-- The CURRENT state: one row per (person, date, meeting-or-daily-slot). See
-- this file's own header for why the uniqueness below coalesces
-- section_meeting_id against a fixed sentinel rather than leaving it bare.
create table attendance.record (
  id                 uuid primary key default uuidv7(),
  tenant_id          uuid not null references tenancy.tenant (id) on delete restrict,
  person_id          uuid not null references people.person (id) on delete restrict,
  -- Nullable: daily attendance (a single per-day mark, no particular class)
  -- has no section/meeting at all.
  section_id         uuid references academic.section (id) on delete restrict,
  section_meeting_id uuid references academic.section_meeting (id) on delete restrict,
  date               date not null,
  code_id            uuid not null references attendance.code (id) on delete restrict,
  minutes_late       integer check (minutes_late is null or minutes_late >= 0),
  note               text,
  marked_by_user_id  uuid references identity.user (id) on delete restrict,
  marked_at          timestamptz not null default now(),
  constraint record_section_meeting_requires_section
    check (section_meeting_id is null or section_id is not null)
);

comment on table attendance.record is
  'The current state of one person''s attendance for one date (and, for period attendance, one section_meeting). A correction never edits this row in place past the configurable lock window (see @sms/attendance''s AttendanceRecordService) - it is applied only through an APPROVED attendance.correction, so "what did we mark them on the 14th" and "what is it now" both stay answerable.';

-- "One person cannot have two marks for the same period" (or, for
-- section_meeting_id null, two daily marks on the same day) - see this
-- file's own header comment on why coalesce needs a fixed sentinel here.
create unique index record_person_date_meeting_key
  on attendance.record (tenant_id, person_id, date, coalesce(section_meeting_id, '00000000-0000-0000-0000-000000000000'::uuid));

create index record_tenant_section_meeting_date_idx on attendance.record (tenant_id, section_meeting_id, date);
create index record_tenant_person_date_idx on attendance.record (tenant_id, person_id, date);
create index record_tenant_code_idx on attendance.record (tenant_id, code_id);

-- -----------------------------------------------------------------------------
-- attendance.correction
-- -----------------------------------------------------------------------------
-- Append-only, same shape and same DB-enforced invariant as
-- enrollment.status_event (see enrollment's 0700 migration): the ONLY way to
-- change a record locked past the free-edit window (see
-- AttendanceRecordService's own comment on the lock window). "Decision
-- fields" (status/decided_by_user_id/decided_at/reason - see
-- trg_forbid_correction_update below) are the one thing an UPDATE may touch;
-- everything else about a correction request is immutable once written.
create table attendance.correction (
  id                   uuid primary key default uuidv7(),
  tenant_id            uuid not null references tenancy.tenant (id) on delete restrict,
  record_id            uuid not null references attendance.record (id) on delete restrict,
  from_code_id         uuid not null references attendance.code (id) on delete restrict,
  to_code_id           uuid not null references attendance.code (id) on delete restrict,
  reason               text,
  requested_by_user_id uuid references identity.user (id) on delete restrict,
  status               text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by_user_id   uuid references identity.user (id) on delete restrict,
  decided_at           timestamptz,
  created_at           timestamptz not null default now(),
  constraint correction_decision_consistency check (
    (status = 'pending' and decided_at is null and decided_by_user_id is null)
    or
    (status <> 'pending' and decided_at is not null)
  )
);

comment on table attendance.correction is
  'Append-only request to change a locked attendance.record from one code to another. Never updated or deleted except the decision fields (status/decided_by_user_id/decided_at/reason) - see trg_forbid_correction_update/trg_forbid_correction_delete below.';

create index correction_tenant_record_idx on attendance.correction (tenant_id, record_id);
create index correction_tenant_status_idx on attendance.correction (tenant_id, status);

-- -----------------------------------------------------------------------------
-- attendance.submission
-- -----------------------------------------------------------------------------
-- Idempotency ledger for markSession: teachers mark attendance on flaky
-- school wifi and from phones, and the same batch WILL be submitted twice.
-- Unique (tenant_id, idempotency_key) is what AttendanceRecordService.
-- markSession's ON CONFLICT DO NOTHING targets to detect - and no-op - a
-- replay, rather than writing the batch a second time.
create table attendance.submission (
  id                  uuid primary key default uuidv7(),
  tenant_id           uuid not null references tenancy.tenant (id) on delete restrict,
  idempotency_key     text not null,
  section_meeting_id  uuid not null references academic.section_meeting (id) on delete restrict,
  date                date not null,
  submitted_by_user_id uuid references identity.user (id) on delete restrict,
  record_count        integer not null default 0,
  created_at          timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

comment on table attendance.submission is
  'One row per markSession call that actually wrote (a replayed idempotency_key writes nothing further - see AttendanceRecordService.markSession). What listUnmarkedSessions checks for absence of, per (section_meeting_id, date).';

create index submission_tenant_meeting_date_idx on attendance.submission (tenant_id, section_meeting_id, date);

-- -----------------------------------------------------------------------------
-- attendance.correction is append-only except for its decision fields
-- -----------------------------------------------------------------------------
create or replace function attendance.forbid_correction_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'attendance.correction is append-only history and cannot be deleted';
  end if;

  -- UPDATE: only status/decided_by_user_id/decided_at/reason (the decision -
  -- see this file's own header) may change; everything else about the
  -- original request is immutable.
  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.record_id is distinct from old.record_id
     or new.from_code_id is distinct from old.from_code_id
     or new.to_code_id is distinct from old.to_code_id
     or new.requested_by_user_id is distinct from old.requested_by_user_id
     or new.created_at is distinct from old.created_at
  then
    raise exception 'attendance.correction: only status/decided_by_user_id/decided_at/reason may be updated - the request itself is append-only history';
  end if;

  return new;
end;
$$;

create trigger trg_forbid_correction_update before update on attendance.correction
  for each row execute function attendance.forbid_correction_mutation();
create trigger trg_forbid_correction_delete before delete on attendance.correction
  for each row execute function attendance.forbid_correction_mutation();

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function attendance.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_set_updated_at before update on attendance.code
  for each row execute function attendance.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
alter table attendance.code enable row level security;
create policy code_tenant_isolation on attendance.code
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table attendance.record enable row level security;
create policy record_tenant_isolation on attendance.record
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table attendance.correction enable row level security;
create policy correction_tenant_isolation on attendance.correction
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table attendance.submission enable row level security;
create policy submission_tenant_isolation on attendance.submission
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Audit history
-- -----------------------------------------------------------------------------
select audit.attach_history('attendance.code');
select audit.attach_history('attendance.record');
select audit.attach_history('attendance.correction');
select audit.attach_history('attendance.submission');

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Migrations run as sms_owner, which owns these tables; sms_app gets no
-- default privileges on objects sms_owner creates, so every table needs
-- explicit grants. sms_app is NOBYPASSRLS and owns nothing here (arch-check.ts
-- checks 3 and 4).
--
-- attendance.code: no DELETE - a code referenced by history stays referenced
-- (FK restrict would block it anyway); deactivate via `active = false`.
-- attendance.record: no DELETE - a legal record is never removed, only
-- corrected (a new attendance.correction row) or freely edited within the
-- lock window (an UPDATE, still this same row - see AttendanceRecordService).
-- attendance.correction: UPDATE is granted (the decision has to land
-- somewhere), but trg_forbid_correction_update above restricts it to the
-- decision fields, and DELETE is granted to nobody - belt and suspenders
-- alongside trg_forbid_correction_delete, same posture as enrollment.
-- status_event's grants.
-- attendance.submission: INSERT/SELECT only - a pure idempotency ledger,
-- write-once.
grant usage on schema attendance to sms_app;
grant select, insert, update on attendance.code        to sms_app;
grant select, insert, update on attendance.record      to sms_app;
grant select, insert, update on attendance.correction  to sms_app;
grant select, insert         on attendance.submission  to sms_app;
