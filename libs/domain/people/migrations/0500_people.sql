-- =============================================================================
-- people: one person, one record
-- =============================================================================
-- The single most load-bearing decision in this product: a student who later
-- becomes a parent of another student, or a staff member who is also a
-- guardian, is ONE row in `people.person` with several `people.person_role`
-- rows layered over it - never a separate "student" table and "guardian"
-- table that both happen to describe the same human. Splitting by role is
-- the obvious-looking design that breaks the moment a real person plays more
-- than one role at once (which happens constantly at a real school), because
-- now there is no single place to attach a household, a medical alert, or an
-- identity.membership login.
--
-- Two more decisions worth calling out up front:
--
--   * Every effective-dated table here (`person_role`, `household_member`)
--     uses the same inclusive/inclusive `valid_from`/`valid_to` convention as
--     @sms/kernel's `Interval` and access.role_assignment (0400 migration),
--     and the same exclusion-constraint enforcement for "no two overlapping
--     identical facts" - a database invariant, not an application-level
--     promise a second code path could bypass.
--   * A merge NEVER deletes the losing row (people.person.merged_into_id is
--     set instead - see people.person_merge below). Old ids appear in URLs,
--     exports and external integrations; they must keep resolving forever.
-- =============================================================================

create schema people;

-- Needed for the exclusion constraints on person_role/household_member
-- (GiST support for plain btree-comparable types) and for fuzzy duplicate
-- search (trigram similarity) / normalised match keys (accent folding).
-- Already installed by infra/postgres/init/01-roles-and-extensions.sql in
-- every real deployment; declared here too (IF NOT EXISTS) so this migration
-- is self-contained against a bare Postgres, e.g. under testcontainers - same
-- reasoning as the 0400 migration's own btree_gist declaration.
create extension if not exists btree_gist;
create extension if not exists pg_trgm;
create extension if not exists unaccent;

-- -----------------------------------------------------------------------------
-- people.person
-- -----------------------------------------------------------------------------
create table people.person (
  id               uuid primary key default uuidv7(),
  tenant_id        uuid not null references tenancy.tenant (id) on delete restrict,
  given_name       text not null,
  family_name      text not null,
  preferred_name   text,
  date_of_birth    date,
  gender           text,
  -- No foreign key: the files/documents module does not exist yet. A bare,
  -- unconstrained uuid a caller may set (or not) - nothing reads it as
  -- authoritative until that module lands and adds the FK, exactly like
  -- identity.membership.person_id was left bare ahead of this module (see
  -- the 0301 migration comment, and 0501_link_membership_to_person.sql below
  -- which closes that particular loop).
  photo_file_id    uuid,
  custom_fields    jsonb not null default '{}'::jsonb,
  -- Set once this row loses a merge (see people.person_merge). NEVER
  -- deleted - a tombstone, not a removal - see the migration header.
  merged_into_id   uuid references people.person (id) on delete restrict,
  -- Maintained by trg_set_person_match_key below, not a generated column:
  -- unaccent() is STABLE (it depends on a text-search dictionary lookup),
  -- and Postgres generated columns require an IMMUTABLE expression. A
  -- trigger-maintained column gets the same "always in sync, cannot be
  -- forgotten on a write path" property without fighting that restriction.
  -- name_normalized: lower-cased, accent-folded "given family" - the basis
  -- for both exact match-key equality and trigram fuzzy search.
  name_normalized  text,
  -- match_key: name_normalized + date_of_birth - two people sharing this
  -- exact string are near-certainly the same human (same name, same
  -- birthdate). findPotentialDuplicates treats an exact match_key hit as
  -- the strongest signal; trigram similarity on name_normalized alone is
  -- the fuzzy fallback for typos/nicknames.
  match_key        text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint person_not_merged_into_self check (merged_into_id is null or merged_into_id <> id)
);

comment on table people.person is
  'One row per human the tenant has a relationship with, in ANY role (student, guardian, staff, alumni - see person_role). merged_into_id set = this row lost a merge and is a tombstone; see people.person_merge and resolvePerson().';

create index person_tenant_id_idx on people.person (tenant_id);
create index person_match_key_idx on people.person (tenant_id, match_key);
create index person_name_trgm_idx on people.person using gin (name_normalized gin_trgm_ops);
create index person_custom_fields_idx on people.person using gin (custom_fields jsonb_path_ops);
-- A tombstone's merged_into_id is the one thing every caller needs to be
-- able to look up fast (resolvePerson runs on every getPerson).
create index person_merged_into_id_idx on people.person (merged_into_id) where merged_into_id is not null;

create or replace function people.set_person_match_key()
returns trigger
language plpgsql
as $$
begin
  new.name_normalized := lower(unaccent(coalesce(new.given_name, '') || ' ' || coalesce(new.family_name, '')));
  new.match_key := new.name_normalized || '|' || coalesce(new.date_of_birth::text, '');
  return new;
