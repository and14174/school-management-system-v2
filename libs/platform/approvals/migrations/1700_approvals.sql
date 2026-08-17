-- =============================================================================
-- approvals: the generic "someone else must sign off" workflow engine
-- =============================================================================
-- Two hand-rolled versions of this already existed before this schema did -
-- attendance.correction and gradebook.correction - both shaped as "an
-- append-only request, then a one-time decision that applies the change".
-- This is that shape, generalised, plus the one weakness neither hand-rolled
-- version fixed: nothing stopped a requester who also held the approving
-- permission from approving their own request.
--
-- Three things this schema exists to make true, all enforced here rather
-- than trusted to the service layer that sits on top of it:
--
--   1. A REQUESTER CANNOT DECIDE THEIR OWN REQUEST. trg_forbid_self_decision
--      below compares approvals.decision.decided_by_user_id against
--      approvals.request.requested_by_user_id on every INSERT and raises if
--      they match - even for sms_owner, since triggers fire regardless of
--      role (only row-level security is owner-exempt, not triggers). The
--      application ALSO checks this before ever reaching the database (for a
--      clean error message), but this is the real enforcement - see
--      docs/decisions.md's posture on service checks vs. database
--      constraints ("Conflict detection belongs in the database").
--
--   2. DECISIONS ARE APPEND-ONLY. Same idiom as
--      admissions.application_decision and communications.message: once
--      written, a approvals.decision row can never be UPDATEd or DELETEd -
--      trg_forbid_decision_mutation refuses both outright, and sms_app is
--      never granted UPDATE/DELETE on the table either (belt and suspenders,
--      same posture as billing.credit_note).
--
--   3. A DECIDED REQUEST IS IMMUTABLE. approvals.request starts 'pending' and
--      may transition to 'approved' or 'rejected' exactly once -
--      trg_forbid_request_mutation refuses any further change (to status or
--      to any other column) once it has left 'pending'. Combined with the
--      claim pattern the service uses (`UPDATE ... WHERE status = 'pending'
--      RETURNING *`, never check-then-write), this is what makes "approve
--      twice" apply the underlying effect exactly once - see
--      application/approvals.service.ts.
--
-- What is deliberately NOT here: any notion of what is being approved. This
-- schema knows a request has a requestType (an opaque string a domain module
-- chooses, e.g. 'billing.credit_note'), a subjectType/subjectId (opaque
-- pointer, same "no FK to another module's table" posture as
-- notifications.notification.subject_type/subject_id - this module is
-- type:platform and must never depend on type:domain), and a payload jsonb
-- blob the domain module that requested it can round-trip when its handler
-- applies the change. The handler itself is supplied by the domain module
-- through the APPROVAL_HANDLER_REGISTRY inversion port (see
-- application/handler-registry.ts) and runs INSIDE the same transaction as
-- the decision that triggers it - same discipline @sms/outbox's publish()
-- documents, and the exact bug class docs/decisions.md's notifications-
-- dedupe entry describes if that were ever relaxed.
--
-- approvals.policy is the other half of "policy is configuration, not
-- code": which permission may decide a request of this type, and how many
-- DISTINCT holders of it must approve (default 1). A request type with no
-- policy row stays pending forever - see ApprovalsService.decide's own
-- comment - never auto-approved, never silently decided by nobody.
-- =============================================================================

create schema approvals;

-- -----------------------------------------------------------------------------
-- approvals.policy
-- -----------------------------------------------------------------------------
create table approvals.policy (
  id                  uuid        primary key default uuidv7(),
  tenant_id           uuid        not null references tenancy.tenant (id) on delete restrict,
  request_type        text        not null,
  -- A permission catalogue key ('resource:action', e.g. 'billing.credit_note:issue').
  -- Deliberately NOT a foreign key into access.permission: this module is
  -- type:platform and the catalogue is seeded data @sms/access owns, not a
  -- table this module may join against past its own boundary - same posture
  -- as billing.invoice.student_person_id pointing at people.person without
  -- an FK. The permission is validated at DECIDE time instead, by compiling
  -- the decider's real ability against it (ApprovalsService.decide).
  permission_key      text        not null,
  approvals_required  integer     not null default 1 check (approvals_required >= 1),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, request_type)
);

