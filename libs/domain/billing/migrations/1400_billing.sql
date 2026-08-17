-- =============================================================================
-- billing: fee schedules, invoices, payments and credit notes
-- =============================================================================
-- Money is not ordinary data. Five decisions worth calling out up front:
--
--   * NO FLOATING POINT, ANYWHERE. Every monetary column is `amount_minor
--     bigint` (integer minor units - cents, in whichever currency) paired
--     with an ISO-4217 `currency char(3)`. There is no `numeric`/`float`
--     money column in this schema, on purpose - a fractional cent is a bug
--     an auditor finds, not a rounding curiosity.
--
--   * NO STORED BALANCE, ANYWHERE. What a family owes is DERIVED - charges
--     (billing.invoice_line, for issued invoices) minus payments allocated
--     (billing.payment_allocation) minus credits (billing.credit_note_line) -
--     never written to a column. A stored balance drifts the first time any
--     write path forgets to update it and then confidently reports the wrong
--     number; a computed one cannot drift, because there is nothing to
--     forget. See application/balance.service.ts.
--
--   * AN ISSUED INVOICE IS IMMUTABLE IN SUBSTANCE. billing.invoice_line
--     carries the amounts; once the parent invoice's status leaves 'draft',
--     trg_forbid_invoice_line_mutation below refuses INSERT, UPDATE *and*
--     DELETE on its lines outright, and trg_forbid_invoice_mutation refuses
--     any change to the invoice's own identity fields (who/what/currency) or
--     its status. Same posture as communications.announcement/message (see
--     that module's 1350 migration header) and gradebook.grade_scale_version
--     - enforced in the database, not merely by a service-layer check that
--     the first bulk script or admin query bypasses. A correction is a
--     billing.credit_note, never an UPDATE.
--
--   * A PAYMENT IS IDEMPOTENT BY A REQUIRED KEY. billing.payment.
--     idempotency_key is `not null` and unique per tenant - a payment
--     gateway or an impatient bursar WILL retry, and PaymentService.
--     recordPayment writes the payment row and every payment_allocation row
--     in ONE transaction keyed on it (`on conflict (tenant_id,
--     idempotency_key) do nothing`), same discipline as
--     @sms/notifications' notify() (see docs/decisions.md's "A dedupe key
--     must guard a write that is already atomic" - this schema exists
--     because that exact bug class is already documented once).
--
--   * A FEE COMPONENT IS PRICED FROM A VERSION, AND THE INVOICE LINE RECORDS
--     WHICH ONE. billing.fee_schedule_version is an immutable, dated
--     snapshot - exactly like gradebook.grade_scale_version (see that
--     module's 1000 migration header) - and billing.invoice_line stamps
--     fee_schedule_version_id (and fee_component_id) at the moment it is
--     priced, never re-read from a live join. A fee increase next term does
--     not retroactively reprice an invoice already handed to a family.
--
-- billing.payment is explicitly ALLOCATED to invoices via
-- billing.payment_allocation; any amount left over after allocating sits as
-- unapplied credit on the payer's account (computed the same way a balance
-- is - never written down), never turned into a negative invoice total.
-- =============================================================================

create schema billing;

-- -----------------------------------------------------------------------------
-- billing.fee_schedule / billing.fee_schedule_version / billing.fee_component
-- -----------------------------------------------------------------------------
create table billing.fee_schedule (
  id                 uuid primary key default uuidv7(),
  tenant_id          uuid not null references tenancy.tenant (id) on delete restrict,
  academic_year_id   uuid not null references tenancy.academic_year (id) on delete restrict,
  name               text not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, name)
);

comment on table billing.fee_schedule is
  'A named set of charges for an academic year (e.g. "2025-2026 Tuition & Fees"). Never priced directly - see billing.fee_schedule_version.';

create index fee_schedule_tenant_year_idx on billing.fee_schedule (tenant_id, academic_year_id);