end;
$$;

create trigger trg_set_person_match_key before insert or update on people.person
  for each row execute function people.set_person_match_key();

-- -----------------------------------------------------------------------------
-- people.person_role
-- -----------------------------------------------------------------------------
-- Effective-dated: a person's roles change over time (a student graduates
-- and later becomes alumni; a parent later joins staff). Both endpoints
-- inclusive, matching @sms/kernel's Interval.
create table people.person_role (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenancy.tenant (id) on delete restrict,
  person_id   uuid not null references people.person (id) on delete restrict,
  role        text not null check (role in ('student', 'guardian', 'staff', 'alumni')),
  campus_id   uuid references tenancy.campus (id) on delete restrict,
  valid_from  date not null default current_date,
  valid_to    date,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint person_role_valid_range check (valid_to is null or valid_to >= valid_from),
  -- Prevents the same (person, role) combination from being active twice
  -- over overlapping periods - same shape as access.role_assignment_no_
  -- overlap (0400 migration). Deliberately keyed on (person_id, role), not
  -- also campus_id: "identical roles" means the same role type held twice
  -- at once, not a role held at two campuses simultaneously being treated
  -- as different facts.
  constraint person_role_no_overlap exclude using gist (
    tenant_id with =,
    person_id with =,
    role with =,
    daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') with &&
  )
);

comment on table people.person_role is
  'Which role(s) a person holds, from when to when. A person may hold several roles at once (e.g. staff AND guardian) - only the SAME role overlapping itself is rejected.';

create index person_role_tenant_person_idx on people.person_role (tenant_id, person_id);
create index person_role_campus_id_idx on people.person_role (campus_id) where campus_id is not null;

-- -----------------------------------------------------------------------------
-- people.household
-- -----------------------------------------------------------------------------
create table people.household (
  id              uuid primary key default uuidv7(),
  tenant_id       uuid not null references tenancy.tenant (id) on delete restrict,
  name            text not null,
  primary_address jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index household_tenant_id_idx on people.household (tenant_id);

-- -----------------------------------------------------------------------------
-- people.household_member
-- -----------------------------------------------------------------------------
create table people.household_member (
  id                  uuid primary key default uuidv7(),
  tenant_id           uuid not null references tenancy.tenant (id) on delete restrict,
  household_id        uuid not null references people.household (id) on delete cascade,
  person_id           uuid not null references people.person (id) on delete restrict,
  is_primary_contact  boolean not null default false,
  valid_from          date not null default current_date,
  valid_to            date,
  constraint household_member_valid_range check (valid_to is null or valid_to >= valid_from),
  constraint household_member_no_overlap exclude using gist (
    tenant_id with =,
    household_id with =,
    person_id with =,
    daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') with &&
  )
);

create index household_member_tenant_household_idx on people.household_member (tenant_id, household_id);
create index household_member_person_id_idx on people.household_member (person_id);

-- -----------------------------------------------------------------------------
-- people.relationship
-- -----------------------------------------------------------------------------
-- Custody and communication restrictions are legally significant - who may
-- pick a child up, who has custody, who may be contacted - so they are
-- first-class typed columns, never free text a UI could get wrong or a
-- report could fail to surface.
create table people.relationship (
  id                  uuid primary key default uuidv7(),
  tenant_id           uuid not null references tenancy.tenant (id) on delete restrict,
  from_person_id      uuid not null references people.person (id) on delete restrict,
  to_person_id        uuid not null references people.person (id) on delete restrict,
  type                text not null check (type in ('parent', 'guardian', 'sibling', 'emergency_contact', 'authorized_pickup', 'other')),
  has_custody         boolean not null default false,
  may_pickup          boolean not null default false,
  may_receive_comms   boolean not null default false,
  priority            integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint relationship_not_self check (from_person_id <> to_person_id),
  unique (tenant_id, from_person_id, to_person_id, type)
);

comment on table people.relationship is
  'A directed relationship from one person to another (e.g. from_person is the parent OF to_person). has_custody/may_pickup/may_receive_comms are legally significant flags, not free text.';

create index relationship_tenant_from_idx on people.relationship (tenant_id, from_person_id);
create index relationship_tenant_to_idx on people.relationship (tenant_id, to_person_id);

-- -----------------------------------------------------------------------------
-- people.person_identifier
-- -----------------------------------------------------------------------------
-- Never overload one column with several id kinds - a student number, a
-- national id, and "previous school" reference number are different facts
-- with different uniqueness rules, so each is its own row.
create table people.person_identifier (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenancy.tenant (id) on delete restrict,
  person_id   uuid not null references people.person (id) on delete restrict,
  type        text not null check (type in ('student_number', 'national_id', 'previous_school', 'other')),
  value       text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, type, value)
);

create index person_identifier_tenant_person_idx on people.person_identifier (tenant_id, person_id);

