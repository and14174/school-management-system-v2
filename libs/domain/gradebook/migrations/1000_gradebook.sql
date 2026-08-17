-- =============================================================================
-- gradebook: grade scales, calculation rules, assignments/scores, corrections,
--            grading-period locking, and standards-based outcome results
-- =============================================================================
-- Four decisions worth calling out up front:
--
--   * A SCORE POINTS AT THE GRADE-SCALE VERSION, NEVER THE SCALE. Editing a
--     scale (gradebook.grade_scale) never touches its existing rows - it
--     creates a NEW gradebook.grade_scale_version, immutable from the moment
--     it is published (trg_forbid_version_mutation below refuses UPDATE and
--     DELETE outright, same posture as attendance.correction's append-only
--     enforcement). gradebook.score.grade_scale_version_id is resolved and
--     stored ONCE, at grading time, and never re-resolved later. When a
--     school changes its scale mid-year, last year's report cards keep
--     resolving through the version that was in effect when they were
--     graded - a transcript that silently re-grades itself the day the
--     scale changes is a legal problem, not a display bug.
--   * gradebook.calculation_rule_set follows the exact same versioned/
--     immutable shape, for the same reason: WEIGHTING, DROP-LOWEST-N, AND
--     ROUNDING are policy, not per-row state, and a school edits its
--     weighting scheme without wanting every already-computed grade for a
--     closed grading period to silently reweight itself. The version's
--     `rules` jsonb is interpreted by ONE evaluator
--     (@sms/gradebook's application/evaluator.ts) - never branched on by
--     "scheme" in code - and is keyed by CATEGORY NAME (not id), so the
--     SAME published rule set is reusable across every section that names
--     its categories the same way (see the seed: one "Standard Weighted"
--     rule set drives every seeded section's Homework/Quizzes/Exams split).
--     gradebook.category's own `weight`/`drop_lowest` columns are the
--     mutable, structural, per-section defaults an admin edits when setting
--     up a section (what a category-editing UI reads/writes); the versioned
--     rule set is the policy of record calculateSectionGrades actually
--     evaluates against - decoupled on purpose, same reasoning as the scale.
--   * LOCKING IS ENFORCED IN THE DATABASE, not just in application code (contrast
--     attendance's free-edit window, which is service-enforced because "now
--     minus marked_at" cannot be a CHECK constraint - a grading-period lock
--     has no such excuse: it is a simple boolean fact a trigger can look up).
--     trg_check_score_lock below rejects any INSERT/UPDATE on gradebook.score
--     whose assignment belongs to a LOCKED grading period, with exactly one
--     escape hatch: the transaction-local GUC app.gradebook_correction_override,
--     set (via set_config(..., true) - SET LOCAL semantics, never plain SET -
--     see docs/decisions.md) by GradingCorrectionService.decideCorrection
--     immediately before it applies an APPROVED correction. That is the ONLY
--     legitimate route past a lock, mirroring attendance.correction /
--     enrollment.status_event's role as the sole path past their own
--     invariants.
--   * BOTH TRADITIONAL AND STANDARDS-BASED GRADING are first-class: points/
--     percentage resolving to a letter via a scale (gradebook.score +
--     grade_scale*), AND proficiency levels against learning outcomes
--     (gradebook.learning_outcome + gradebook.outcome_result) - neither
--     bolted onto the other; a school can run both at once per section.
--
-- Writes are additionally gated by tenancy.assert_year_writable (read, never
-- edited - see the module report's constraints), resolved via
-- section_id -> academic.section.term_id -> academic.term.academic_year_id,
-- for category/assignment/score - same trigger idiom as academic's own
-- 0600 migration (check_section_year_writable etc.), just one hop further.
-- =============================================================================

create schema gradebook;

-- -----------------------------------------------------------------------------
-- gradebook.grade_scale / gradebook.grade_scale_version
-- -----------------------------------------------------------------------------
create table gradebook.grade_scale (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenancy.tenant (id) on delete restrict,
  name        text not null,
  kind        text not null check (kind in ('points', 'percentage', 'letter', 'standards')),
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, name)
);

comment on table gradebook.grade_scale is
  'A named grade scale (e.g. "Standard A-F"). Never edited in place past its first version - see gradebook.grade_scale_version and this file''s own header.';

create index grade_scale_tenant_idx on gradebook.grade_scale (tenant_id);

-- At most one default scale per tenant - a partial unique index, not an
-- application-level promise a second write path could bypass. Same
-- technique as attendance.code_one_default_idx / tenancy.campus's
-- one-default-campus index.
create unique index grade_scale_one_default_idx on gradebook.grade_scale (tenant_id) where is_default;

create table gradebook.grade_scale_version (
  id              uuid primary key default uuidv7(),
  tenant_id       uuid not null references tenancy.tenant (id) on delete restrict,
  grade_scale_id  uuid not null references gradebook.grade_scale (id) on delete restrict,
  version         integer not null,
  -- e.g. [{ "label": "A", "min": 90, "gpaPoints": 4.0 }, { "label": "B", "min": 80, "gpaPoints": 3.0 }, ...]
  -- Sorted by `min` descending at read time by the application (not assumed
  -- here) - the evaluator picks the highest band whose `min` <= the
  -- resolved percentage.
  bands           jsonb not null,
  effective_from  date not null default current_date,
  created_at      timestamptz not null default now(),
  unique (grade_scale_id, version)
);

comment on table gradebook.grade_scale_version is
  'An IMMUTABLE snapshot of one grade_scale''s bands, effective from a date. gradebook.score.grade_scale_version_id points here, never at grade_scale directly - see this file''s own header. Never UPDATEd or DELETEd past creation (trg_forbid_version_mutation below).';

create index grade_scale_version_tenant_scale_idx on gradebook.grade_scale_version (tenant_id, grade_scale_id, effective_from desc);

-- -----------------------------------------------------------------------------
-- gradebook.calculation_rule_set / gradebook.calculation_rule_set_version
-- -----------------------------------------------------------------------------
create table gradebook.calculation_rule_set (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenancy.tenant (id) on delete restrict,
  name        text not null,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, name)
);

comment on table gradebook.calculation_rule_set is
  'A named weighting/drop-lowest/rounding policy (e.g. "Standard Weighted"). Never edited in place past its first version - see gradebook.calculation_rule_set_version and this file''s own header.';

create index calculation_rule_set_tenant_idx on gradebook.calculation_rule_set (tenant_id);

create unique index calculation_rule_set_one_default_idx on gradebook.calculation_rule_set (tenant_id) where is_default;

create table gradebook.calculation_rule_set_version (
  id                      uuid primary key default uuidv7(),
  tenant_id               uuid not null references tenancy.tenant (id) on delete restrict,
  calculation_rule_set_id uuid not null references gradebook.calculation_rule_set (id) on delete restrict,
  version                 integer not null,
  -- { "rounding": { "decimals": 1, "mode": "half-up" },
  --   "categories": [ { "name": "Homework", "weight": 20, "dropLowest": 1 }, ... ] }
  -- Interpreted by ONE evaluator (application/evaluator.ts), never branched
  -- on by scheme - see this file's own header. Keyed by category NAME so one
  -- rule set is reusable across every section that names its categories the
  -- same way.
  rules                   jsonb not null,
  effective_from          date not null default current_date,
  created_at              timestamptz not null default now(),
  unique (calculation_rule_set_id, version)
);

comment on table gradebook.calculation_rule_set_version is
  'An IMMUTABLE snapshot of one calculation_rule_set''s weighting/drop-lowest/rounding policy, effective from a date. Never UPDATEd or DELETEd past creation (trg_forbid_version_mutation below).';

create index calc_rule_set_version_tenant_set_idx on gradebook.calculation_rule_set_version (tenant_id, calculation_rule_set_id, effective_from desc);

-- -----------------------------------------------------------------------------
-- gradebook.category
-- -----------------------------------------------------------------------------
-- Structural, mutable, per-section - see this file's own header for why this
-- is deliberately decoupled from calculation_rule_set_version (the policy of
-- record an actual calculation evaluates against).
create table gradebook.category (
  id           uuid primary key default uuidv7(),
  tenant_id    uuid not null references tenancy.tenant (id) on delete restrict,
  section_id   uuid not null references academic.section (id) on delete restrict,
  name         text not null,
  weight       numeric not null default 0,
  drop_lowest  integer not null default 0 check (drop_lowest >= 0),
  sequence     integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, section_id, name)
);

