-- =============================================================================
-- people.contact_point: real email/phone addresses for a person
-- =============================================================================
-- Until this migration, `people.person` had no contact-channel field at all,
-- so `apps/api`'s notifications resolver had nowhere real to send an email -
-- it SYNTHESISED one (`given.family.<hash>@guardians.school.test`) purely so
-- the channel had somewhere to write to. That made the notifications module
-- look reachable while being unable to reach a single real person - a
-- delivery could say 'sent' when nobody was actually told anything. See
-- `apps/api/src/notifications/guardian-recipient-resolver.ts`.
--
-- Design:
--   * One row per address, never one column overloaded with several kinds -
--     same reasoning as `people.person_identifier` (see the `0500` migration
--     header): a person may have a home email, a work email and a mobile
--     phone, each with its own label and its own verification/archival state.
--   * `is_primary` is scoped to (person, kind): a person can have exactly one
--     primary email and, independently, one primary phone. Enforced by a
--     partial unique index below, not by application code - the same "the
--     database enforces it, not a service-layer check" posture the decision
--     log documents for conflict detection.
--   * Archived, never deleted - same reasoning as `people.person` itself
--     (see the `0500` header and `0502`'s "reverting an import archives, it
--     does not delete"): a contact point that turns out to be wrong or is
--     replaced should stop being used, not vanish from history.
-- =============================================================================

create table people.contact_point (
  id           uuid primary key default uuidv7(),
  tenant_id    uuid not null references tenancy.tenant (id) on delete restrict,
  person_id    uuid not null references people.person (id) on delete restrict,
  kind         text not null check (kind in ('email', 'phone')),
  value        text not null,
  label        text,
  is_primary   boolean not null default false,
  verified_at  timestamptz,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table people.contact_point is
  'Email/phone addresses for a person. One row per address (never one column overloaded with several kinds, like person_identifier). Archived, never deleted - see the migration header.';

create index contact_point_tenant_person_idx
  on people.contact_point (tenant_id, person_id)
  where archived_at is null;

-- At most one primary per (person, kind) among non-archived rows. Partial on
-- BOTH is_primary and "not archived" so an archived former-primary can never
-- block a new one from being promoted, and so re-running the seed (which
-- check-then-creates) never trips this on an already-seeded person.
create unique index contact_point_one_primary_per_kind_idx
  on people.contact_point (tenant_id, person_id, kind)
  where is_primary and archived_at is null;

-- -----------------------------------------------------------------------------
-- updated_at maintenance - reuses people.set_updated_at() from the 0500
-- migration (already created in this schema).
-- -----------------------------------------------------------------------------
create trigger trg_set_updated_at before update on people.contact_point
  for each row execute function people.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
alter table people.contact_point enable row level security;
create policy contact_point_tenant_isolation on people.contact_point
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Audit history
-- -----------------------------------------------------------------------------
select audit.attach_history('people.contact_point');

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- No DELETE, matching people.person itself: a contact point is archived, not
-- removed (see the migration header). A GRANT without a matching policy is a
-- silent denial (see docs/decisions.md) - the FOR ALL policy above covers
-- SELECT/INSERT/UPDATE, so these grants are actually usable.
grant select, insert, update on people.contact_point to sms_app;
