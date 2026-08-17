-- =============================================================================
-- admissions: basic admissions pipeline - capture an enquiry/application, move
--             it through a pipeline, record a decision, and hand an accepted
--             applicant to enrolment
-- =============================================================================
-- Phase 1 scope is deliberately small: not a marketing CRM, just enough to
-- run "someone enquired -> applied -> was assessed -> was offered a place ->
-- accepted/rejected/withdrew -> (if accepted) became a real student".
--
-- Three decisions worth calling out up front:
--
--   1. AN APPLICANT IS NOT YET A PERSON. admissions.application carries the
--      applicant's own details (name/DOB/guardian contact) directly, plus an
--      OPTIONAL person_id for when the family is already known (a sibling
--      applying, or a re-application). A people.person row is created only
--      on ACCEPTANCE - see admissions.application.converted_at below and
--      @sms/admissions' DecisionService.ensureConverted. Creating a person
--      for every enquiry would pollute the student directory with people who
--      never join the school, and is very hard to undo (people.person grants
--      no DELETE - see decisions.md's "Reverting an import archives, it does
--      not delete").
--
--   2. THE PIPELINE HAS TWO DIFFERENT KINDS OF MOVE, matching the permission
--      split (admissions.application:write vs :decide - "recording an
--      applicant's details is clerical work, making an offer is not"):
--        - CLERICAL progression (enquiry -> applied -> assessment) is a
--          "stage move", :write-gated, appended to
--          admissions.application_stage_history.
--        - CONSEQUENTIAL outcomes (offered/accepted/rejected/withdrawn) are
--          "decisions", :decide-gated, appended to
--          admissions.application_decision.
--      Both histories are APPEND-ONLY, enforced by trigger AND by grants
--      (sms_app gets no UPDATE/DELETE on either) - same idiom as
--      communications.message (see @sms/communications' 1350 migration) and
--      enrollment.status_event (see @sms/enrollment's 0700 migration). "Who
--      decided what, when, and why" must be answerable months later - an
--      admissions decision gets challenged by parents, and a status column
--      that was simply overwritten cannot defend itself. A reversal (e.g. a
--      family declines an offer after accepting it) is a NEW decision row
--      (accepted -> withdrawn is a legal decision transition - see
--      isLegalDecision in @sms/admissions' domain/types.ts), never an edit
--      of the old one.
--
--   3. CONVERTING AN ACCEPTED APPLICATION TO AN ENROLMENT MUST BE IDEMPOTENT.
--      admissions.application.converted_at is the idempotency guard:
--      DecisionService.ensureConverted claims it with a single
--      `UPDATE ... WHERE converted_at IS NULL RETURNING *` - the check (has
--      this application already been converted) and the claim (mark it
--      converted) happen as ONE atomic statement, so two concurrent accept
--      calls can never both claim it. The actual person/enrolment creation
--      happens AFTER the claim, through @sms/people's and @sms/enrollment's
--      PUBLIC CONTRACTS (never this schema's tables directly - both are
--      type:domain, so importing a sibling's published contract is the
--      established pattern, same as @sms/attendance reaching @sms/academic/
--      @sms/people) - each contract call is its own transaction (nesting
--      transactions across module boundaries is what deadlocked withAuthTx
--      inside Better Auth's session hook - see decisions.md), so this is NOT
--      one single database transaction end to end. What IS guaranteed: at
--      most one caller ever wins the claim, @sms/enrollment's own
--      (tenant, person, academic_year) unique constraint independently
--      refuses a second enrolment for the same person/year regardless of
--      which code path attempted it, and converted_enrollment_id/person_id
--      are written back immediately after each step succeeds to keep the
--      window between "claimed" and "fully recorded" as small as possible -
--      the same bounded-residual posture decisions.md's "A dedupe key must
--      guard a write that is already atomic" entry describes for
--      notifications.notification, adapted to a cross-module handoff that
--      cannot itself be a single transaction.
--
-- admissions.application.converted_enrollment_id is deliberately NOT a
-- foreign key: @sms/enrollment is a peer type:domain module reached only
-- through ENROLLMENT_CONTRACT, never this schema directly - same untyped-
-- reference reasoning as communications.thread.subject_id (see
-- @sms/communications' 1350 migration header).
-- =============================================================================

create schema admissions;

-- -----------------------------------------------------------------------------
-- admissions.application
-- -----------------------------------------------------------------------------
create table admissions.application (
  id                        uuid primary key default uuidv7(),
  tenant_id                 uuid not null references tenancy.tenant (id) on delete restrict,
  -- OPTIONAL - see the file header's point 1. Set at submission time when the
  -- family is already known (a sibling applying, a re-application), or by
  -- DecisionService.ensureConverted on acceptance when it was not.
  person_id                 uuid references people.person (id) on delete restrict,
  applicant_given_name      text not null,
  applicant_family_name     text not null,
  applicant_date_of_birth   date,
  applicant_gender          text,
  guardian_name             text,
  guardian_email            text,
  guardian_phone            text,
  desired_academic_year_id  uuid not null references tenancy.academic_year (id) on delete restrict,
  desired_campus_id         uuid not null references tenancy.campus (id) on delete restrict,
  desired_grade_level_id    uuid not null references academic.grade_level (id) on delete restrict,
  -- Tenant-chosen free text ("website", "referral", "open day") - not an
  -- enum, same reasoning as attendance.code.label / communications.
  -- announcement.category: a closed system vocabulary is not what schools
  -- want here either.
  source                    text,
  current_stage             text not null default 'enquiry'
    check (current_stage in ('enquiry', 'applied', 'assessment', 'offered', 'accepted', 'rejected', 'withdrawn')),
  -- The idempotency guard for convertToEnrolment - see the file header's
  -- point 3. null until claimed; never cleared once set.
  converted_at              timestamptz,
  converted_enrollment_id   uuid,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

comment on table admissions.application is
  'One row per applicant enquiry/application. current_stage is denormalised from the newest admissions.application_stage_history or admissions.application_decision row for this application - never written independently of one of them (see @sms/admissions'' ApplicationRecordService.moveStage / DecisionService.recordDecision). person_id is null until the family is known or the application is accepted - see the file header''s point 1.';

create index application_tenant_stage_idx on admissions.application (tenant_id, current_stage);
create index application_tenant_person_idx on admissions.application (tenant_id, person_id);
create index application_tenant_year_idx on admissions.application (tenant_id, desired_academic_year_id);

-- -----------------------------------------------------------------------------
-- admissions.application_stage_history
-- -----------------------------------------------------------------------------
-- Append-only clerical pipeline trail - see the file header's point 2.
-- trg_forbid_stage_history_mutation below rejects any UPDATE or DELETE
-- outright, and sms_app is not even granted those privileges (belt and
-- suspenders, same posture as communications.message).
create table admissions.application_stage_history (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references tenancy.tenant (id) on delete restrict,
  application_id uuid not null references admissions.application (id) on delete restrict,
  from_stage     text check (from_stage in ('enquiry', 'applied', 'assessment', 'offered', 'accepted', 'rejected', 'withdrawn')),
  to_stage       text not null check (to_stage in ('enquiry', 'applied', 'assessment', 'offered', 'accepted', 'rejected', 'withdrawn')),
  note           text,
  actor_user_id  uuid,
  occurred_on    date not null default current_date,
  created_at     timestamptz not null default now()
);

comment on table admissions.application_stage_history is
  'Append-only history of clerical pipeline moves (:write-gated). Never updated or deleted - see trg_forbid_stage_history_update/_delete below. Consequential moves (offered/accepted/rejected/withdrawn) live in admissions.application_decision instead - see the file header''s point 2.';

create index stage_history_tenant_application_idx on admissions.application_stage_history (tenant_id, application_id, created_at);

-- -----------------------------------------------------------------------------
-- admissions.application_decision
-- -----------------------------------------------------------------------------
-- Append-only decision trail - see the file header's point 2.
create table admissions.application_decision (
  id                  uuid primary key default uuidv7(),
  tenant_id           uuid not null references tenancy.tenant (id) on delete restrict,
  application_id      uuid not null references admissions.application (id) on delete restrict,
  from_stage          text not null check (from_stage in ('enquiry', 'applied', 'assessment', 'offered', 'accepted', 'rejected', 'withdrawn')),
  outcome             text not null check (outcome in ('offered', 'accepted', 'rejected', 'withdrawn')),
  reason              text,
  decided_by_user_id  uuid references identity.user (id) on delete restrict,
  decided_on          date not null default current_date,
  created_at          timestamptz not null default now()
);

comment on table admissions.application_decision is
  'Append-only history of every admissions decision (:decide-gated) - offered/accepted/rejected/withdrawn, with who decided and why. Never updated or deleted - see trg_forbid_decision_update/_delete below. "Who decided what, when, and why" must be answerable months later; a reversal (e.g. accepted -> withdrawn) is a NEW row, never an edit of an old one.';

create index decision_tenant_application_idx on admissions.application_decision (tenant_id, application_id, created_at);

-- -----------------------------------------------------------------------------
-- admissions.application_stage_history / application_decision are append-only
-- -----------------------------------------------------------------------------
create or replace function admissions.forbid_stage_history_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'admissions.application_stage_history is append-only history and cannot be %', lower(tg_op);
end;
$$;

create trigger trg_forbid_stage_history_update before update on admissions.application_stage_history
  for each row execute function admissions.forbid_stage_history_mutation();
create trigger trg_forbid_stage_history_delete before delete on admissions.application_stage_history
  for each row execute function admissions.forbid_stage_history_mutation();

create or replace function admissions.forbid_decision_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'admissions.application_decision is append-only history and cannot be %', lower(tg_op);
end;
$$;

create trigger trg_forbid_decision_update before update on admissions.application_decision
  for each row execute function admissions.forbid_decision_mutation();
create trigger trg_forbid_decision_delete before delete on admissions.application_decision
  for each row execute function admissions.forbid_decision_mutation();

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function admissions.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_set_updated_at before update on admissions.application
  for each row execute function admissions.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
alter table admissions.application enable row level security;
create policy application_tenant_isolation on admissions.application
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table admissions.application_stage_history enable row level security;
create policy application_stage_history_tenant_isolation on admissions.application_stage_history
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table admissions.application_decision enable row level security;
create policy application_decision_tenant_isolation on admissions.application_decision
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Audit history
-- -----------------------------------------------------------------------------
select audit.attach_history('admissions.application');
select audit.attach_history('admissions.application_stage_history');
select audit.attach_history('admissions.application_decision');

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Migrations run as sms_owner, which owns these tables; sms_app gets no
-- default privileges on objects sms_owner creates, so every table needs
-- explicit grants. sms_app is NOBYPASSRLS and owns nothing here (arch-check.ts
-- checks 3 and 4).
--
-- application: UPDATE needed for current_stage (moveStage/recordDecision),
-- person_id/converted_at/converted_enrollment_id (DecisionService.
-- ensureConverted's claim-then-complete steps). No DELETE - an application is
-- never removed, only progressed/decided.
-- application_stage_history / application_decision: INSERT/SELECT only - the
-- append-only triggers above enforce this too, and withholding the UPDATE/
-- DELETE grants entirely means the refusal does not depend on the trigger
-- alone (belt and suspenders, same posture as communications.message /
-- enrollment.status_event's own grants).
grant usage on schema admissions to sms_app;
grant select, insert, update on admissions.application                to sms_app;
grant select, insert         on admissions.application_stage_history  to sms_app;
grant select, insert         on admissions.application_decision       to sms_app;
