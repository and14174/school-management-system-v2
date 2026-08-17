-- =============================================================================
-- academic (0610): scheduling / timetabling
--           bell schedules, periods, section meetings (when a section
--           actually meets: period + day-of-week + room, effective-dated),
--           and substitutions.
-- =============================================================================
-- This is the M4 layer on top of 0600's structural sections: 0600 deliberately
-- has no meeting times ("timetabling is a later milestone" - see its header).
-- Three decisions worth calling out:
--
--   * Conflict detection belongs in the DATABASE, not only in application
--     code. A teacher cannot be in two rooms at once and a room cannot hold
--     two sections at once - if that were enforced only in a service method,
--     the first bulk import, admin script or concurrent request that skips
--     it creates a double-booking nobody notices until a Tuesday morning.
--     The ROOM conflict is expressible as a single exclusion constraint
--     (room_id/period_id/day_of_week, over overlapping effective-dated
--     ranges - btree_gist, same technique as 0600's section_teacher/
--     section_enrollment). The TEACHER conflict cannot be: which person
--     teaches a section is a separate, also effective-dated fact
--     (section_teacher), reached only by joining through it - so that one is
--     a BEFORE INSERT OR UPDATE trigger instead. Both fire regardless of
--     which code path wrote the row - a script or a future admin tool gets
--     exactly the same protection application code does.
--   * academic.section_meeting is effective-dated (valid_from/valid_to, both
--     inclusive - same convention as section_teacher/section_enrollment
--     above it and @sms/kernel's Interval), because timetables change
--     mid-year: a room gets swapped, a period gets renumbered, a section
--     moves from Tuesday to Wednesday. The OLD meeting is end-dated, never
--     deleted or overwritten in place, so "what did the timetable look like
--     on this past date" (a substitution log, a historical attendance
--     report) stays a fact of record.
--   * Room CAPACITY is a WARNING, not a hard failure - see
--     check_section_meeting_room_capacity()'s own comment below for why.
-- =============================================================================

-- Already installed by 0600 in every real deployment; declared here too
-- (IF NOT EXISTS) so this migration is self-contained against a bare
-- Postgres, e.g. under testcontainers - same reasoning as 0600's own
-- btree_gist declaration.
create extension if not exists btree_gist;

-- -----------------------------------------------------------------------------
-- academic.bell_schedule
-- -----------------------------------------------------------------------------
create table academic.bell_schedule (
  id                uuid primary key default uuidv7(),
  tenant_id         uuid not null references tenancy.tenant (id) on delete restrict,
  campus_id         uuid not null references tenancy.campus (id) on delete restrict,
  academic_year_id  uuid not null references tenancy.academic_year (id) on delete restrict,
  name              text not null,
  is_default        boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, campus_id, academic_year_id, name)
);

comment on table academic.bell_schedule is
  'A named set of periods for one campus/academic year (e.g. "Standard Week", "Exam Week"). academic.period rows belong to exactly one bell_schedule.';

create index bell_schedule_tenant_campus_year_idx on academic.bell_schedule (tenant_id, campus_id, academic_year_id);

-- At most one default bell schedule per (tenant, campus, year) - a partial
-- unique index, not an application-level "only one" promise a second write
-- path could bypass. Same technique as tenancy.campus's one-default-campus
-- and tenancy.academic_year's one-is_current-year indexes.
create unique index bell_schedule_one_default_idx on academic.bell_schedule (tenant_id, campus_id, academic_year_id) where is_default;

-- -----------------------------------------------------------------------------
-- academic.period
-- -----------------------------------------------------------------------------
create table academic.period (
  id                uuid primary key default uuidv7(),
  tenant_id         uuid not null references tenancy.tenant (id) on delete restrict,
  bell_schedule_id  uuid not null references academic.bell_schedule (id) on delete restrict,
  name              text not null,
  sequence          integer not null default 0,
  starts_at         time not null,
  ends_at           time not null,
  is_instructional  boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (bell_schedule_id, sequence),
  constraint period_ends_after_starts check (ends_at > starts_at)
);

comment on table academic.period is
  'One slot in a bell_schedule (e.g. "Period 1", "Registration", "Lunch" with is_instructional = false).';

create index period_tenant_bell_schedule_idx on academic.period (tenant_id, bell_schedule_id);