create index category_tenant_section_idx on gradebook.category (tenant_id, section_id);

-- -----------------------------------------------------------------------------
-- gradebook.assignment
-- -----------------------------------------------------------------------------
create table gradebook.assignment (
  id                 uuid primary key default uuidv7(),
  tenant_id          uuid not null references tenancy.tenant (id) on delete restrict,
  section_id         uuid not null references academic.section (id) on delete restrict,
  category_id        uuid not null references gradebook.category (id) on delete restrict,
  grading_period_id  uuid not null references academic.grading_period (id) on delete restrict,
  title              text not null,
  description        text,
  points_possible    numeric not null check (points_possible > 0),
  due_on             date,
  published          boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table gradebook.assignment is
  'One gradeable item. published=false is a draft: scores may still be entered against it (gradebook.score_entered fires), but gradebook.grade_posted only fires once the assignment - or the individual score - is published, so students/guardians are never notified of a grade before the teacher meant to show it.';

create index assignment_tenant_section_idx on gradebook.assignment (tenant_id, section_id);
create index assignment_tenant_category_idx on gradebook.assignment (tenant_id, category_id);
create index assignment_tenant_grading_period_idx on gradebook.assignment (tenant_id, grading_period_id);

-- category_id's section must match assignment.section_id - defense in depth,
-- same reasoning as access.check_role_permission_tenant.
create or replace function gradebook.check_assignment_category_section()
returns trigger
language plpgsql
as $$
declare
  v_category_section_id uuid;
begin
  select section_id into v_category_section_id from gradebook.category where id = new.category_id;
  if v_category_section_id is null then
    raise exception 'gradebook.assignment: category % not found', new.category_id;
  end if;
  if v_category_section_id <> new.section_id then
    raise exception 'gradebook.assignment: category % belongs to section %, not %', new.category_id, v_category_section_id, new.section_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger trg_check_assignment_category_section before insert or update on gradebook.assignment
  for each row execute function gradebook.check_assignment_category_section();

-- -----------------------------------------------------------------------------
-- gradebook.score
-- -----------------------------------------------------------------------------
-- The CURRENT state: one row per (assignment, person). A correction never
-- edits this row past an approved gradebook.correction once the grading
-- period is locked (trg_check_score_lock below) - see this file's own header.
create table gradebook.score (
  id                     uuid primary key default uuidv7(),
  tenant_id              uuid not null references tenancy.tenant (id) on delete restrict,
  assignment_id          uuid not null references gradebook.assignment (id) on delete restrict,
  person_id              uuid not null references people.person (id) on delete restrict,
  points                 numeric,
  status                 text not null default 'graded' check (status in ('graded', 'missing', 'exempt', 'late', 'incomplete')),
  -- Points at the VERSION, never the scale - see this file's own header.
  -- Nullable: a 'missing'/'exempt' score with no points has nothing to
  -- resolve a letter for yet.
  grade_scale_version_id uuid references gradebook.grade_scale_version (id) on delete restrict,
  comment                text,
  graded_by_user_id      uuid references identity.user (id) on delete restrict,
  graded_at              timestamptz not null default now(),
  unique (assignment_id, person_id)
);

comment on table gradebook.score is
  'The current state of one person''s score on one assignment. grade_scale_version_id is resolved ONCE at grading time and never re-resolved when the scale changes - see this file''s own header. Immutable past an approved gradebook.correction once its grading period is locked (trg_check_score_lock).';

create index score_tenant_assignment_idx on gradebook.score (tenant_id, assignment_id);
create index score_tenant_person_idx on gradebook.score (tenant_id, person_id);

-- -----------------------------------------------------------------------------
-- gradebook.submission
-- -----------------------------------------------------------------------------
-- Idempotency ledger for enterScores - same idiom as attendance.submission:
-- teachers submit grades from flaky wifi and the same batch WILL be
-- resubmitted. Unique (tenant_id, idempotency_key) is what
-- ScoreService.enterScores' ON CONFLICT DO NOTHING targets to detect - and
-- no-op - a replay.
create table gradebook.submission (
  id                   uuid primary key default uuidv7(),
  tenant_id            uuid not null references tenancy.tenant (id) on delete restrict,
  idempotency_key      text not null,
  assignment_id        uuid not null references gradebook.assignment (id) on delete restrict,
  submitted_by_user_id uuid references identity.user (id) on delete restrict,
  score_count          integer not null default 0,
  created_at           timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create index submission_tenant_assignment_idx on gradebook.submission (tenant_id, assignment_id);

-- -----------------------------------------------------------------------------
-- gradebook.grading_period_lock
-- -----------------------------------------------------------------------------
-- One row per grading period ever locked/unlocked. locked=true is what
-- trg_check_score_lock enforces against; the row is upserted by
-- GradingPeriodLockService.lockGradingPeriod/unlockGradingPeriod (a period
-- with no row here has never been locked and is writable).
create table gradebook.grading_period_lock (
  id                    uuid primary key default uuidv7(),
  tenant_id             uuid not null references tenancy.tenant (id) on delete restrict,
  grading_period_id     uuid not null references academic.grading_period (id) on delete restrict,
  locked                boolean not null default false,
  locked_by_user_id     uuid references identity.user (id) on delete restrict,
  locked_at             timestamptz,
  unlocked_by_user_id   uuid references identity.user (id) on delete restrict,
  unlocked_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (tenant_id, grading_period_id)
);

comment on table gradebook.grading_period_lock is
  'Whether one grading period is currently locked. Enforced against gradebook.score by trg_check_score_lock below - a database invariant, not just an application check (contrast attendance''s service-enforced free-edit window, which cannot be a CHECK; a lock flag can).';

-- -----------------------------------------------------------------------------
-- gradebook.correction
-- -----------------------------------------------------------------------------
-- Append-only, same shape and same DB-enforced invariant as
-- attendance.correction / enrollment.status_event: the ONLY way to change a
-- score once its grading period is locked. "Decision fields"
-- (status/decided_by_user_id/decided_at/reason - see
-- trg_forbid_correction_update below) are the one thing an UPDATE may touch.
create table gradebook.correction (
  id                    uuid primary key default uuidv7(),
  tenant_id             uuid not null references tenancy.tenant (id) on delete restrict,
  score_id              uuid not null references gradebook.score (id) on delete restrict,
  from_points           numeric,
  to_points             numeric,
  from_status           text not null check (from_status in ('graded', 'missing', 'exempt', 'late', 'incomplete')),
  to_status             text not null check (to_status in ('graded', 'missing', 'exempt', 'late', 'incomplete')),
  reason                text,
  requested_by_user_id  uuid references identity.user (id) on delete restrict,
  status                text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by_user_id    uuid references identity.user (id) on delete restrict,
  decided_at            timestamptz,
  created_at            timestamptz not null default now(),
  constraint gb_correction_decision_consistency check (
    (status = 'pending' and decided_at is null and decided_by_user_id is null)
    or
    (status <> 'pending' and decided_at is not null)
  )
);

comment on table gradebook.correction is
  'Append-only request to change a locked gradebook.score from one points/status to another. Never updated or deleted except the decision fields (trg_forbid_correction_update/_delete below).';

create index gb_correction_tenant_score_idx on gradebook.correction (tenant_id, score_id);
create index gb_correction_tenant_status_idx on gradebook.correction (tenant_id, status);

-- -----------------------------------------------------------------------------
-- gradebook.learning_outcome / gradebook.outcome_result (standards-based)
-- -----------------------------------------------------------------------------
create table gradebook.learning_outcome (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenancy.tenant (id) on delete restrict,
  subject_id  uuid references academic.subject (id) on delete restrict,
  code        text not null,
  description text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, code)
);

comment on table gradebook.learning_outcome is
  'A standards-based learning outcome (e.g. "CCSS.MATH.4.OA.1"), tenant-owned catalogue. subject_id is an optional scoping hint, not a hard requirement - schools cross-reference outcomes across subjects.';

create index learning_outcome_tenant_idx on gradebook.learning_outcome (tenant_id);
create index learning_outcome_tenant_subject_idx on gradebook.learning_outcome (tenant_id, subject_id) where subject_id is not null;

create table gradebook.outcome_result (
  id                 uuid primary key default uuidv7(),
  tenant_id          uuid not null references tenancy.tenant (id) on delete restrict,
  section_id         uuid not null references academic.section (id) on delete restrict,
  person_id          uuid not null references people.person (id) on delete restrict,
  outcome_id         uuid not null references gradebook.learning_outcome (id) on delete restrict,
  -- Optional: a proficiency result may be tied to one specific assignment, or
  -- be a general observation not tied to any single piece of work.
  assignment_id      uuid references gradebook.assignment (id) on delete restrict,
  proficiency_level  text not null check (proficiency_level in ('beginning', 'developing', 'proficient', 'advanced')),
  comment            text,
  scored_by_user_id  uuid references identity.user (id) on delete restrict,
  scored_at          timestamptz not null default now(),
  created_at         timestamptz not null default now()
);

comment on table gradebook.outcome_result is
  'The CURRENT proficiency level for one (person, outcome), optionally tied to one assignment - upserted like gradebook.score. Same nullable-column uniqueness idiom as attendance.record (see attendance''s 0900 migration header): coalesce(assignment_id, <nil uuid>) so "no particular assignment" still uniquely upserts.';

create index outcome_result_tenant_section_idx on gradebook.outcome_result (tenant_id, section_id);
create index outcome_result_tenant_person_idx on gradebook.outcome_result (tenant_id, person_id);
create index outcome_result_tenant_outcome_idx on gradebook.outcome_result (tenant_id, outcome_id);

create unique index outcome_result_person_outcome_assignment_key
  on gradebook.outcome_result (tenant_id, person_id, outcome_id, coalesce(assignment_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- -----------------------------------------------------------------------------
-- Immutability: grade_scale_version / calculation_rule_set_version
-- -----------------------------------------------------------------------------
create or replace function gradebook.forbid_version_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is an immutable version and cannot be % - publish a new version instead', tg_table_name, lower(tg_op);
end;
$$;

create trigger trg_forbid_version_update before update on gradebook.grade_scale_version
  for each row execute function gradebook.forbid_version_mutation();
create trigger trg_forbid_version_delete before delete on gradebook.grade_scale_version
  for each row execute function gradebook.forbid_version_mutation();

create trigger trg_forbid_calc_version_update before update on gradebook.calculation_rule_set_version
  for each row execute function gradebook.forbid_version_mutation();
create trigger trg_forbid_calc_version_delete before delete on gradebook.calculation_rule_set_version
  for each row execute function gradebook.forbid_version_mutation();

-- -----------------------------------------------------------------------------
-- gradebook.correction is append-only except for its decision fields
-- -----------------------------------------------------------------------------
create or replace function gradebook.forbid_correction_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'gradebook.correction is append-only history and cannot be deleted';
  end if;

  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.score_id is distinct from old.score_id
     or new.from_points is distinct from old.from_points
     or new.to_points is distinct from old.to_points
     or new.from_status is distinct from old.from_status
     or new.to_status is distinct from old.to_status
     or new.requested_by_user_id is distinct from old.requested_by_user_id
     or new.created_at is distinct from old.created_at
  then
    raise exception 'gradebook.correction: only status/decided_by_user_id/decided_at/reason may be updated - the request itself is append-only history';
  end if;

  return new;
end;
$$;

create trigger trg_forbid_correction_update before update on gradebook.correction
  for each row execute function gradebook.forbid_correction_mutation();
create trigger trg_forbid_correction_delete before delete on gradebook.correction
  for each row execute function gradebook.forbid_correction_mutation();

-- -----------------------------------------------------------------------------
-- tenancy.assert_year_writable enforcement (category / assignment / score)
-- -----------------------------------------------------------------------------
create or replace function gradebook.check_category_year_writable()
returns trigger
language plpgsql
as $$
declare
  v_academic_year_id uuid;
begin
  select t.academic_year_id into v_academic_year_id
  from academic.section s
  join academic.term t on t.id = s.term_id
  where s.id = new.section_id;
  if v_academic_year_id is null then
    raise exception 'gradebook.category: section % not found', new.section_id;
  end if;
  perform tenancy.assert_year_writable(v_academic_year_id);
  return new;
end;
$$;

create trigger trg_assert_year_writable before insert or update on gradebook.category
  for each row execute function gradebook.check_category_year_writable();

create trigger trg_assert_year_writable before insert or update on gradebook.assignment
  for each row execute function gradebook.check_category_year_writable();

create or replace function gradebook.check_score_year_writable()
returns trigger
language plpgsql
as $$
declare
  v_academic_year_id uuid;
begin
  select t.academic_year_id into v_academic_year_id
  from gradebook.assignment a
  join academic.section s on s.id = a.section_id
  join academic.term t on t.id = s.term_id
  where a.id = new.assignment_id;
  if v_academic_year_id is null then
    raise exception 'gradebook.score: assignment % not found', new.assignment_id;
  end if;
  perform tenancy.assert_year_writable(v_academic_year_id);
  return new;
end;
$$;

create trigger trg_assert_year_writable before insert or update on gradebook.score
  for each row execute function gradebook.check_score_year_writable();

-- -----------------------------------------------------------------------------
-- Grading-period lock enforcement (gradebook.score)
-- -----------------------------------------------------------------------------
-- See this file's own header for the app.gradebook_correction_override
-- escape hatch - set (SET LOCAL, transaction-scoped) ONLY by
-- CorrectionService.decideCorrection immediately before applying an
-- APPROVED correction, in the same transaction as the decision.
create or replace function gradebook.check_score_lock()
returns trigger
language plpgsql
as $$
declare
  v_grading_period_id uuid;
  v_locked boolean;
begin
  if coalesce(nullif(current_setting('app.gradebook_correction_override', true), ''), 'false') = 'true' then
    return new;
  end if;

  select grading_period_id into v_grading_period_id from gradebook.assignment where id = new.assignment_id;
  if v_grading_period_id is null then
    raise exception 'gradebook.score: assignment % not found', new.assignment_id;
  end if;

  select locked into v_locked from gradebook.grading_period_lock where grading_period_id = v_grading_period_id;

  if coalesce(v_locked, false) then
    raise exception 'gradebook.score: grading period % is locked - scores can only change through an approved gradebook.correction', v_grading_period_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger trg_check_score_lock before insert or update on gradebook.score
  for each row execute function gradebook.check_score_lock();

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function gradebook.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_set_updated_at before update on gradebook.grade_scale
  for each row execute function gradebook.set_updated_at();
create trigger trg_set_updated_at before update on gradebook.calculation_rule_set
  for each row execute function gradebook.set_updated_at();
create trigger trg_set_updated_at before update on gradebook.category
  for each row execute function gradebook.set_updated_at();
create trigger trg_set_updated_at before update on gradebook.assignment
  for each row execute function gradebook.set_updated_at();
create trigger trg_set_updated_at before update on gradebook.grading_period_lock
  for each row execute function gradebook.set_updated_at();
create trigger trg_set_updated_at before update on gradebook.learning_outcome
  for each row execute function gradebook.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
alter table gradebook.grade_scale enable row level security;
create policy grade_scale_tenant_isolation on gradebook.grade_scale
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table gradebook.grade_scale_version enable row level security;
create policy grade_scale_version_tenant_isolation on gradebook.grade_scale_version
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table gradebook.calculation_rule_set enable row level security;
create policy calculation_rule_set_tenant_isolation on gradebook.calculation_rule_set
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table gradebook.calculation_rule_set_version enable row level security;
create policy calc_rule_set_version_tenant_isolation on gradebook.calculation_rule_set_version
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table gradebook.category enable row level security;
create policy category_tenant_isolation on gradebook.category
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table gradebook.assignment enable row level security;
create policy assignment_tenant_isolation on gradebook.assignment
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table gradebook.score enable row level security;
create policy score_tenant_isolation on gradebook.score
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table gradebook.submission enable row level security;
create policy submission_tenant_isolation on gradebook.submission
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table gradebook.grading_period_lock enable row level security;
create policy grading_period_lock_tenant_isolation on gradebook.grading_period_lock
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table gradebook.correction enable row level security;
create policy gb_correction_tenant_isolation on gradebook.correction
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table gradebook.learning_outcome enable row level security;
create policy learning_outcome_tenant_isolation on gradebook.learning_outcome
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table gradebook.outcome_result enable row level security;
create policy outcome_result_tenant_isolation on gradebook.outcome_result
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Audit history
-- -----------------------------------------------------------------------------
select audit.attach_history('gradebook.grade_scale');
select audit.attach_history('gradebook.grade_scale_version');
select audit.attach_history('gradebook.calculation_rule_set');
select audit.attach_history('gradebook.calculation_rule_set_version');
select audit.attach_history('gradebook.category');
select audit.attach_history('gradebook.assignment');
select audit.attach_history('gradebook.score');
select audit.attach_history('gradebook.submission');
select audit.attach_history('gradebook.grading_period_lock');
select audit.attach_history('gradebook.correction');
select audit.attach_history('gradebook.learning_outcome');
select audit.attach_history('gradebook.outcome_result');

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Migrations run as sms_owner, which owns these tables; sms_app gets no
-- default privileges on objects sms_owner creates, so every table needs
-- explicit grants. sms_app is NOBYPASSRLS and owns nothing here (arch-check.ts
-- checks 3 and 4).
--
-- grade_scale_version / calculation_rule_set_version: UPDATE is granted
-- (belt and suspenders posture, same as attendance.correction) but
-- trg_forbid_version_update/_delete above reject every attempt outright -
-- these are immutable facts, not merely append-preferred ones.
-- correction: UPDATE is granted (the decision has to land somewhere), but
-- trg_forbid_correction_update restricts it to the decision fields; DELETE
-- is granted to nobody.
-- submission: INSERT/SELECT only - a pure idempotency ledger, write-once.
grant usage on schema gradebook to sms_app;
grant select, insert, update           on gradebook.grade_scale                  to sms_app;
grant select, insert, update           on gradebook.grade_scale_version          to sms_app;
grant select, insert, update           on gradebook.calculation_rule_set         to sms_app;
grant select, insert, update           on gradebook.calculation_rule_set_version to sms_app;
grant select, insert, update, delete   on gradebook.category                     to sms_app;
grant select, insert, update, delete   on gradebook.assignment                   to sms_app;
grant select, insert, update           on gradebook.score                        to sms_app;
grant select, insert                   on gradebook.submission                   to sms_app;
grant select, insert, update           on gradebook.grading_period_lock          to sms_app;
grant select, insert, update           on gradebook.correction                   to sms_app;
grant select, insert, update           on gradebook.learning_outcome             to sms_app;
grant select, insert, update, delete   on gradebook.outcome_result               to sms_app;
