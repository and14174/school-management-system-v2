-- =============================================================================
-- tenancy: schools/organisations, campuses, and academic years
-- =============================================================================
-- Every other module hangs its rows off `tenancy.tenant` (directly or, for
-- campus-scoped data, off `tenancy.campus`) and reads `tenancy.academic_year`
-- to know which school year a record belongs to. This lands right after
-- `audit` so every table below can attach history from the moment it exists.
-- =============================================================================

create schema tenancy;

-- -----------------------------------------------------------------------------
-- tenancy.tenant
-- -----------------------------------------------------------------------------
-- A tenant IS the isolation boundary, not a row scoped by one - there is no
-- "other" tenant it could point to, so it cannot carry a *foreign* tenant_id.
-- `pnpm check:db` (libs/shared/db/src/arch-check.ts) treats any module table
-- with no tenant_id column as needing an explicit `@global` comment marker,
-- meaning "shared reference data every tenant may read". That is the wrong
-- exemption for this table: a school's own name, branding and feature flags
-- must never be readable by a different school, so `@global` (which implies
-- no RLS isolation at all) would be a real leak, not just a lint failure to
-- silence.
--
-- The fix used here: tenant_id is a generated column that always equals the
-- row's own id (`generated always as (id) stored`), so it can never be set to
-- (or updated to) anything else - there is no INSERT/UPDATE path that could
-- point it at another tenant. RLS is then keyed on that column exactly like
-- every other table: `tenant_id = current_setting('app.tenant_id')`. A
-- request scoped to tenant A can only ever satisfy that predicate for A's own
-- row; B's row has tenant_id = B and is invisible. This is honest isolation,
-- not a weakened check - `pnpm check:db`'s RLS rule is satisfied for the
-- reason it exists (has_tenant_id + rls_enabled + a real policy), not by
-- gaming the `@global` escape hatch.
create table tenancy.tenant (
  id            uuid primary key default uuidv7(),
  tenant_id     uuid not null generated always as (id) stored,
  slug          text not null unique,
  name          text not null,
  legal_name    text,
  locale        text not null default 'en',
  timezone      text not null default 'UTC',
  currency      text not null default 'USD',
  status        text not null default 'trial' check (status in ('active', 'trial', 'suspended')),
  branding      jsonb not null default '{}'::jsonb,
  feature_flags jsonb not null default '{}'::jsonb,
  terminology   jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table tenancy.tenant is
  'One row per school/organisation. tenant_id is generated = id (see migration comment above) so RLS can isolate it exactly like every other tenant-scoped table, without ever letting it be pointed at another tenant.';

-- -----------------------------------------------------------------------------
-- tenancy.campus
-- -----------------------------------------------------------------------------
create table tenancy.campus (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenancy.tenant (id) on delete restrict,
  code        text not null,
  name        text not null,
  address     jsonb not null default '{}'::jsonb,
  timezone    text not null default 'UTC',
  locale      text not null default 'en',
  is_default  boolean not null default false,
  status      text not null default 'active' check (status in ('active', 'inactive')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, code)
);

-- At most one default campus per tenant - a partial unique index, not
-- application code, because application code can be bypassed by a second
-- code path (a script, a future admin tool) that forgets to check first.
create unique index campus_one_default_per_tenant
  on tenancy.campus (tenant_id)
  where is_default;

-- -----------------------------------------------------------------------------
-- tenancy.academic_year
-- -----------------------------------------------------------------------------
create table tenancy.academic_year (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenancy.tenant (id) on delete restrict,
  name        text not null,
  starts_on   date not null,
  ends_on     date not null,
  status      text not null default 'planning' check (status in ('planning', 'open', 'locked', 'archived')),
  is_current  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, name),
  constraint academic_year_ends_after_starts check (ends_on > starts_on)
);

-- At most one is_current year per tenant - same reasoning as the default
-- campus above: a database constraint holds even when application code
-- doesn't, or is bypassed.
create unique index academic_year_one_current_per_tenant
  on tenancy.academic_year (tenant_id)
  where is_current;

-- -----------------------------------------------------------------------------
-- tenancy.assert_year_writable
-- -----------------------------------------------------------------------------
-- What actually protects a locked/archived year (e.g. last year's report
-- cards, once grades exist against it) is this function living in the
-- database and being called by every write path that touches year-scoped
-- data - not a rule an application developer has to remember to re-check in
-- every one of those modules. SECURITY INVOKER (the default): it runs as
-- whoever calls it, so it is bound by that caller's own RLS visibility of
-- tenancy.academic_year - it cannot be used to probe the existence of a year
-- in a different tenant.
create or replace function tenancy.assert_year_writable(p_academic_year_id uuid)
returns void
language plpgsql
as $$
declare
  v_status text;
begin
  select status into v_status
  from tenancy.academic_year
  where id = p_academic_year_id;

  if v_status is null then
    raise exception 'tenancy.assert_year_writable: academic year % not found (or not visible to the current tenant)', p_academic_year_id;
  end if;

  if v_status not in ('open', 'planning') then
    raise exception 'tenancy.assert_year_writable: academic year % is % and not writable', p_academic_year_id, v_status
      using errcode = 'check_violation';
  end if;
end;
$$;

comment on function tenancy.assert_year_writable(uuid) is
  'Raises unless the year is open or planning. Call this from every write path that touches year-scoped data so a locked/archived year cannot be edited by a module that forgot to check.';

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function tenancy.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_set_updated_at before update on tenancy.tenant
  for each row execute function tenancy.set_updated_at();
create trigger trg_set_updated_at before update on tenancy.campus
  for each row execute function tenancy.set_updated_at();
create trigger trg_set_updated_at before update on tenancy.academic_year
  for each row execute function tenancy.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
-- Under withSystemTx no app.tenant_id GUC is ever set, so
-- current_setting('app.tenant_id', true) is NULL and
-- nullif(..., '')::uuid is also NULL. `tenant_id = NULL` is never true in SQL
-- (NULL is not equal to anything, including another NULL), so a system
-- connection sees ZERO rows here rather than every tenant's rows. That is the
-- deliberate choice, matching audit.record_history's policy: a NULL GUC must
-- never silently mean "match everything" - background jobs and migrations
-- that legitimately need cross-tenant access go through sms_owner (which
-- bypasses RLS entirely as the table owner) via withSystemTx, not through a
-- policy that happens to evaluate true when nothing was set.
alter table tenancy.tenant enable row level security;
create policy tenant_isolation on tenancy.tenant
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table tenancy.campus enable row level security;
create policy campus_tenant_isolation on tenancy.campus
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table tenancy.academic_year enable row level security;
create policy academic_year_tenant_isolation on tenancy.academic_year
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Audit history
-- -----------------------------------------------------------------------------
select audit.attach_history('tenancy.tenant');
select audit.attach_history('tenancy.campus');
select audit.attach_history('tenancy.academic_year');

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Migrations run as sms_owner, which owns these tables; sms_app gets no
-- default privileges on objects sms_owner creates, so every table needs
-- explicit grants. sms_app is NOBYPASSRLS and owns nothing here, which is
-- exactly what makes the policies above actually bind (see arch-check.ts
-- checks 3 and 4).
grant usage on schema tenancy to sms_app;
grant select, insert, update on tenancy.tenant         to sms_app;
grant select, insert, update on tenancy.campus          to sms_app;
grant select, insert, update on tenancy.academic_year   to sms_app;
grant execute on function tenancy.assert_year_writable(uuid) to sms_app;
