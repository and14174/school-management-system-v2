-- =============================================================================
-- public_api: API keys for machine access - a finance system, a data
--             warehouse, a parent app - instead of a human session
-- =============================================================================
-- Five design decisions carry the whole schema:
--
--   * NEVER a readable secret. `api_key.key_hash` is HMAC-SHA256 of the
--     random secret half of the key, keyed by a server-side secret derived
--     from AUTH_SECRET (see @sms/public-api's application/key-material.ts -
--     argon2/bcrypt are not dependencies in this workspace, so HMAC-SHA256
--     with a server secret is the documented, deliberate choice). The
--     plaintext key is generated, shown once at mint time, and is gone: it
--     is never stored, never logged, and cannot be recomputed from
--     `key_hash` (a keyed HMAC is not reversible even with full database
--     access - it is not "the same as a password hash minus the slow KDF",
--     it is a MAC, which is the correct primitive for a high-entropy random
--     token that is never user-chosen and therefore has nothing for a
--     rainbow table to guess). `prefix` is the non-secret identifier
--     (globally unique, indexed) a UI or a log line can safely show.
--
--   * A key can never exceed the permissions of the principal that minted
--     it. `granted_permissions` is validated at mint time (application
--     layer - see ApiKeysService.mint) to be an explicit subset of the
--     creating user's OWN effective permissions in this tenant, resolved via
--     @sms/access's `AccessContract.listEffectivePermissions`. This table
--     does not and cannot enforce that subset relationship itself (it would
--     require a live read of @sms/access's role/grant tables at INSERT time,
--     which is exactly the kind of cross-module coupling the module
--     boundary exists to prevent) - it is enforced once, at mint, and
--     RE-enforced on every single authenticated request by the unmodified
--     `PermissionGuard` (@sms/access), which recompiles the CREATING USER's
--     ability fresh each time (see apps/api's ApiKeyGuard, which sets
--     `request.identity.userId` to the key's `created_by_user_id`, not to
--     some new "service principal" concept) - so a permission removed from
--     that user's role stops working for every key they ever minted on the
--     very next request, with no separate invalidation step.
--
--   * Revocation is immediate and permanent, and archives rather than
--     deletes (this project's standing rule - see docs/decisions.md's
--     "Reverting an import archives, it does not delete"). `revoked_at`/
--     `revoked_by_user_id`/`revoke_reason` are set once and never cleared;
--     there is no "un-revoke". A revoked key's row stays exactly where it
--     was so an admin can still see who had access to what, and when it was
--     cut off.
--
--   * Every authenticated call is attributable, without ever recording the
--     key itself. `api_key_usage` holds one row per key
--     (last_used_at/use_count), updated on every successful authentication;
--     `api_key_request_log` is an append-only per-call record (method, path,
--     which key, which tenant) - together they answer "which integration
--     read this student's record" at the HTTP-request granularity. Both are
--     marked `@no-audit`: they change on literally every API call a key
--     makes, and a full before/after history of a liveness counter has no
--     compliance value that `api_key_request_log` (itself already an
--     append-only attribution log) does not provide - see the file's
--     `@no-audit` markers below and docs/decisions.md's "A safety check must
--     discover, never rely on a list" (this is the DELIBERATE, documented
--     opt-out that check discovers, not an oversight).
--
--   * Keys expire by default. `expires_at` is required UNLESS
--     `never_expires` is explicitly true - enforced by the check constraint
--     below AND by the mint-time Zod schema (application/schemas.ts), so
--     "forgot to set an expiry" and "chose not to" are never the same row.
-- =============================================================================

create schema public_api;

-- -----------------------------------------------------------------------------
-- public_api.api_key
-- -----------------------------------------------------------------------------
create table public_api.api_key (
  id                   uuid        primary key default uuidv7(),
  tenant_id            uuid        not null references tenancy.tenant (id) on delete restrict,
  name                 text        not null,

  -- Non-secret identifier, globally unique (not just per-tenant): a
  -- presented key carries no tenant hint of its own, so authenticating it
  -- means looking it up by prefix BEFORE any tenant is known - the exact
  -- "resolving which tenant a request belongs to, before any tenant is
  -- known" bootstrapping problem docs/decisions.md documents for
  -- @sms/identity's MembershipService.listForUserDuringAuthentication. This
  -- lookup is the one place ApiKeysService.authenticate legitimately uses
  -- withSystemTx - see that method's own comment.
  prefix               text        not null unique,

  -- HMAC-SHA256(secret) hex digest - see the file header. Never selected
  -- into any API response; excluded from audit history below too, as
  -- defense in depth (it is already a one-way MAC, but there is no reason
  -- for it to exist in a second table).
  key_hash             text        not null,

  -- Explicit subset of PERMISSION_CATALOGUE keys (`resource:action`) -
  -- validated against the creating user's own effective permissions at mint
  -- time (application layer, not a DB constraint - see the file header) and
  -- re-checked against the catalogue + the creator's CURRENT role on every
  -- request by ApiKeyGuard + the unmodified PermissionGuard.
  granted_permissions  text[]      not null default '{}',

  created_by_user_id   uuid        not null references identity.user (id) on delete restrict,
  created_at           timestamptz not null default now(),

  -- Required unless never_expires is explicitly true - see the file header.
  expires_at           timestamptz,
  never_expires        boolean     not null default false,

  -- Set once, never cleared - see the file header on revocation.
  revoked_at           timestamptz,
  revoked_by_user_id   uuid        references identity.user (id) on delete restrict,
  revoke_reason        text,

  constraint api_key_expiry_is_explicit
    check (expires_at is not null or never_expires),
  constraint api_key_revocation_fields_agree
    check ((revoked_at is null) = (revoked_by_user_id is null))
);

