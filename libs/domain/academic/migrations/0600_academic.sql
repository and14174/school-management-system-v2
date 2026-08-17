-- =============================================================================
-- academic: academic structure - terms, grading periods, grade levels,
--           departments, subjects, courses, rooms, sections, teacher
--           assignments and student enrollments
-- =============================================================================
-- Sections exist here purely as STRUCTURE: which course, which term, which
-- campus/room, who teaches it, who is enrolled in it. No meeting times or
-- bell schedules - timetabling is a later milestone.
--
-- Two decisions worth calling out up front:
--
--   * academic.section_teacher and academic.section_enrollment are BOTH
--     effective-dated (valid_from/valid_to, both inclusive - same convention
--     as @sms/kernel's Interval and every other effective-dated table in this
--     codebase: people.person_role, access.role_assignment). Teachers change
--     mid-year and students transfer sections mid-year; last term's gradebook
--     must not change retroactively when a student later moves. Each carries
--     an exclusion constraint (btree_gist) so the same fact cannot be
--     recorded twice with overlapping date ranges - a database invariant,
--     not an application-level promise a second code path could bypass.
--   * term/section/section_enrollment writes call
--     tenancy.assert_year_writable(academic_year_id) via a BEFORE trigger, so
--     a locked/archived academic year rejects the write in the database
--     itself, not only in application code that a second code path (a
--     script, a future admin tool) could forget to check. section and
--     section_enrollment do not carry academic_year_id directly, so their
--     triggers resolve it via term_id (section) / section_id -> term_id
--     (section_enrollment) before delegating to the same function.
-- =============================================================================

create schema academic;

-- Needed for the exclusion constraints on section_teacher/section_enrollment
-- (GiST support for plain btree-comparable types) - already installed by
-- infra/postgres/init/01-roles-and-extensions.sql in every real deployment;
-- declared here too (IF NOT EXISTS) so this migration is self-contained
-- against a bare Postgres, e.g. under testcontainers - same reasoning as the
-- 0400/0500 migrations' own btree_gist declarations.
create extension if not exists btree_gist;

-- -----------------------------------------------------------------------------
-- academic.term
-- -----------------------------------------------------------------------------
create table academic.term (
  id               uuid primary key default uuidv7(),
  tenant_id        uuid not null references tenancy.tenant (id) on delete restrict,
  academic_year_id uuid not null references tenancy.academic_year (id) on delete restrict,
  name             text not null,
  starts_on        date not null,
  ends_on          date not null,
  sequence         integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, academic_year_id, name),
  constraint term_ends_after_starts check (ends_on > starts_on)
);

comment on table academic.term is
  'A term (semester/trimester) within one academic_year. Writes are gated by tenancy.assert_year_writable via trg_assert_year_writable below.';

create index term_tenant_year_idx on academic.term (tenant_id, academic_year_id);

-- -----------------------------------------------------------------------------
-- academic.grading_period
-- -----------------------------------------------------------------------------
create table academic.grading_period (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenancy.tenant (id) on delete restrict,
  term_id     uuid not null references academic.term (id) on delete restrict,
  name        text not null,
  starts_on   date not null,
  ends_on     date not null,
  sequence    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, term_id, name),
  constraint grading_period_ends_after_starts check (ends_on > starts_on)
);

create index grading_period_tenant_term_idx on academic.grading_period (tenant_id, term_id);

-- -----------------------------------------------------------------------------
-- academic.grade_level
-- -----------------------------------------------------------------------------
create table academic.grade_level (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenancy.tenant (id) on delete restrict,
  code        text not null,
  name        text not null,
  sequence    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, code)
);

create index grade_level_tenant_id_idx on academic.grade_level (tenant_id);

-- -----------------------------------------------------------------------------
-- academic.department
-- -----------------------------------------------------------------------------
create table academic.department (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenancy.tenant (id) on delete restrict,
  code        text not null,
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, code)
);

create index department_tenant_id_idx on academic.department (tenant_id);

-- -----------------------------------------------------------------------------
-- academic.subject
-- -----------------------------------------------------------------------------
create table academic.subject (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references tenancy.tenant (id) on delete restrict,
  department_id  uuid not null references academic.department (id) on delete restrict,
  code           text not null,
  name           text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, code)
);

create index subject_tenant_department_idx on academic.subject (tenant_id, department_id);

-- -----------------------------------------------------------------------------
-- academic.course
-- -----------------------------------------------------------------------------
create table academic.course (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references tenancy.tenant (id) on delete restrict,
  subject_id     uuid not null references academic.subject (id) on delete restrict,
  grade_level_id uuid not null references academic.grade_level (id) on delete restrict,
  code           text not null,
  name           text not null,
  credits        numeric,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, code)
);