create table billing.fee_schedule_version (
  id                 uuid primary key default uuidv7(),
  tenant_id          uuid not null references tenancy.tenant (id) on delete restrict,
  fee_schedule_id    uuid not null references billing.fee_schedule (id) on delete restrict,
  version            integer not null,
  -- The currency every fee_component under this version is priced in - one
  -- currency per version, so a single invoice built from one version's
  -- components never has to reconcile two currencies line-by-line.
  currency           char(3) not null,
  effective_from     date not null default current_date,
  created_at         timestamptz not null default now(),
  unique (fee_schedule_id, version)
);

comment on table billing.fee_schedule_version is
  'An IMMUTABLE priced snapshot of one fee_schedule, effective from a date - same shape as gradebook.grade_scale_version (see this file''s own header). billing.invoice_line.fee_schedule_version_id points here, stamped at invoice time, never re-read live. Never UPDATEd or DELETEd past creation (trg_forbid_fsv_mutation below).';

create index fee_schedule_version_tenant_schedule_idx on billing.fee_schedule_version (tenant_id, fee_schedule_id, effective_from desc);

create table billing.fee_component (
  id                       uuid primary key default uuidv7(),
  tenant_id                uuid not null references tenancy.tenant (id) on delete restrict,
  fee_schedule_version_id  uuid not null references billing.fee_schedule_version (id) on delete restrict,
  code                     text not null,
  name                     text not null,
  amount_minor             bigint not null check (amount_minor > 0),
  created_at               timestamptz not null default now(),
  unique (fee_schedule_version_id, code)
);

comment on table billing.fee_component is
  'One priced line item within a fee_schedule_version (e.g. "TUITION" -> $4,200.00, stored as amount_minor = 420000). Written once, alongside its version, and never edited - see this file''s own header on integer minor units. No UPDATE grant below (belt and suspenders, same posture as records.report_card).';

create index fee_component_tenant_version_idx on billing.fee_component (tenant_id, fee_schedule_version_id);

-- -----------------------------------------------------------------------------
-- billing.invoice / billing.invoice_line
-- -----------------------------------------------------------------------------
-- FOR a student, optionally ADDRESSED TO a payer (a guardian) - the two are
-- deliberately separate columns. A parent's billing.invoice:read grant is
-- 'dependants'-scoped against student_person_id (their own children), not
-- payer_person_id - see BillingController's own comment.
create table billing.invoice (
  id                    uuid primary key default uuidv7(),
  tenant_id             uuid not null references tenancy.tenant (id) on delete restrict,
  student_person_id     uuid not null references people.person (id) on delete restrict,
  payer_person_id       uuid references people.person (id) on delete restrict,
  currency              char(3) not null,
  status                text not null default 'draft' check (status in ('draft', 'issued')),
  due_date              date,
  issued_at             timestamptz,
  issued_by_user_id     uuid references identity.user (id) on delete restrict,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint invoice_issued_consistency check (
    (status = 'draft' and issued_at is null)
    or
    (status = 'issued' and issued_at is not null)
  )
);

comment on table billing.invoice is
  'One bill for a student, optionally addressed to a payer. Immutable in substance once status <> ''draft'' (trg_forbid_invoice_mutation below refuses any change to who/what/currency/status) - correcting an issued invoice is billing.credit_note, never an UPDATE. Carries no balance/amount column - see this file''s own header; the total is sum(billing.invoice_line.amount_minor).';

create index invoice_tenant_student_idx on billing.invoice (tenant_id, student_person_id, created_at desc);
create index invoice_tenant_payer_idx on billing.invoice (tenant_id, payer_person_id);
create index invoice_tenant_status_idx on billing.invoice (tenant_id, status, due_date);

