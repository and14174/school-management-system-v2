-- Fix: audit.access_log was granted INSERT to sms_app but only had a FOR SELECT
-- policy. Under row-level security a command with no applicable permissive
-- policy is denied outright, whatever the GRANTs say - so every attempt by the
-- API to record a restricted-data read failed with 42501.
--
-- The two halves of "who may do this" have to agree: a GRANT without a matching
-- policy is not permission, it is a silent denial. Read-access logging is the
-- one part of the audit trail the application writes directly (triggers cannot
-- observe reads), so it needs an explicit INSERT policy scoped to the caller's
-- own tenant.
--
-- record_history deliberately does NOT get one: it is written only by the
-- SECURITY DEFINER trigger, which runs as the table owner and is not subject to
-- RLS. That asymmetry is the design - the application can cause history to be
-- written but can never write it directly.

create policy access_log_tenant_insert on audit.access_log
  for insert
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