comment on table approvals.policy is
  'Per (tenant, request_type): which permission may decide it, and how many DISTINCT holders of that permission must approve (default 1). No row for a request_type = fail closed - see ApprovalsService.decide.';

-- -----------------------------------------------------------------------------
-- approvals.request
-- -----------------------------------------------------------------------------
create table approvals.request (
  id                    uuid        primary key default uuidv7(),
  tenant_id             uuid        not null references tenancy.tenant (id) on delete restrict,
  request_type          text        not null,

  -- Opaque pointer to whatever this request is about, e.g.
  -- ('billing.invoice', <invoice id>) - same "no FK to another module's
  -- table" posture as notifications.notification.subject_type/subject_id;
  -- see the file header.
  subject_type          text        not null,
  subject_id            uuid        not null,

  -- Everything the domain module's handler needs to apply the change later -
  -- opaque to this schema and this service. e.g. for the billing credit-note
  -- pilot: { invoiceId, reason, lines }.
  payload               jsonb       not null default '{}',

  requested_by_user_id  uuid        not null references identity.user (id) on delete restrict,

  -- Snapshotted from approvals.policy at request time (or 1, if no policy
  -- existed yet) so a later policy edit never retroactively changes how many
  -- votes an in-flight request needs - same "stamp, don't re-read live"
  -- posture as billing.invoice_line.fee_schedule_version_id.
  approvals_required    integer     not null check (approvals_required >= 1),

  status                text        not null default 'pending'
                          check (status in ('pending', 'approved', 'rejected')),
  created_at            timestamptz not null default now()
);

comment on table approvals.request is
  'An append-only request for sign-off. status starts pending and transitions to approved/rejected EXACTLY ONCE - trg_forbid_request_mutation below refuses any further change, and the service claims the transition with `UPDATE ... WHERE status = ''pending''`, never check-then-write. See the file header.';

create index request_tenant_status_idx on approvals.request (tenant_id, status, created_at desc);
create index request_tenant_type_idx on approvals.request (tenant_id, request_type, created_at desc);
create index request_tenant_subject_idx on approvals.request (tenant_id, subject_type, subject_id);

-- -----------------------------------------------------------------------------
-- approvals.decision
-- -----------------------------------------------------------------------------
create table approvals.decision (
  id                  uuid        primary key default uuidv7(),
  tenant_id           uuid        not null references tenancy.tenant (id) on delete restrict,
  request_id          uuid        not null references approvals.request (id) on delete restrict,
  decided_by_user_id  uuid        not null references identity.user (id) on delete restrict,
  decision            text        not null check (decision in ('approve', 'reject')),
  reason              text,
  decided_at          timestamptz not null default now(),
  -- One decision per (request, decider): the same person voting twice on the
  -- same request is a conflict (23505), not a second vote - this is what
  -- makes "distinct approvers" countable with a plain
  -- `count(distinct decided_by_user_id)` in ApprovalsService.decide.
  unique (request_id, decided_by_user_id)
);

comment on table approvals.decision is
  'Append-only. One row per (request, decider) - see the unique constraint. UPDATE/DELETE are refused outright (trg_forbid_decision_mutation below, and no such grants) - same posture as admissions.application_decision. trg_forbid_self_decision is the database-level enforcement of "a requester cannot decide their own request" - see the file header.';

create index decision_tenant_request_idx on approvals.decision (tenant_id, request_id);

-- -----------------------------------------------------------------------------
-- Enforcement: a requester cannot decide their own request - EVEN for the
-- table owner. This is rule #1 in the module brief and the single most
-- valuable thing this engine adds over the two hand-rolled correction flows
-- it exists to replace (see the file header).
-- -----------------------------------------------------------------------------
create or replace function approvals.forbid_self_decision()
returns trigger
language plpgsql
as $$
declare
  v_requested_by uuid;
