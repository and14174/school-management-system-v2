-- =============================================================================
-- access: authorization - permission catalogue, scoped roles, effective-dated
--         role assignments, and impersonation
-- =============================================================================
-- A permission is action x resource x scope. Scope is the piece most systems
-- get wrong: it is modelled explicitly (access.permission_scope below) rather
-- than as a boolean "is this global" flag, and two of its five values
-- (section, grade_level) are declared here but CANNOT be resolved into a real
-- condition yet - the academic and enrollment modules that would define "which
-- sections/grade levels" don't exist until M2. Ability compilation
-- (@sms/access's src/application/ability.service.ts) refuses to emit a rule
-- for those two scopes at all, so a section/grade_level-scoped grant denies
-- everything today rather than silently widening to "everything" because its
-- resolver is missing. That failure mode - a scope nobody got around to
-- implementing quietly meaning "unrestricted" - is the exact thing this
-- design exists to prevent.
--
-- Sensitive fields (medical, safeguarding) are NOT a deny-list column on a
-- table. A deny-list means every newly added sensitive column is visible to
-- everyone until somebody remembers to mask it. Instead they are their own
-- permissions (people.student:read vs people.student:read_medical), and
-- @sms/access's src/domain/field-registry.ts maps resource field -> required
-- permission in code; a field with no registry entry is invisible to the
-- masking interceptor by construction until it is registered.
-- =============================================================================

create schema access;

-- Temporal exclusion constraint on access.role_assignment below needs GiST
-- support for plain btree-comparable types (uuid, date) - already installed
-- by infra/postgres/init/01-roles-and-extensions.sql in every real
-- deployment; declared here too (IF NOT EXISTS) so this migration is
-- self-contained against a bare Postgres, e.g. under testcontainers.
create extension if not exists btree_gist;

-- -----------------------------------------------------------------------------
-- access.permission_scope
-- -----------------------------------------------------------------------------
create type access.permission_scope as enum ('own', 'section', 'grade_level', 'campus', 'tenant');

comment on type access.permission_scope is
  'How far a grant reaches. own/campus/tenant are resolvable today; section/grade_level are declared for the future academic and enrollment modules (M2) and MUST resolve to zero access until those modules exist - see the migration header and ability.service.ts.';

-- -----------------------------------------------------------------------------
-- access.permission
-- -----------------------------------------------------------------------------
-- This vocabulary (which actions on which resources exist at all) is defined
-- by @sms/access's code (src/domain/permissions.ts), not by any tenant, and
-- is identical across every tenant - so it is @global (no tenant_id), exactly
-- like identity.user is global rather than tenant-scoped. A test
-- (access.spec.ts) asserts this table's contents and the code catalogue never
-- drift apart.
create table access.permission (
  id          uuid primary key default uuidv7(),
  key         text not null unique,
  resource    text not null,
  action      text not null,
  description text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (resource, action)
);

comment on table access.permission is
  'The fixed permission catalogue (resource x action). Seeded from @sms/access''s src/domain/permissions.ts, which is the source of truth - not created or editable by tenants. @global';

-- -----------------------------------------------------------------------------
-- access.role
-- -----------------------------------------------------------------------------
create table access.role (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenancy.tenant (id) on delete restrict,
  key         text not null,
  name        text not null,
  description text,
  is_system   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, key)
);

comment on table access.role is
  'A named bundle of permission grants, scoped to one tenant. is_system roles are seeded by @sms/access''s seed.ts (School Administrator, Registrar, Teacher, ...) and may not be deleted by a tenant.';

create index role_tenant_id_idx on access.role (tenant_id);

