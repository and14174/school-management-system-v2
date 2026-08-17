-- The migration ledger and schema-version marker are infrastructure, not tenant
-- data: one row set shared by the whole deployment. The @global marker is how a
-- table opts out of the tenant_id + RLS requirement enforced by `pnpm check:db`,
-- so the exemption is explicit and reviewable rather than a silent gap.
comment on table platform.schema_version is
  'Deployment-wide schema version marker. @global @no-audit';