create table billing.invoice_line (
  id                       uuid primary key default uuidv7(),
  tenant_id                uuid not null references tenancy.tenant (id) on delete restrict,
  invoice_id               uuid not null references billing.invoice (id) on delete restrict,
  fee_component_id         uuid not null references billing.fee_component (id) on delete restrict,
  -- Stamped at insert time from fee_component_id's own version - see this
  -- file's own header on why a line records the VERSION it was priced from
  -- rather than joining fee_component -> fee_schedule_version live.
  fee_schedule_version_id  uuid not null references billing.fee_schedule_version (id) on delete restrict,
  -- Copied in from fee_component.name at insert time (not joined live) so
  -- the line reads correctly even if the component is later renamed in a
  -- newer, unrelated fee_schedule_version - same posture as
  -- records.transcript_entry.course_name.
  description              text not null,
  amount_minor             bigint not null check (amount_minor > 0),
  created_at               timestamptz not null default now()
);

comment on table billing.invoice_line is
  'One charge on an invoice, priced from fee_component_id at fee_schedule_version_id (stamped, never re-read live). trg_forbid_invoice_line_mutation below refuses INSERT, UPDATE and DELETE outright once the parent invoice''s status leaves ''draft''.';

create index invoice_line_tenant_invoice_idx on billing.invoice_line (tenant_id, invoice_id);