-- -----------------------------------------------------------------------------
-- academic.section_meeting
-- -----------------------------------------------------------------------------
-- When a section actually meets. Effective-dated (valid_from/valid_to, both
-- inclusive) - see this file's own header for why. day_of_week is ISO 1-7
-- (1 = Monday ... 7 = Sunday, matching date-fns/ISO 8601, already this
-- codebase's date convention - see @sms/kernel's temporal.ts).
create table academic.section_meeting (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenancy.tenant (id) on delete restrict,
  section_id  uuid not null references academic.section (id) on delete restrict,
  period_id   uuid not null references academic.period (id) on delete restrict,
  day_of_week smallint not null check (day_of_week between 1 and 7),
  room_id     uuid references academic.room (id) on delete restrict,
  valid_from  date not null default current_date,
  valid_to    date,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint section_meeting_valid_range check (valid_to is null or valid_to >= valid_from),

  -- ROOM CONFLICT: two meetings cannot share (room_id, period_id,
  -- day_of_week) over overlapping validity ranges. A meeting with no room
  -- (room_id is null - e.g. a virtual/independent-study period) is exempt
  -- via the partial WHERE clause, same as 0600's section.room_id partial
  -- index: "no room assigned" cannot conflict with anything.
  constraint section_meeting_room_no_overlap exclude using gist (
    tenant_id with =,
    room_id with =,
    period_id with =,
    day_of_week with =,
    daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') with &&
  ) where (room_id is not null)
);

comment on table academic.section_meeting is
  'When a section meets: which period, which day (ISO 1-7), which room, effective-dated. The room conflict above is a database constraint; the teacher conflict (below, via section_teacher) needs a trigger because it is reached through a second effective-dated table, not expressible as a single exclusion constraint.';

create index section_meeting_tenant_section_idx on academic.section_meeting (tenant_id, section_id);
create index section_meeting_tenant_period_idx on academic.section_meeting (tenant_id, period_id);
create index section_meeting_room_idx on academic.section_meeting (room_id) where room_id is not null;

-- -----------------------------------------------------------------------------
-- TEACHER CONFLICT: a trigger, not an exclusion constraint
-- -----------------------------------------------------------------------------
-- "Which person teaches this section" is section_teacher, a SEPARATE
-- effective-dated table (0600) - a single exclusion constraint on
-- section_meeting alone cannot see it. This trigger walks:
--   NEW's section's currently (over NEW's own validity window) assigned
--   teacher(s) -> any OTHER section_meeting at the same (period_id,
--   day_of_week) whose own validity overlaps NEW's -> that OTHER meeting's
--   section's teacher(s), again resolved over NEW's validity window -> if
--   the same person appears on both sides, that person would be teaching
--   two sections in the same period on the same day on an overlapping date
--   range: reject.
--
-- Anchoring every overlap check on NEW's own [valid_from, valid_to] (rather
-- than trying to compute the pairwise intersection of four independent
-- ranges) is deliberately the simpler, slightly more conservative check: it
-- catches every real conflict a straightforward schedule edit can produce,
-- at the cost of a false positive only in the exotic case of a teacher
-- re-assignment and a room/period change landing on non-overlapping
-- sub-windows within the same request - an edge case worth revisiting if it
-- ever shows up in practice, not one worth the complexity now.
create or replace function academic.check_section_meeting_teacher_conflict()
returns trigger
language plpgsql
as $$
declare
  v_conflict record;
begin
  select st.person_id as person_id, sm2.id as other_meeting_id, sm2.section_id as other_section_id
    into v_conflict
  from academic.section_teacher st
  join academic.section_meeting sm2
    on sm2.tenant_id = new.tenant_id
   and sm2.id <> new.id
   and sm2.section_id <> new.section_id
   and sm2.period_id = new.period_id
   and sm2.day_of_week = new.day_of_week
   and daterange(sm2.valid_from, coalesce(sm2.valid_to, 'infinity'::date), '[]')
       && daterange(new.valid_from, coalesce(new.valid_to, 'infinity'::date), '[]')
  join academic.section_teacher st2
    on st2.tenant_id = sm2.tenant_id
   and st2.section_id = sm2.section_id
   and st2.person_id = st.person_id
   and daterange(st2.valid_from, coalesce(st2.valid_to, 'infinity'::date), '[]')
       && daterange(new.valid_from, coalesce(new.valid_to, 'infinity'::date), '[]')
  where st.tenant_id = new.tenant_id
    and st.section_id = new.section_id
    and daterange(st.valid_from, coalesce(st.valid_to, 'infinity'::date), '[]')
        && daterange(new.valid_from, coalesce(new.valid_to, 'infinity'::date), '[]')
  limit 1;

  if found then
    raise exception 'academic.section_meeting: person % already teaches section % in this period/day (meeting %), overlapping the requested date range - cannot also teach section %',
      v_conflict.person_id, v_conflict.other_section_id, v_conflict.other_meeting_id, new.section_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger trg_check_teacher_conflict before insert or update on academic.section_meeting
  for each row execute function academic.check_section_meeting_teacher_conflict();

