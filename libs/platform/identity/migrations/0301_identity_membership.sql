-- =============================================================================
-- identity.membership: who may access which tenant
-- =============================================================================
-- Better Auth (0300) owns global identity - one `user` row per person, no
-- matter how many schools they touch. This table is the other half: it links
-- a user to a tenant and says whether that link is currently usable. This is
-- what makes one login able to span several schools (a district admin, a
-- parent with children at two campuses, ...) while every other module still
-- sees a single, ordinary tenant-scoped table with RLS - exactly like
-- `tenancy.campus` or `tenancy.academic_year`.
--
-- person_id is left null and unconstrained here on purpose: M2 (people) adds
-- the FK to `people.person` once that table exists. Until then it is just a
-- bare uuid a caller may set (or not) - nothing reads it as authoritative.
-- =============================================================================

create table identity.membership (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenancy.tenant (id) on delete restrict,
  user_id     uuid not null references identity.user (id) on delete cascade,
  -- M2 (people) adds: references people.person (id) on delete restrict.
  -- Left as a bare, unconstrained uuid until that table exists.
  person_id   uuid,
  status      text not null default 'invited' check (status in ('active', 'invited', 'suspended')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, tenant_id)
);

comment on table identity.membership is
  'Which users may act as which tenant, and whether that access is currently active. The tenant boundary for Better Auth''s global user records - see the 0300 migration header.';

create index membership_tenant_id_idx on identity.membership (tenant_id);
create index membership_user_id_idx on identity.membership (user_id);

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create trigger trg_set_updated_at before update on identity.membership
  for each row execute function identity.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
-- Ordinary tenant-scoped table: same policy shape as every table in
-- tenancy.*. A system connection (no app.tenant_id set, e.g. the cross-tenant
-- "which tenants does this user belong to" lookup used at sign-in / to list
-- switchable tenants) goes through withSystemTx, which bypasses RLS entirely
-- as table owner - never through a policy that would have to special-case a
-- NULL GUC into "match everything".
alter table identity.membership enable row level security;
create policy membership_tenant_isolation on identity.membership
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Audit history
-- -----------------------------------------------------------------------------
select audit.attach_history('identity.membership');

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
grant select, insert, update on identity.membership to sms_app;
