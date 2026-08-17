-- Least-privilege bootstrap for authentication.
--
-- Resolving a request's tenant requires looking up the signed-in user's
-- memberships, which necessarily happens BEFORE any tenant is known. The
-- shortcut is to run that lookup through withSystemTx() - but that connects as
-- sms_owner, and table owners bypass row-level security in Postgres. That would
-- put every sign-in through a connection with unrestricted cross-tenant access,
-- which is the opposite of what the rest of this schema is built to guarantee.
--
-- This policy lets the lookup run as the ordinary sms_app role instead, seeing
-- only the caller's own membership rows.
--
-- Why this does not weaken isolation: RLS policies for the same command are
-- PERMISSIVE, i.e. OR-ed. Adding this one grants no new visibility to a normal
-- tenant-scoped request, because those set app.tenant_id and not app.user_id.
-- It grants exactly one thing: "a user may see which tenants they belong to",
-- which is a fact about themselves, not about any tenant's data.
--
-- Note the deliberate asymmetry - SELECT only. Writes still require a tenant
-- context, so nothing can grant itself a membership through this path.
create policy membership_self_read on identity.membership
  for select
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

comment on policy membership_self_read on identity.membership is
  'Lets authentication resolve a user''s own memberships as sms_app, so sign-in never needs an RLS-bypassing owner connection.';