-- -----------------------------------------------------------------------------
-- people.person_alert
-- -----------------------------------------------------------------------------
-- Medical and safeguarding alerts are read through @sms/access's separate
-- permissions (people.student:read_medical / people.student:read_safeguarding),
-- never bundled with an ordinary profile read - see @sms/access's field
-- registry and this module's own AlertService, which filters rows by
-- category against the caller's compiled ability before they ever leave the
-- service layer.
create table people.person_alert (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenancy.tenant (id) on delete restrict,
  person_id   uuid not null references people.person (id) on delete restrict,
  category    text not null check (category in ('medical', 'safeguarding', 'access', 'other')),
  severity    text not null check (severity in ('info', 'warning', 'critical')),
  summary     text not null,
  detail      text,
  valid_from  date not null default current_date,
  valid_to    date,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint person_alert_valid_range check (valid_to is null or valid_to >= valid_from)
);

create index person_alert_tenant_person_idx on people.person_alert (tenant_id, person_id);
create index person_alert_category_idx on people.person_alert (category);

-- -----------------------------------------------------------------------------
-- people.person_merge
-- -----------------------------------------------------------------------------
-- The permanent record of a merge - who survived, who was absorbed, who did
-- it, why, and (in payload) enough of what moved to explain the merge later.
-- merged_person_id is NOT unique: a tombstone can only ever be the losing
-- side of exactly one merge in practice (PeopleContract.mergePersons refuses
-- to merge an already-merged record - see MergeService), but this table
-- doesn't need to be the thing that enforces that; people.person.merged_
-- into_id already makes a second merge of the same loser a no-op query away
-- from being caught.
create table people.person_merge (
  id                    uuid primary key default uuidv7(),
  tenant_id             uuid not null references tenancy.tenant (id) on delete restrict,
  surviving_person_id   uuid not null references people.person (id) on delete restrict,
  merged_person_id      uuid not null references people.person (id) on delete restrict,
  merged_by_user_id     uuid not null references identity.user (id) on delete restrict,
  reason                text,
  merged_at             timestamptz not null default now(),
  payload               jsonb not null default '{}'::jsonb,
  constraint person_merge_not_self check (surviving_person_id <> merged_person_id)
);

create index person_merge_tenant_idx on people.person_merge (tenant_id);
create index person_merge_surviving_idx on people.person_merge (surviving_person_id);
create index person_merge_merged_idx on people.person_merge (merged_person_id);

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function people.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_set_updated_at before update on people.person
  for each row execute function people.set_updated_at();
create trigger trg_set_updated_at before update on people.person_role
  for each row execute function people.set_updated_at();
create trigger trg_set_updated_at before update on people.household
  for each row execute function people.set_updated_at();
create trigger trg_set_updated_at before update on people.relationship
  for each row execute function people.set_updated_at();
create trigger trg_set_updated_at before update on people.person_identifier
  for each row execute function people.set_updated_at();
create trigger trg_set_updated_at before update on people.person_alert
  for each row execute function people.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
alter table people.person enable row level security;
create policy person_tenant_isolation on people.person
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table people.person_role enable row level security;
create policy person_role_tenant_isolation on people.person_role
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table people.household enable row level security;
create policy household_tenant_isolation on people.household
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table people.household_member enable row level security;
create policy household_member_tenant_isolation on people.household_member
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table people.relationship enable row level security;
create policy relationship_tenant_isolation on people.relationship
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table people.person_identifier enable row level security;
create policy person_identifier_tenant_isolation on people.person_identifier
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table people.person_alert enable row level security;
create policy person_alert_tenant_isolation on people.person_alert
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table people.person_merge enable row level security;
create policy person_merge_tenant_isolation on people.person_merge
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Audit history
-- -----------------------------------------------------------------------------
select audit.attach_history('people.person');
select audit.attach_history('people.person_role');
select audit.attach_history('people.household');
select audit.attach_history('people.household_member');
select audit.attach_history('people.relationship');
select audit.attach_history('people.person_identifier');
select audit.attach_history('people.person_alert');
select audit.attach_history('people.person_merge');

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Migrations run as sms_owner, which owns these tables; sms_app gets no
-- default privileges on objects sms_owner creates, so every table needs
-- explicit grants. sms_app is NOBYPASSRLS and owns nothing here (arch-check.ts
-- checks 3 and 4).
grant usage on schema people to sms_app;
grant select, insert, update           on people.person             to sms_app;
grant select, insert, update, delete   on people.person_role         to sms_app;
grant select, insert, update, delete   on people.household           to sms_app;
grant select, insert, update, delete   on people.household_member    to sms_app;
grant select, insert, update, delete   on people.relationship        to sms_app;
grant select, insert, update, delete   on people.person_identifier   to sms_app;
grant select, insert, update, delete   on people.person_alert        to sms_app;
grant select, insert                   on people.person_merge        to sms_app;