create index course_tenant_subject_idx on academic.course (tenant_id, subject_id);
create index course_tenant_grade_level_idx on academic.course (tenant_id, grade_level_id);

-- -----------------------------------------------------------------------------
-- academic.room
-- -----------------------------------------------------------------------------
create table academic.room (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenancy.tenant (id) on delete restrict,
  campus_id   uuid not null references tenancy.campus (id) on delete restrict,
  code        text not null,
  name        text not null,
  capacity    integer,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, campus_id, code)
);

create index room_tenant_campus_idx on academic.room (tenant_id, campus_id);

-- -----------------------------------------------------------------------------
-- academic.section
-- -----------------------------------------------------------------------------
-- Structure only - no meeting times/bell schedule (timetabling is a later
-- milestone). Writes are gated by tenancy.assert_year_writable, resolved via
-- term_id -> term.academic_year_id (trg_assert_year_writable below).
create table academic.section (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenancy.tenant (id) on delete restrict,
  course_id   uuid not null references academic.course (id) on delete restrict,
  term_id     uuid not null references academic.term (id) on delete restrict,
  campus_id   uuid not null references tenancy.campus (id) on delete restrict,
  room_id     uuid references academic.room (id) on delete restrict,
  code        text not null,
  name        text not null,
  capacity    integer,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, term_id, code)
);

create index section_tenant_term_idx on academic.section (tenant_id, term_id);
create index section_tenant_course_idx on academic.section (tenant_id, course_id);
create index section_tenant_campus_idx on academic.section (tenant_id, campus_id);
create index section_room_id_idx on academic.section (room_id) where room_id is not null;

-- -----------------------------------------------------------------------------
-- academic.section_teacher
-- -----------------------------------------------------------------------------
-- Effective-dated: teachers change mid-year. Both endpoints inclusive, same
-- convention as people.person_role / access.role_assignment. The exclusion
-- constraint below rejects the SAME (section, person, role) being recorded
-- twice over overlapping periods - a person may still hold two DIFFERENT
-- roles on the same section at once (e.g. lead AND, separately, assistant on
-- a co-taught record would be unusual but is not what this constraint
-- forbids), or the same role on two different sections.
create table academic.section_teacher (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenancy.tenant (id) on delete restrict,
  section_id  uuid not null references academic.section (id) on delete restrict,
  person_id   uuid not null references people.person (id) on delete restrict,
  role        text not null check (role in ('lead', 'assistant')),
  valid_from  date not null default current_date,
  valid_to    date,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint section_teacher_valid_range check (valid_to is null or valid_to >= valid_from),
  constraint section_teacher_no_overlap exclude using gist (
    tenant_id with =,
    section_id with =,
    person_id with =,
    role with =,
    daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') with &&
  )
);

comment on table academic.section_teacher is
  'Which person teaches which section, from when to when (both inclusive). This is the fact @sms/access''s SECTION_SCOPE_RESOLVER port (implemented by this module) reads to answer "which sections does this user currently teach" for section-scoped permission grants.';

create index section_teacher_tenant_section_idx on academic.section_teacher (tenant_id, section_id);
create index section_teacher_tenant_person_idx on academic.section_teacher (tenant_id, person_id);