-- -----------------------------------------------------------------------------
-- access.role_permission
-- -----------------------------------------------------------------------------
-- A surrogate `id` primary key, NOT the natural composite key
-- (role_id, permission_id) - `audit.record_history()` (read but never
-- edited - see the module report's constraints) hard-requires every audited
-- table to carry an `id` column, raising rather than writing an
-- unattributable history row for one that doesn't (see its own comment: "a
-- table without one would otherwise get history rows that can never be
-- traced back to a record"). The composite uniqueness the natural key would
-- have given us instead becomes an explicit UNIQUE constraint below, which
-- `RoleService.grantPermission`'s upsert (`ON CONFLICT (role_id,
-- permission_id)`) targets exactly the same as it would a primary key.
create table access.role_permission (
  id            uuid primary key default uuidv7(),
  role_id       uuid not null references access.role (id) on delete cascade,
  permission_id uuid not null references access.permission (id) on delete restrict,
  scope         access.permission_scope not null,
  tenant_id     uuid not null,
  unique (role_id, permission_id)
);

comment on table access.role_permission is
  'One grant: this role may perform this permission''s action, at this scope. tenant_id is denormalised from role_id (validated by trigger below) so RLS can isolate this table exactly like every other tenant-scoped table.';

create index role_permission_tenant_id_idx on access.role_permission (tenant_id);

-- role_permission.tenant_id must always agree with its role's tenant_id - a
-- database-level invariant (like tenancy.assert_year_writable, campus_one_
-- default_per_tenant) rather than something every write path has to
-- remember to get right.
create or replace function access.check_role_permission_tenant()
returns trigger
language plpgsql
as $$
declare
  v_role_tenant_id uuid;
begin
  select tenant_id into v_role_tenant_id from access.role where id = new.role_id;
  if v_role_tenant_id is null then
    raise exception 'access.role_permission: role % not found', new.role_id;
  end if;
  if v_role_tenant_id <> new.tenant_id then
    raise exception 'access.role_permission: tenant_id % does not match role %''s tenant %', new.tenant_id, new.role_id, v_role_tenant_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger trg_check_role_permission_tenant before insert or update on access.role_permission
  for each row execute function access.check_role_permission_tenant();

-- -----------------------------------------------------------------------------
-- access.role_assignment
-- -----------------------------------------------------------------------------
-- Effective-dated: valid_from/valid_to (both inclusive, matching @sms/kernel's
-- Interval convention - see temporal.ts) so a mid-year role change (promotion,
-- transfer, offboarding) is a fact recorded over time, not a value overwritten
-- in place. Ability compilation resolves "as of today" by default.
create table access.role_assignment (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenancy.tenant (id) on delete restrict,
  role_id     uuid not null references access.role (id) on delete cascade,
  user_id     uuid not null references identity.user (id) on delete cascade,
  campus_id   uuid references tenancy.campus (id) on delete restrict,
  valid_from  date not null default current_date,
  valid_to    date,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint role_assignment_valid_range check (valid_to is null or valid_to >= valid_from),
  -- Prevents the same role being assigned to the same user twice over
  -- overlapping periods (an exclusion constraint, not just application code,
  -- for the same reason campus_one_default_per_tenant is a partial index
  -- rather than a check in TenantService: a second code path - a script, an
  -- admin tool - could otherwise bypass it). Both endpoints are inclusive,
  -- matching @sms/kernel's Interval; Postgres canonicalises the inclusive
  -- upper bound of a discrete (date) range automatically. Needs btree_gist
  -- for GiST support on uuid equality.
  constraint role_assignment_no_overlap exclude using gist (
    tenant_id with =,
    user_id with =,
    role_id with =,
    daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') with &&
  )
);

comment on table access.role_assignment is
  'Which user holds which role, from when to when (both inclusive; valid_to null = open-ended), optionally narrowed to one campus. "As of today" is the default resolution window for ability compilation.';

create index role_assignment_tenant_user_idx on access.role_assignment (tenant_id, user_id);
create index role_assignment_role_id_idx on access.role_assignment (role_id);
create index role_assignment_campus_id_idx on access.role_assignment (campus_id) where campus_id is not null;

-- role_id and campus_id must belong to the same tenant as the assignment
-- itself - same defense-in-depth reasoning as check_role_permission_tenant.
create or replace function access.check_role_assignment_tenant()
returns trigger
language plpgsql
as $$
declare
  v_role_tenant_id   uuid;
  v_campus_tenant_id uuid;
begin
  select tenant_id into v_role_tenant_id from access.role where id = new.role_id;
  if v_role_tenant_id is null then
    raise exception 'access.role_assignment: role % not found', new.role_id;
  end if;
  if v_role_tenant_id <> new.tenant_id then
    raise exception 'access.role_assignment: tenant_id % does not match role %''s tenant %', new.tenant_id, new.role_id, v_role_tenant_id
      using errcode = 'check_violation';
  end if;

  if new.campus_id is not null then
    select tenant_id into v_campus_tenant_id from tenancy.campus where id = new.campus_id;
    if v_campus_tenant_id is null then
      raise exception 'access.role_assignment: campus % not found', new.campus_id;
    end if;
    if v_campus_tenant_id <> new.tenant_id then
      raise exception 'access.role_assignment: campus % does not belong to tenant %', new.campus_id, new.tenant_id
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger trg_check_role_assignment_tenant before insert or update on access.role_assignment
  for each row execute function access.check_role_assignment_tenant();

-- -----------------------------------------------------------------------------
-- access.impersonation
-- -----------------------------------------------------------------------------
-- Every impersonated session must be traceable to a named human and a stated
-- reason - reason is NOT NULL, not optional metadata. ended_at null means the
-- session is currently active.
create table access.impersonation (
  id              uuid primary key default uuidv7(),
  tenant_id       uuid not null references tenancy.tenant (id) on delete restrict,
  actor_user_id   uuid not null references identity.user (id) on delete restrict,
  target_user_id  uuid not null references identity.user (id) on delete restrict,
  reason          text not null check (length(btrim(reason)) > 0),
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  constraint impersonation_ends_after_starts check (ended_at is null or ended_at >= started_at),
  constraint impersonation_actor_not_target check (actor_user_id <> target_user_id)
);

comment on table access.impersonation is
  'One row per impersonated session: who (actor_user_id) acted as whom (target_user_id), why, and for how long. Every write made while impersonating must remain attributable to actor_user_id, not just target_user_id - see apps/api''s tenant-context.interceptor.ts.';

create index impersonation_tenant_actor_idx on access.impersonation (tenant_id, actor_user_id);
create index impersonation_target_idx on access.impersonation (target_user_id);

-- At most one active (ended_at is null) impersonation session per actor at a
-- time - same partial-unique-index pattern as campus_one_default_per_tenant.
create unique index impersonation_one_active_per_actor
  on access.impersonation (tenant_id, actor_user_id)
  where ended_at is null;

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function access.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_set_updated_at before update on access.permission
  for each row execute function access.set_updated_at();
create trigger trg_set_updated_at before update on access.role
  for each row execute function access.set_updated_at();
create trigger trg_set_updated_at before update on access.role_assignment
  for each row execute function access.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
-- access.permission is @global: no tenant_id, no RLS - see arch-check.ts and
-- the table comment above. Every other table here is ordinary tenant-scoped
-- data: same policy shape, same "NULL GUC matches nothing" reasoning, as
-- every table in tenancy.* and identity.membership.
alter table access.role enable row level security;
create policy role_tenant_isolation on access.role
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table access.role_permission enable row level security;
create policy role_permission_tenant_isolation on access.role_permission
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table access.role_assignment enable row level security;
create policy role_assignment_tenant_isolation on access.role_assignment
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table access.impersonation enable row level security;
create policy impersonation_tenant_isolation on access.impersonation
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Audit history
-- -----------------------------------------------------------------------------
-- Every table here is audited, including the @global permission catalogue
-- (arch-check.ts's audit check does not exempt @global tables - only an
-- explicit @no-audit marker does, and this catalogue changing is exactly the
-- kind of change worth a history trail).
select audit.attach_history('access.permission');
select audit.attach_history('access.role');
select audit.attach_history('access.role_permission');
select audit.attach_history('access.role_assignment');
select audit.attach_history('access.impersonation');

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Migrations run as sms_owner, which owns these tables; sms_app gets no
-- default privileges on objects sms_owner creates, so every table needs
-- explicit grants. sms_app is NOBYPASSRLS and owns nothing here (arch-check.ts
-- checks 3 and 4).
grant usage on schema access to sms_app;
grant select, insert, update           on access.permission     to sms_app;
grant select, insert, update, delete   on access.role            to sms_app;
grant select, insert, update, delete   on access.role_permission to sms_app;
grant select, insert, update, delete   on access.role_assignment to sms_app;
grant select, insert, update           on access.impersonation   to sms_app;
