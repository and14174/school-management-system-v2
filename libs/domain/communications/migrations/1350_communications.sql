-- =============================================================================
-- communications: announcements and threaded messaging
-- =============================================================================
-- Two decisions worth calling out up front, both drawn straight from the
-- module brief:
--
--   * Every message is linked to what it is about. communications.thread
--     always hangs off a subject (subject_type/subject_id) - a student, a
--     section, an invoice, or 'other' for the rare case that genuinely has
--     no anchor. subject_id is deliberately untyped (uuid, no FK) - this
--     schema must be able to point at academic.section or a future
--     billing.invoice without depending on every module that might own a
--     subject type, same reasoning as documents.document's own
--     subject_type/subject_id (see @sms/documents' 1100 migration header).
--
--   * An announcement's audience is a RESOLVED, FROZEN recipient list, not a
--     live query. communications.announcement.audience (jsonb) records the
--     query that was used, for display only - communications.
--     announcement_recipient is the actual answer, written once at publish
--     time. "All Grade 9 parents" means the people who were in Grade 9 WHEN
--     IT WAS SENT; re-resolving later would silently rewrite who was told,
--     the same class of bug decisions.md documents for a grade re-resolving
--     against a new scale. Consequently communications.announcement is
--     immutable in substance once published: a trigger below refuses
--     changes to title/body past draft - supersedeAnnouncement issues a new
--     row and links the old one via superseded_by_announcement_id, same
--     shape as documents.template_version's append-only-with-trigger
--     enforcement.
--
-- communications.message is append-only for the same reason attendance.
-- correction and documents.template_version are: "what did we tell this
-- thread on the 14th" must stay answerable regardless of anything typed
-- since. UPDATE/DELETE are refused by trigger below, and sms_app is granted
-- neither.
--
-- communications.message also carries idempotency_key directly (unique per
-- THREAD, not per tenant - a client's key only needs to be unique within
-- the conversation it is posting to; scoping it tenant-wide would let a key
-- reused across two different threads silently "replay" into the wrong
-- thread's message) rather than a separate ledger table like attendance.
-- submission - attendance's markSession writes MANY records per submission
-- and needed a separate row to anchor the idempotency check to;
-- postMessage writes exactly ONE message per call, so the key belongs on
-- the row it protects.
-- =============================================================================

create schema communications;

-- -----------------------------------------------------------------------------
-- communications.announcement
-- -----------------------------------------------------------------------------
create table communications.announcement (
  id                             uuid primary key default uuidv7(),
  tenant_id                      uuid not null references tenancy.tenant (id) on delete restrict,
  title                          text not null,
  body                           text not null,
  -- Tenant-chosen free text ("General", "Safety", "Event"), not an enum -
  -- same reasoning as attendance.code.label (0900 migration header): a
  -- closed system vocabulary is not what schools want here either.
  category                       text not null,
  -- The QUERY that was used to resolve the audience, kept for display
  -- ("sent to: all Grade 9 parents") - never re-read to determine who
  -- actually got it. That answer lives in announcement_recipient.
  audience                       jsonb not null default '{}'::jsonb,
  -- null = every campus (tenant-wide).
  campus_id                      uuid references tenancy.campus (id) on delete restrict,
  status                         text not null default 'draft' check (status in ('draft', 'published', 'superseded')),
  published_at                   timestamptz,
  published_by_user_id           uuid references identity.user (id) on delete restrict,
  superseded_by_announcement_id  uuid references communications.announcement (id) on delete restrict,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),
  constraint announcement_published_consistency check (
    (status = 'draft' and published_at is null)
    or
    (status <> 'draft' and published_at is not null)
  )
);

comment on table communications.announcement is
  'A school announcement. Once status <> ''draft'', title/body are immutable (trg_forbid_announcement_content_change below) - correcting one calls supersedeAnnouncement, which inserts a NEW announcement and stamps superseded_by_announcement_id on this row, never edits this row''s content in place.';

create index announcement_tenant_status_idx on communications.announcement (tenant_id, status);
create index announcement_tenant_campus_idx on communications.announcement (tenant_id, campus_id);

-- -----------------------------------------------------------------------------
-- communications.announcement_recipient
-- -----------------------------------------------------------------------------
-- The FROZEN audience - see the file header. Written once, in the same
-- transaction as the publish that sets announcement.status = 'published',
-- and never re-derived afterwards.
create table communications.announcement_recipient (
  id               uuid primary key default uuidv7(),
  tenant_id        uuid not null references tenancy.tenant (id) on delete restrict,
  announcement_id  uuid not null references communications.announcement (id) on delete restrict,
  person_id        uuid not null references people.person (id) on delete restrict,
  read_at          timestamptz,
  created_at       timestamptz not null default now(),
  unique (announcement_id, person_id)
);

comment on table communications.announcement_recipient is
  'The resolved audience AT PUBLISH TIME - "who was actually told", answerable regardless of who would match the audience query today. read_at is per-recipient, so "who has actually seen this" is answerable too.';

create index announcement_recipient_tenant_person_idx on communications.announcement_recipient (tenant_id, person_id);
create index announcement_recipient_tenant_announcement_idx on communications.announcement_recipient (tenant_id, announcement_id);

-- -----------------------------------------------------------------------------
-- communications.thread
-- -----------------------------------------------------------------------------
-- Always anchored to something - see the file header. subject_id is
-- deliberately untyped (no FK): this module may depend on @sms/people and
-- @sms/academic (subject_type values for both), but subject_type 'other'
-- and any future 'billing.invoice' point at tables this schema must not
-- hard-reference.
create table communications.thread (
  id                  uuid primary key default uuidv7(),
  tenant_id           uuid not null references tenancy.tenant (id) on delete restrict,
  subject              text not null,
  subject_type        text not null check (subject_type in ('people.person', 'academic.section', 'billing.invoice', 'other')),
  subject_id          uuid not null,
  status              text not null default 'open' check (status in ('open', 'closed')),
  created_by_user_id  uuid references identity.user (id) on delete restrict,
  last_message_at     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table communications.thread is
  'A message thread, always about something (subject_type/subject_id) - never a floating free-text conversation. "What was that message about my son''s absence" is answered by following this link, not by searching text.';

create index thread_tenant_subject_idx on communications.thread (tenant_id, subject_type, subject_id);
create index thread_tenant_last_message_idx on communications.thread (tenant_id, last_message_at desc);

-- -----------------------------------------------------------------------------
-- communications.thread_participant
-- -----------------------------------------------------------------------------
create table communications.thread_participant (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references tenancy.tenant (id) on delete restrict,
  thread_id      uuid not null references communications.thread (id) on delete restrict,
  person_id      uuid not null references people.person (id) on delete restrict,
  role           text not null default 'participant' check (role in ('owner', 'participant', 'observer')),
  last_read_at   timestamptz,
  muted          boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (thread_id, person_id)
);

comment on table communications.thread_participant is
  'Who is in a thread, and the per-participant read state (last_read_at) that answers "who has actually seen this". The ONLY membership test a thread read is authorised against - see @sms/communications'' ThreadService, which joins this table into every list/single-read query rather than filtering results after fetching them.';

create index thread_participant_tenant_person_idx on communications.thread_participant (tenant_id, person_id);
create index thread_participant_tenant_thread_idx on communications.thread_participant (tenant_id, thread_id);

-- -----------------------------------------------------------------------------
-- communications.message
-- -----------------------------------------------------------------------------
-- Append-only - see the file header. idempotency_key makes postMessage safe
-- to retry over flaky connections, same reasoning as attendance.submission's
-- idempotency_key (0900 migration header), collapsed onto this table's own
-- row rather than a separate ledger since one call writes exactly one row.
create table communications.message (
  id                 uuid primary key default uuidv7(),
  tenant_id          uuid not null references tenancy.tenant (id) on delete restrict,
  thread_id          uuid not null references communications.thread (id) on delete restrict,
  author_person_id   uuid not null references people.person (id) on delete restrict,
  body               text not null,
  idempotency_key    text not null,
  sent_at            timestamptz not null default now(),
  unique (tenant_id, thread_id, idempotency_key)
);

comment on table communications.message is
  'One message in a thread. Append-only history - editing a sent message is not a thing (trg_forbid_message_update/_delete below refuse both UPDATE and DELETE outright); post a correction as a new message instead.';

create index message_tenant_thread_sent_idx on communications.message (tenant_id, thread_id, sent_at);

-- -----------------------------------------------------------------------------
-- communications.announcement: title/body are immutable once published
-- -----------------------------------------------------------------------------
create or replace function communications.forbid_announcement_content_change()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'draft' and (new.title is distinct from old.title or new.body is distinct from old.body) then
    raise exception 'communications.announcement: title/body are immutable once published - call supersedeAnnouncement to issue a correction';
  end if;
  return new;
end;
$$;

create trigger trg_forbid_announcement_content_change before update on communications.announcement
  for each row execute function communications.forbid_announcement_content_change();

-- -----------------------------------------------------------------------------
-- communications.message is append-only - UPDATE/DELETE refused outright
-- -----------------------------------------------------------------------------
create or replace function communications.forbid_message_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'communications.message is append-only and cannot be deleted';
  end if;
  raise exception 'communications.message is append-only and cannot be updated - post a correction as a new message instead';
end;
$$;

create trigger trg_forbid_message_update before update on communications.message
  for each row execute function communications.forbid_message_mutation();
create trigger trg_forbid_message_delete before delete on communications.message
  for each row execute function communications.forbid_message_mutation();

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function communications.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_set_updated_at before update on communications.announcement
  for each row execute function communications.set_updated_at();
create trigger trg_set_updated_at before update on communications.thread
  for each row execute function communications.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
alter table communications.announcement enable row level security;
create policy announcement_tenant_isolation on communications.announcement
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table communications.announcement_recipient enable row level security;
create policy announcement_recipient_tenant_isolation on communications.announcement_recipient
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table communications.thread enable row level security;
create policy thread_tenant_isolation on communications.thread
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table communications.thread_participant enable row level security;
create policy thread_participant_tenant_isolation on communications.thread_participant
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table communications.message enable row level security;
create policy message_tenant_isolation on communications.message
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Audit history
-- -----------------------------------------------------------------------------
select audit.attach_history('communications.announcement');
select audit.attach_history('communications.announcement_recipient');
select audit.attach_history('communications.thread');
select audit.attach_history('communications.thread_participant');
select audit.attach_history('communications.message');

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Migrations run as sms_owner, which owns these tables; sms_app gets no
-- default privileges on objects sms_owner creates, so every table needs
-- explicit grants. sms_app is NOBYPASSRLS and owns nothing here (arch-check.ts
-- checks 3 and 4).
--
-- announcement: UPDATE needed for publish (status/published_at/
-- published_by_user_id) and supersede (status/superseded_by_announcement_id)
-- - trg_forbid_announcement_content_change above still refuses title/body
-- changes past draft. No DELETE - a published announcement is never removed,
-- only superseded.
-- announcement_recipient: UPDATE needed for markAnnouncementRead's read_at.
-- No DELETE - the frozen audience is never edited, only marked read.
-- thread: UPDATE needed for status (open/closed) and last_message_at
-- maintenance. No DELETE - a thread is closed, not removed.
-- thread_participant: UPDATE needed for last_read_at/muted. No DELETE - a
-- participant leaving would erase "were they ever in this conversation",
-- which the same "correction, not erasure" principle as everywhere else in
-- this schema protects.
-- message: INSERT/SELECT only - the append-only history trg_forbid_message_
-- mutation enforces, and withholding UPDATE/DELETE grants entirely means the
-- refusal does not depend on the trigger alone (belt and suspenders, same
-- posture as attendance.correction's grants).
grant usage on schema communications to sms_app;
grant select, insert, update on communications.announcement            to sms_app;
grant select, insert, update on communications.announcement_recipient  to sms_app;
grant select, insert, update on communications.thread                  to sms_app;
grant select, insert, update on communications.thread_participant      to sms_app;
grant select, insert         on communications.message                 to sms_app;