comment on table public_api.api_key is
  'One row per machine API key. key_hash is HMAC-SHA256 of the secret - the plaintext is never stored anywhere, ever. granted_permissions is an explicit subset of the creating user''s own permissions, validated at mint time. Revocation sets revoked_at and is permanent - see the file header.';

comment on column public_api.api_key.key_hash is
  'HMAC-SHA256(secret) hex digest, keyed by a secret derived from AUTH_SECRET (see application/key-material.ts). Not reversible. Never returned by any endpoint.';

create index api_key_tenant_idx on public_api.api_key (tenant_id, created_at desc);

-- -----------------------------------------------------------------------------
-- public_api.api_key_usage
-- -----------------------------------------------------------------------------
-- One row per key, upserted on every successful authentication. Separate
-- from api_key itself so a hot, once-per-request UPDATE never touches (or
-- generates history for) the key's own security-relevant row - see the file
-- header on @no-audit.
create table public_api.api_key_usage (
  api_key_id  uuid        primary key references public_api.api_key (id) on delete restrict,
  tenant_id   uuid        not null,
  last_used_at timestamptz not null,
  use_count   bigint      not null default 0
);

comment on table public_api.api_key_usage is
  'One row per key: last_used_at/use_count, upserted on every successful authentication. High-frequency by design - see the file header. @no-audit';

-- -----------------------------------------------------------------------------
-- public_api.api_key_request_log
-- -----------------------------------------------------------------------------
-- Append-only. This IS the per-call attribution record - see the file
-- header. Never updated, so a meta-history of updates to it would be
-- meaningless; @no-audit is the documented opt-out check:db discovers.
create table public_api.api_key_request_log (
  id          uuid        primary key default uuidv7(),
  tenant_id   uuid        not null,
  api_key_id  uuid        not null references public_api.api_key (id) on delete restrict,
  method      text        not null,
  path        text        not null,
  occurred_at timestamptz not null default now()
);

comment on table public_api.api_key_request_log is
  'Append-only: one row per authenticated API-key call (method, path, which key, when) - answers "which integration accessed X". @no-audit';

create index api_key_request_log_key_idx on public_api.api_key_request_log (api_key_id, occurred_at desc);
create index api_key_request_log_tenant_idx on public_api.api_key_request_log (tenant_id, occurred_at desc);

-- -----------------------------------------------------------------------------
-- Audit history
-- -----------------------------------------------------------------------------
-- key_hash excluded from history: it is already a one-way MAC (not the
-- plaintext), but there is no reason for even the hash to be duplicated into
-- a second table - see the file header.
select audit.attach_history('public_api.api_key', 'key_hash');

-- api_key_usage / api_key_request_log: @no-audit, see their own table
-- comments and the file header.

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
alter table public_api.api_key enable row level security;
create policy api_key_tenant_isolation on public_api.api_key
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table public_api.api_key_usage enable row level security;
create policy api_key_usage_tenant_isolation on public_api.api_key_usage
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table public_api.api_key_request_log enable row level security;
create policy api_key_request_log_tenant_isolation on public_api.api_key_request_log
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
grant usage on schema public_api to sms_app;

-- SELECT: list/read. INSERT: mint. UPDATE: revoke (revoked_at/by/reason
-- only - the application never updates any other column after insert).
-- No DELETE: revocation archives, per the file header.
grant select, insert, update on public_api.api_key to sms_app;

-- SELECT/INSERT/UPDATE: the last-used upsert (ApiKeysService.authenticate).
grant select, insert, update on public_api.api_key_usage to sms_app;

-- SELECT/INSERT only: append-only attribution log, per the file header.
grant select, insert on public_api.api_key_request_log to sms_app;