-- -----------------------------------------------------------------------------
-- billing.payment / billing.payment_allocation
-- -----------------------------------------------------------------------------
-- Append-only facts - a recorded payment is never edited or deleted, only
-- allocated. idempotency_key is REQUIRED (not null) and unique per tenant -
-- see this file's own header and application/payment.service.ts.
create table billing.payment (
  id                    uuid primary key default uuidv7(),
  tenant_id             uuid not null references tenancy.tenant (id) on delete restrict,
  payer_person_id       uuid not null references people.person (id) on delete restrict,
  amount_minor          bigint not null check (amount_minor > 0),
  currency              char(3) not null,
  method                text not null default 'other',
  idempotency_key       text not null,
  received_at           timestamptz not null default now(),
  recorded_by_user_id   uuid references identity.user (id) on delete restrict,
  created_at            timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

comment on table billing.payment is
  'Money received from a payer. Append-only (no UPDATE/DELETE grant below) - idempotency_key makes a retried recordPayment call a no-op that returns the ORIGINAL payment, never a duplicate credit. Any amount not allocated to an invoice (billing.payment_allocation) is unapplied credit on the payer''s account, computed - never stored as a negative invoice, see this file''s own header.';

create index payment_tenant_payer_idx on billing.payment (tenant_id, payer_person_id, received_at desc);

create table billing.payment_allocation (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references tenancy.tenant (id) on delete restrict,
  payment_id     uuid not null references billing.payment (id) on delete restrict,
  invoice_id     uuid not null references billing.invoice (id) on delete restrict,
  amount_minor   bigint not null check (amount_minor > 0),
  created_at     timestamptz not null default now(),
  unique (payment_id, invoice_id)
);

comment on table billing.payment_allocation is
  'How much of one payment was applied to one invoice - explicit, never inferred. Written in the SAME transaction as the billing.payment row it belongs to (see application/payment.service.ts). Append-only, same posture as billing.payment.';

create index payment_allocation_tenant_invoice_idx on billing.payment_allocation (tenant_id, invoice_id);
create index payment_allocation_tenant_payment_idx on billing.payment_allocation (tenant_id, payment_id);

-- -----------------------------------------------------------------------------
-- billing.credit_note / billing.credit_note_line
-- -----------------------------------------------------------------------------
-- The ONLY way to correct an issued invoice - see this file's own header.
-- Written complete (with its lines) in one call; there is no draft state and
-- no later edit, same "append-only fact" posture as billing.payment.
create table billing.credit_note (
  id                    uuid primary key default uuidv7(),
  tenant_id             uuid not null references tenancy.tenant (id) on delete restrict,
  invoice_id            uuid not null references billing.invoice (id) on delete restrict,
  reason                text not null,
  issued_at             timestamptz not null default now(),
  issued_by_user_id     uuid references identity.user (id) on delete restrict,
  created_at            timestamptz not null default now()
);

comment on table billing.credit_note is
  'A reduction against an issued invoice - never an edit of billing.invoice/billing.invoice_line. Append-only (no UPDATE/DELETE grant below).';

create index credit_note_tenant_invoice_idx on billing.credit_note (tenant_id, invoice_id);

create table billing.credit_note_line (
  id                 uuid primary key default uuidv7(),
  tenant_id          uuid not null references tenancy.tenant (id) on delete restrict,
  credit_note_id     uuid not null references billing.credit_note (id) on delete restrict,
  invoice_line_id    uuid references billing.invoice_line (id) on delete restrict,
  description        text not null,
  amount_minor       bigint not null check (amount_minor > 0),
  created_at         timestamptz not null default now()
);

comment on table billing.credit_note_line is
  'One credited amount within a credit_note, optionally tied to the specific billing.invoice_line it corrects. Append-only, same posture as billing.credit_note.';

create index credit_note_line_tenant_note_idx on billing.credit_note_line (tenant_id, credit_note_id);

-- -----------------------------------------------------------------------------
-- Immutability: billing.fee_schedule_version (and its billing.fee_component
-- rows, via withheld grants below) - never UPDATEd or DELETEd past creation.
-- -----------------------------------------------------------------------------
create or replace function billing.forbid_fee_schedule_version_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'billing.fee_schedule_version is an immutable published version and cannot be % - publish a new version instead', lower(tg_op);
end;
$$;

create trigger trg_forbid_fsv_update before update on billing.fee_schedule_version
  for each row execute function billing.forbid_fee_schedule_version_mutation();
create trigger trg_forbid_fsv_delete before delete on billing.fee_schedule_version
  for each row execute function billing.forbid_fee_schedule_version_mutation();

-- -----------------------------------------------------------------------------
-- Immutability: billing.invoice - once status <> 'draft', no identity field
-- (who/what/currency/due_date) or the status itself may change. This is the
-- database-level enforcement rule #3 in the module brief calls for - not
-- merely a service-layer check.
-- -----------------------------------------------------------------------------
create or replace function billing.forbid_invoice_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'draft' and (
    new.student_person_id is distinct from old.student_person_id
    or new.payer_person_id is distinct from old.payer_person_id
    or new.currency is distinct from old.currency
    or new.due_date is distinct from old.due_date
    or new.status is distinct from old.status
  ) then
    raise exception 'billing.invoice % is issued and is immutable - correct it with a credit note, not an update', old.id;
  end if;
  return new;
end;
$$;

create trigger trg_forbid_invoice_mutation before update on billing.invoice
  for each row execute function billing.forbid_invoice_mutation();

-- -----------------------------------------------------------------------------
-- Immutability: billing.invoice_line - INSERT, UPDATE and DELETE are all
-- refused outright once the parent invoice's status leaves 'draft'. This is
-- what actually enforces "an issued invoice cannot be mutated" (the amounts
-- live here, not on billing.invoice itself).
-- -----------------------------------------------------------------------------
create or replace function billing.forbid_invoice_line_mutation()
returns trigger
language plpgsql
as $$
declare
  v_invoice_id uuid := coalesce(new.invoice_id, old.invoice_id);
  v_status     text;
begin
  select status into v_status from billing.invoice where id = v_invoice_id;
  if v_status is distinct from 'draft' then
    raise exception 'billing.invoice_line: invoice % is % and its lines are immutable - correct it with a credit note, not an %', v_invoice_id, coalesce(v_status, 'unknown'), lower(tg_op);
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger trg_forbid_invoice_line_insert before insert on billing.invoice_line
  for each row execute function billing.forbid_invoice_line_mutation();
create trigger trg_forbid_invoice_line_update before update on billing.invoice_line
  for each row execute function billing.forbid_invoice_line_mutation();
create trigger trg_forbid_invoice_line_delete before delete on billing.invoice_line
  for each row execute function billing.forbid_invoice_line_mutation();

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function billing.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_set_updated_at before update on billing.fee_schedule
  for each row execute function billing.set_updated_at();
create trigger trg_set_updated_at before update on billing.invoice
  for each row execute function billing.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
alter table billing.fee_schedule enable row level security;
create policy fee_schedule_tenant_isolation on billing.fee_schedule
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table billing.fee_schedule_version enable row level security;
create policy fee_schedule_version_tenant_isolation on billing.fee_schedule_version
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table billing.fee_component enable row level security;
create policy fee_component_tenant_isolation on billing.fee_component
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table billing.invoice enable row level security;
create policy invoice_tenant_isolation on billing.invoice
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table billing.invoice_line enable row level security;
create policy invoice_line_tenant_isolation on billing.invoice_line
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table billing.payment enable row level security;
create policy payment_tenant_isolation on billing.payment
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table billing.payment_allocation enable row level security;
create policy payment_allocation_tenant_isolation on billing.payment_allocation
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table billing.credit_note enable row level security;
create policy credit_note_tenant_isolation on billing.credit_note
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table billing.credit_note_line enable row level security;
create policy credit_note_line_tenant_isolation on billing.credit_note_line
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Audit history
-- -----------------------------------------------------------------------------
select audit.attach_history('billing.fee_schedule');
select audit.attach_history('billing.fee_schedule_version');
select audit.attach_history('billing.fee_component');
select audit.attach_history('billing.invoice');
select audit.attach_history('billing.invoice_line');
select audit.attach_history('billing.payment');
select audit.attach_history('billing.payment_allocation');
select audit.attach_history('billing.credit_note');
select audit.attach_history('billing.credit_note_line');

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Migrations run as sms_owner, which owns these tables; sms_app gets no
-- default privileges on objects sms_owner creates, so every table needs
-- explicit grants. sms_app is NOBYPASSRLS and owns nothing here (arch-check.ts
-- checks 3 and 4).
--
-- fee_schedule: UPDATE needed to rename before any version is published.
-- fee_schedule_version: UPDATE is granted but immaterial - trg_forbid_fsv_
-- mutation above rejects every attempt outright, same posture as
-- gradebook.grade_scale_version / records.credit_rule_set_version.
-- fee_component: INSERT/SELECT only - written once alongside its version and
-- never edited; withholding UPDATE/DELETE entirely means the "never edited"
-- posture does not depend on a trigger existing for this specific table
-- (belt and suspenders, same posture as records.report_card).
-- invoice: UPDATE needed to transition draft -> issued and for in-draft edits
-- (due_date, payer) - trg_forbid_invoice_mutation above still refuses every
-- field once issued. No DELETE - a draft is corrected in place or simply
-- never issued; an issued invoice is corrected with a credit note.
-- invoice_line: INSERT/SELECT only - trg_forbid_invoice_line_mutation above
-- already refuses INSERT/UPDATE/DELETE once the parent invoice is issued,
-- but withholding UPDATE/DELETE entirely means an issued invoice's lines
-- cannot be touched even if that trigger were ever dropped by mistake.
-- payment / payment_allocation / credit_note / credit_note_line: INSERT/
-- SELECT only - append-only facts, see each table's own comment above.
grant usage on schema billing to sms_app;
grant select, insert, update  on billing.fee_schedule           to sms_app;
grant select, insert, update  on billing.fee_schedule_version   to sms_app;
grant select, insert           on billing.fee_component          to sms_app;
grant select, insert, update  on billing.invoice                to sms_app;
grant select, insert           on billing.invoice_line           to sms_app;
grant select, insert           on billing.payment                to sms_app;
grant select, insert           on billing.payment_allocation     to sms_app;
grant select, insert           on billing.credit_note            to sms_app;
grant select, insert           on billing.credit_note_line       to sms_app;