-- -----------------------------------------------------------------------------
-- ROOM CAPACITY: a WARNING, not a hard failure
-- -----------------------------------------------------------------------------
-- Deliberately RAISE WARNING, not an exception. Over-capacity is common and
-- legitimate in real schools: a popular elective runs a few students over
-- its "official" room capacity, a room's furniture gets reconfigured without
-- anyone updating the capacity column, a temporary combined class exceeds
-- the number on paper. A hard failure here would block a legitimate,
-- already-approved scheduling decision on a number that is frequently stale
-- or advisory rather than a physical fire-code limit - and the person
-- fixing the schedule at 11pm the night before term starts is not in a
-- position to relitigate the room's stated capacity. A WARNING surfaces the
-- condition (visible in Postgres logs, and to any client that reads NOTICE/
-- WARNING messages off the connection) without blocking the write, which is
-- the same "flag it, don't block it" posture this module already takes
-- elsewhere for legitimately common exceptions.
create or replace function academic.check_section_meeting_room_capacity()
returns trigger
language plpgsql
as $$
declare
  v_capacity integer;
  v_enrolled integer;
begin
  if new.room_id is null then
    return new;
  end if;

  select capacity into v_capacity from academic.room where id = new.room_id;
  if v_capacity is null then
    return new; -- no capacity recorded for this room - nothing to compare against
  end if;

  select count(*) into v_enrolled
  from academic.section_enrollment
  where tenant_id = new.tenant_id
    and section_id = new.section_id
    and valid_from <= current_date
    and (valid_to is null or valid_to >= current_date);

  if v_enrolled > v_capacity then
    raise warning 'academic.section_meeting: section % has % currently enrolled student(s) but room % (meeting %) has a stated capacity of %.',
      new.section_id, v_enrolled, new.room_id, new.id, v_capacity;
  end if;

  return new;
end;
$$;

create trigger trg_check_room_capacity before insert or update on academic.section_meeting
  for each row execute function academic.check_section_meeting_room_capacity();

-- -----------------------------------------------------------------------------
-- academic.substitution
-- -----------------------------------------------------------------------------
create table academic.substitution (
  id                    uuid primary key default uuidv7(),
  tenant_id             uuid not null references tenancy.tenant (id) on delete restrict,
  section_meeting_id    uuid not null references academic.section_meeting (id) on delete restrict,
  date                  date not null,
  absent_person_id      uuid not null references people.person (id) on delete restrict,
  substitute_person_id  uuid not null references people.person (id) on delete restrict,
  reason                text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (section_meeting_id, date)
);

comment on table academic.substitution is
  'One meeting, one date, covered by someone other than the usually-assigned teacher. Unique per (section_meeting_id, date) - a given meeting occurrence has at most one substitute of record.';

create index substitution_tenant_meeting_idx on academic.substitution (tenant_id, section_meeting_id);
create index substitution_tenant_date_idx on academic.substitution (tenant_id, date);
create index substitution_absent_person_idx on academic.substitution (tenant_id, absent_person_id);
create index substitution_substitute_person_idx on academic.substitution (tenant_id, substitute_person_id);

-- -----------------------------------------------------------------------------
-- updated_at maintenance (reuses academic.set_updated_at() from 0600)
-- -----------------------------------------------------------------------------
create trigger trg_set_updated_at before update on academic.bell_schedule
  for each row execute function academic.set_updated_at();
create trigger trg_set_updated_at before update on academic.period
  for each row execute function academic.set_updated_at();
create trigger trg_set_updated_at before update on academic.section_meeting
  for each row execute function academic.set_updated_at();
create trigger trg_set_updated_at before update on academic.substitution
  for each row execute function academic.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
alter table academic.bell_schedule enable row level security;
create policy bell_schedule_tenant_isolation on academic.bell_schedule
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table academic.period enable row level security;
create policy period_tenant_isolation on academic.period
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table academic.section_meeting enable row level security;
create policy section_meeting_tenant_isolation on academic.section_meeting
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table academic.substitution enable row level security;
create policy substitution_tenant_isolation on academic.substitution
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Audit history
-- -----------------------------------------------------------------------------
select audit.attach_history('academic.bell_schedule');
select audit.attach_history('academic.period');
select audit.attach_history('academic.section_meeting');
select audit.attach_history('academic.substitution');

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Schema usage on `academic` was already granted in 0600; only the new
-- tables need their own explicit grants (sms_owner owns them, sms_app gets
-- no default privileges on objects it does not own).
grant select, insert, update, delete on academic.bell_schedule     to sms_app;
grant select, insert, update, delete on academic.period            to sms_app;
grant select, insert, update, delete on academic.section_meeting   to sms_app;
grant select, insert, update, delete on academic.substitution      to sms_app;
