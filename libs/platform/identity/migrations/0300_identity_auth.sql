-- =============================================================================
-- identity: authentication (Better Auth core schema)
-- =============================================================================
-- Hand-written from Better Auth 1.6.26's documented/default schema (email +
-- password, `session`, `account`, `verification`) plus the `twoFactor` plugin
-- (`identity.two_factor`, and `user.two_factor_enabled`) - NOT generated with
-- `@better-auth/cli generate`. The CLI's `generate` needs to load a live
-- `betterAuth(...)` config module (resolving every import it makes,
-- including `@sms/db`'s pooled client) and, for a drizzle-backed config,
-- emits a Drizzle *schema.ts* to hand-merge into `drizzle-kit generate` - not
-- the plain reviewable SQL this file needs to be. Hand-writing from Better
-- Auth's own `@better-auth/core` schema source (`coreSchema` + each model's
-- fields, read directly from `dist/db/schema/*.mjs` in this workspace's
-- installed `better-auth@1.6.26`) was more reliable than fighting that
-- indirection, and keeps this file the single reviewable source of truth
-- Better Auth is configured to match (`libs/platform/identity/src/application/auth.ts`).
--
-- Column ids: every table uses `uuid`, populated by Better Auth's
-- `advanced.database.generateId` hook (configured to call `@sms/kernel`'s
-- `newId()` - the same UUIDv7 generator every other module uses), not a
-- Postgres-side default - so no column below needs `default uuidv7()`.
--
-- Tenant boundary: Better Auth's core tables are GLOBAL. `user`/`session`/
-- `account`/`verification` hold one person's login identity across every
-- school they may ever touch - there is no single tenant_id a session or
-- account row could carry. The tenant boundary is enforced one layer up, at
-- `identity.membership` (0301, tenant-scoped with RLS): a session identifies
-- a *user*, and `identity.membership` is what says which tenant(s) that user
-- may act as. `pnpm check:db` (arch-check.ts) is told this deliberately via
-- `@global` rather than by adding a tenant_id these tables have no honest
-- value for.
-- =============================================================================

create schema identity;

-- -----------------------------------------------------------------------------
-- identity.user
-- -----------------------------------------------------------------------------
create table identity.user (
  id                  uuid primary key,
  name                text not null,
  email               text not null,
  email_verified      boolean not null default false,
  image               text,
  -- Added by the `twoFactor` plugin schema (`user.twoFactorEnabled`).
  two_factor_enabled  boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (email)
);

comment on table identity.user is
  'Global login identity (Better Auth core table). One row per person who can sign in, across every tenant they may ever belong to - see the migration header comment. @global';

-- -----------------------------------------------------------------------------
-- identity.session
-- -----------------------------------------------------------------------------
-- active_tenant_id is this module's own extension (not part of Better Auth's
-- default schema): the tenant the session is currently acting as. A user
-- with exactly one membership gets it set automatically at sign-in
-- (application/auth.ts); a user with several picks with setActiveTenant().
-- No RLS-relevant meaning lives on this table itself (it is @global, see
-- above) - AuthGuard reads this column and it is `identity.membership`,
-- tenant-scoped and RLS-enforced, that actually gates access.
create table identity.session (
  id                uuid primary key,
  expires_at        timestamptz not null,
  token             text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  ip_address        text,
  user_agent        text,
  user_id           uuid not null references identity.user (id) on delete cascade,
  active_tenant_id  uuid references tenancy.tenant (id) on delete set null,
  unique (token)
);

comment on table identity.session is
  'Global login sessions (Better Auth core table), extended with active_tenant_id (this module). Churns on every request/refresh and carries only a bearer token, not durable business data. @global @no-audit';

create index session_user_id_idx on identity.session (user_id);
create index session_active_tenant_id_idx on identity.session (active_tenant_id) where active_tenant_id is not null;

-- -----------------------------------------------------------------------------
-- identity.account
-- -----------------------------------------------------------------------------
-- One row per way a user can authenticate. For email+password this holds
-- provider_id = 'credential' and the scrypt password hash; social providers
-- (none configured yet) would add oauth token rows here too.
create table identity.account (
  id                          uuid primary key,
  account_id                  text not null,
  provider_id                 text not null,
  user_id                     uuid not null references identity.user (id) on delete cascade,
  access_token                text,
  refresh_token               text,
  id_token                    text,
  access_token_expires_at     timestamptz,
  refresh_token_expires_at    timestamptz,
  scope                       text,
  password                    text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

comment on table identity.account is
  'Global per-provider credentials (Better Auth core table), including the password hash for email+password. @global';

create index account_user_id_idx on identity.account (user_id);

-- -----------------------------------------------------------------------------
-- identity.verification
-- -----------------------------------------------------------------------------
-- Short-lived tokens: email verification, password reset, etc. Purely
-- transient - never meaningfully auditable history, and churns constantly.
create table identity.verification (
  id          uuid primary key,
  identifier  text not null,
  value       text not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table identity.verification is
  'Global short-lived verification tokens (Better Auth core table) - email verification, password reset. @global @no-audit';

create index verification_identifier_idx on identity.verification (identifier);

-- -----------------------------------------------------------------------------
-- identity.two_factor
-- -----------------------------------------------------------------------------
-- Added by the `twoFactor` plugin (TOTP secret + encrypted backup codes).
-- Model name is "twoFactor" (camelCase) on the Better Auth side; the table
-- itself is named two_factor here like every other snake_case table.
create table identity.two_factor (
  id                        uuid primary key,
  secret                    text not null,
  backup_codes              text not null,
  user_id                   uuid not null references identity.user (id) on delete cascade,
  verified                  boolean not null default true,
  failed_verification_count integer not null default 0,
  locked_until              timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

comment on table identity.two_factor is
  'Global TOTP secret + backup codes (Better Auth twoFactor plugin table). @global';

create index two_factor_user_id_idx on identity.two_factor (user_id);

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function identity.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_set_updated_at before update on identity.user
  for each row execute function identity.set_updated_at();
create trigger trg_set_updated_at before update on identity.session
  for each row execute function identity.set_updated_at();
create trigger trg_set_updated_at before update on identity.account
  for each row execute function identity.set_updated_at();
create trigger trg_set_updated_at before update on identity.verification
  for each row execute function identity.set_updated_at();
create trigger trg_set_updated_at before update on identity.two_factor
  for each row execute function identity.set_updated_at();

-- -----------------------------------------------------------------------------
-- Audit history
-- -----------------------------------------------------------------------------
-- user and account are audited (who signed up, when a credential changed) -
-- with the password hash and OAuth token columns excluded so no secret ever
-- enters audit.record_history, even as a before/after image. session and
-- verification are @no-audit (see their table comments above) so no trigger
-- is attached to them at all.
select audit.attach_history('identity.user');
select audit.attach_history('identity.account', 'password', 'access_token', 'refresh_token', 'id_token');
select audit.attach_history('identity.two_factor', 'secret', 'backup_codes');

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Global tables: no RLS, no tenant_id - see the migration header. Ordinary
-- table grants to sms_app are still required (migrations run as sms_owner,
-- which owns these tables and grants nothing to sms_app by default).
grant usage on schema identity to sms_app;
grant select, insert, update, delete on identity.user         to sms_app;
grant select, insert, update, delete on identity.session      to sms_app;
grant select, insert, update, delete on identity.account      to sms_app;
grant select, insert, update, delete on identity.verification to sms_app;
grant select, insert, update, delete on identity.two_factor   to sms_app;