begin
  select requested_by_user_id into v_requested_by
  from approvals.request
  where id = new.request_id;

  if v_requested_by is null then
    raise exception 'approvals.decision: request % does not exist', new.request_id;
  end if;

  if v_requested_by = new.decided_by_user_id then
    raise exception
      'approvals.decision: user % requested approval % and cannot decide it themselves - a requester can never approve or reject their own request',
      new.decided_by_user_id, new.request_id;
  end if;

  return new;
end;
$$;

create trigger trg_forbid_self_decision
  before insert on approvals.decision
  for each row execute function approvals.forbid_self_decision();

-- -----------------------------------------------------------------------------
-- Immutability: approvals.decision is append-only.
-- -----------------------------------------------------------------------------
create or replace function approvals.forbid_decision_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'approvals.decision is append-only and cannot be %', lower(tg_op);
end;
$$;

create trigger trg_forbid_decision_update
  before update on approvals.decision
  for each row execute function approvals.forbid_decision_mutation();

create trigger trg_forbid_decision_delete
  before delete on approvals.decision
  for each row execute function approvals.forbid_decision_mutation();

-- -----------------------------------------------------------------------------
-- Immutability: approvals.request may only move pending -> approved|rejected,
-- once, with no other column changing - see the table comment above.
-- -----------------------------------------------------------------------------
create or replace function approvals.forbid_request_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'pending' then
    raise exception
      'approvals.request % has already been decided (status: %) and is immutable', old.id, old.status;
  end if;

  if new.request_type is distinct from old.request_type
    or new.subject_type is distinct from old.subject_type
    or new.subject_id is distinct from old.subject_id
    or new.payload is distinct from old.payload
    or new.requested_by_user_id is distinct from old.requested_by_user_id
    or new.approvals_required is distinct from old.approvals_required
    or new.tenant_id is distinct from old.tenant_id
    or new.created_at is distinct from old.created_at
  then
    raise exception 'approvals.request %: only status may change, and only away from pending', old.id;
  end if;

  if new.status not in ('approved', 'rejected') then
    raise exception 'approvals.request %: status may only transition from pending to approved or rejected', old.id;
  end if;

  return new;
end;
$$;

create trigger trg_forbid_request_mutation
  before update on approvals.request
  for each row execute function approvals.forbid_request_mutation();

create or replace function approvals.forbid_request_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'approvals.request is append-only and cannot be deleted';
end;
$$;

create trigger trg_forbid_request_delete
  before delete on approvals.request
  for each row execute function approvals.forbid_request_delete();

-- -----------------------------------------------------------------------------
-- updated_at maintenance (approvals.policy only - request/decision are
-- append-only and never carry an updated_at).
-- -----------------------------------------------------------------------------
create or replace function approvals.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_set_updated_at before update on approvals.policy
  for each row execute function approvals.set_updated_at();

-- -----------------------------------------------------------------------------
-- Audit history
-- -----------------------------------------------------------------------------
select audit.attach_history('approvals.policy');
select audit.attach_history('approvals.request');
select audit.attach_history('approvals.decision');

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
alter table approvals.policy enable row level security;
create policy policy_tenant_isolation on approvals.policy
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table approvals.request enable row level security;
create policy request_tenant_isolation on approvals.request
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table approvals.decision enable row level security;
create policy decision_tenant_isolation on approvals.decision
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- policy: UPDATE needed for upsert-by-request_type (ApprovalsService.upsertPolicy).
-- No DELETE - a policy is replaced by upserting a new one, never removed
-- (an in-flight request has already snapshotted approvals_required; deleting
-- the policy would only orphan future requestApproval() calls into the
-- fail-closed "no policy" path, which upserting a different one does more
-- honestly).
--
-- request: UPDATE needed for the pending -> approved|rejected claim -
-- trg_forbid_request_mutation above still refuses everything else. No DELETE
-- (see trg_forbid_request_delete above; withholding the grant too is belt
-- and suspenders, same posture as billing.invoice_line).
--
-- decision: INSERT/SELECT only - append-only, see the table comment above.
grant usage on schema approvals to sms_app;
grant select, insert, update on approvals.policy   to sms_app;
grant select, insert, update on approvals.request  to sms_app;
grant select, insert         on approvals.decision to sms_app;