-- -----------------------------------------------------------------------------
-- academic.section_enrollment
-- -----------------------------------------------------------------------------
-- Effective-dated: students move sections mid-year, and last term's
-- gradebook must not change when they do - the OLD section_enrollment row is
-- end-dated (valid_to set), never deleted or overwritten in place, so
-- "who was in this section as of a past date" stays a fact of record.
create table academic.section_enrollment (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenancy.tenant (id) on delete restrict,
  section_id  uuid not null references academic.section (id) on delete restrict,
  person_id   uuid not null references people.person (id) on delete restrict,
  valid_from  date not null default current_date,
  valid_to    date,
  status      text not null default 'active' check (status in ('active', 'transferred', 'withdrawn', 'completed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint section_enrollment_valid_range check (valid_to is null or valid_to >= valid_from),
  constraint section_enrollment_no_overlap exclude using gist (
    tenant_id with =,
    section_id with =,
    person_id with =,
    daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') with &&
  )
);

create index section_enrollment_tenant_section_idx on academic.section_enrollment (tenant_id, section_id);
create index section_enrollment_tenant_person_idx on academic.section_enrollment (tenant_id, person_id);

-- -----------------------------------------------------------------------------
-- tenancy.assert_year_writable enforcement (term / section / section_enrollment)
-- -----------------------------------------------------------------------------
create or replace function academic.check_term_year_writable()
returns trigger
language plpgsql
as $$
begin
  perform tenancy.assert_year_writable(new.academic_year_id);
  return new;
end;
$$;

create trigger trg_assert_year_writable before insert or update on academic.term
  for each row execute function academic.check_term_year_writable();

create or replace function academic.check_section_year_writable()
returns trigger
language plpgsql
as $$
declare
  v_academic_year_id uuid;
begin
  select academic_year_id into v_academic_year_id from academic.term where id = new.term_id;
  if v_academic_year_id is null then
    raise exception 'academic.section: term % not found', new.term_id;
  end if;
  perform tenancy.assert_year_writable(v_academic_year_id);
  return new;
end;
$$;

create trigger trg_assert_year_writable before insert or update on academic.section
  for each row execute function academic.check_section_year_writable();

create or replace function academic.check_enrollment_year_writable()
returns trigger
language plpgsql
as $$
declare
  v_academic_year_id uuid;
begin
  select t.academic_year_id into v_academic_year_id
  from academic.section s
  join academic.term t on t.id = s.term_id
  where s.id = new.section_id;
  if v_academic_year_id is null then
    raise exception 'academic.section_enrollment: section % not found', new.section_id;
  end if;
  perform tenancy.assert_year_writable(v_academic_year_id);
  return new;
end;
$$;

create trigger trg_assert_year_writable before insert or update on academic.section_enrollment
  for each row execute function academic.check_enrollment_year_writable();

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function academic.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_set_updated_at before update on academic.term
  for each row execute function academic.set_updated_at();
create trigger trg_set_updated_at before update on academic.grading_period
  for each row execute function academic.set_updated_at();
create trigger trg_set_updated_at before update on academic.grade_level
  for each row execute function academic.set_updated_at();
create trigger trg_set_updated_at before update on academic.department
  for each row execute function academic.set_updated_at();
create trigger trg_set_updated_at before update on academic.subject
  for each row execute function academic.set_updated_at();
create trigger trg_set_updated_at before update on academic.course
  for each row execute function academic.set_updated_at();
create trigger trg_set_updated_at before update on academic.room
  for each row execute function academic.set_updated_at();
create trigger trg_set_updated_at before update on academic.section
  for each row execute function academic.set_updated_at();
create trigger trg_set_updated_at before update on academic.section_teacher
  for each row execute function academic.set_updated_at();
create trigger trg_set_updated_at before update on academic.section_enrollment
  for each row execute function academic.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
alter table academic.term enable row level security;
create policy term_tenant_isolation on academic.term
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table academic.grading_period enable row level security;
create policy grading_period_tenant_isolation on academic.grading_period
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table academic.grade_level enable row level security;
create policy grade_level_tenant_isolation on academic.grade_level
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table academic.department enable row level security;
create policy department_tenant_isolation on academic.department
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table academic.subject enable row level security;
create policy subject_tenant_isolation on academic.subject
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table academic.course enable row level security;
create policy course_tenant_isolation on academic.course
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table academic.room enable row level security;
create policy room_tenant_isolation on academic.room
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table academic.section enable row level security;
create policy section_tenant_isolation on academic.section
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table academic.section_teacher enable row level security;
create policy section_teacher_tenant_isolation on academic.section_teacher
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table academic.section_enrollment enable row level security;
create policy section_enrollment_tenant_isolation on academic.section_enrollment
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Audit history
-- -----------------------------------------------------------------------------
select audit.attach_history('academic.term');
select audit.attach_history('academic.grading_period');
select audit.attach_history('academic.grade_level');
select audit.attach_history('academic.department');
select audit.attach_history('academic.subject');
select audit.attach_history('academic.course');
select audit.attach_history('academic.room');
select audit.attach_history('academic.section');
select audit.attach_history('academic.section_teacher');
select audit.attach_history('academic.section_enrollment');

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Migrations run as sms_owner, which owns these tables; sms_app gets no
-- default privileges on objects sms_owner creates, so every table needs
-- explicit grants. sms_app is NOBYPASSRLS and owns nothing here (arch-check.ts
-- checks 3 and 4).
grant usage on schema academic to sms_app;
grant select, insert, update, delete on academic.term               to sms_app;
grant select, insert, update, delete on academic.grading_period      to sms_app;
grant select, insert, update, delete on academic.grade_level         to sms_app;
grant select, insert, update, delete on academic.department          to sms_app;
grant select, insert, update, delete on academic.subject             to sms_app;
grant select, insert, update, delete on academic.course              to sms_app;
grant select, insert, update, delete on academic.room                to sms_app;
grant select, insert, update, delete on academic.section             to sms_app;
grant select, insert, update, delete on academic.section_teacher     to sms_app;
grant select, insert, update, delete on academic.section_enrollment  to sms_app;
