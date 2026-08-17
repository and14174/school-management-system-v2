-- =============================================================================
-- billing.credit_note_approval_policy - the ONE piece of domain-specific
-- configuration the @sms/approvals credit-note pilot needs
-- =============================================================================
-- @sms/approvals (type:platform) is deliberately generic: a policy there
-- names a PERMISSION and a COUNT, nothing about money - see that module's
-- 1700 migration header. "Above a configurable threshold" is domain business
-- logic this module owns, so it lives here, in a table @sms/approvals never
-- reads.
--
-- CreditNoteService.issueCreditNote reads this table FIRST, before ever
-- calling ApprovalsContract.requestApproval: a credit note in `currency`
-- totalling at least `threshold_minor` is held pending; anything else is
-- applied immediately, exactly as it was before this table existed. No row
-- for a currency = no gating for that currency - strictly opt-in.
--
-- This alone does not gate anything by itself: an approvals.policy row for
-- request_type = 'billing.credit_note' must ALSO exist (naming which
-- permission may decide it, and how many distinct approvals) or a gated
-- credit note stays pending forever with nobody able to decide it - the same
-- fail-closed posture @sms/approvals documents for a request type with no
-- policy at all.
-- =============================================================================

create table billing.credit_note_approval_policy (
  id              uuid        primary key default uuidv7(),
  tenant_id       uuid        not null references tenancy.tenant (id) on delete restrict,
  currency        char(3)     not null,
  threshold_minor bigint      not null check (threshold_minor > 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, currency)
);

comment on table billing.credit_note_approval_policy is
  'Opt-in: a credit note in this currency totalling at least threshold_minor is held pending approval (@sms/approvals) rather than applied immediately. No row for a currency = no gating for it - see this file''s own header.';

create trigger trg_set_updated_at before update on billing.credit_note_approval_policy
  for each row execute function billing.set_updated_at();

select audit.attach_history('billing.credit_note_approval_policy');

alter table billing.credit_note_approval_policy enable row level security;
create policy credit_note_approval_policy_tenant_isolation on billing.credit_note_approval_policy
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update on billing.credit_note_approval_policy to sms_app;
