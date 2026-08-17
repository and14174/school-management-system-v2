-- =============================================================================
-- platform.outbox - the transactional outbox
-- =============================================================================
-- Everything that fans out from a domain fact goes through here: parent
-- notifications, read-model projections, webhooks, and the Phase 2 automation
-- engine. They are all consumers of one stream rather than four bespoke
-- mechanisms.
--
-- The property the whole design rests on:
--
--   The event row is written in the SAME TRANSACTION as the fact it describes.
--
-- That is what makes the two impossible failures impossible:
--   * You never notify a parent about an absence that got rolled back.
--   * You never lose a notification because Redis was down when the row was
--     committed - the event is already durable in Postgres, and the dispatcher
--     picks it up whenever it next runs.
--
-- Publishing over a message bus at the end of a request buys neither. Enqueuing
-- inside the transaction and publishing after commit buys the first but not the
-- second. Only writing the event to the same database, in the same transaction,
-- buys both.
--
-- Consequence for callers: `publish()` MUST be handed the caller's transaction.
-- Opening its own would silently reintroduce exactly the gap this exists to
-- close. See `OutboxService.publish`.

create schema if not exists outbox;

create table outbox.message (
  id             uuid        primary key default uuidv7(),
  tenant_id      uuid        not null,

  -- Dotted, past tense, and stable: consumers subscribe to these strings, so a
  -- rename is a breaking change. e.g. 'attendance.marked_absent'.
  topic          text        not null,
  payload        jsonb       not null,

  -- Correlation back to the request and actor that caused it, so a notification
  -- can be traced to the action that produced it.
  request_id     text,
  actor_user_id  uuid,

  occurred_at    timestamptz not null default now(),

  -- Dispatch state. published_at null = still owed to somebody.
  published_at   timestamptz,
  attempts       int         not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error     text
);

comment on table outbox.message is
  'Transactional outbox. Rows are written in the same transaction as the fact they describe, then drained by the dispatcher. @no-audit';

-- The dispatcher's only query: unpublished, due, oldest first. Partial so the
-- index stays small - published rows are the overwhelming majority over time
-- and are irrelevant to it.
create index message_pending_idx
  on outbox.message (next_attempt_at, occurred_at)
  where published_at is null;

create index message_tenant_topic_idx on outbox.message (tenant_id, topic, occurred_at desc);

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
-- Outbox rows carry tenant data in their payload, so they are tenant-scoped like
-- anything else. The dispatcher is a system job and runs as the owner, which
-- bypasses RLS by design - it must see every tenant's backlog.
alter table outbox.message enable row level security;

create policy message_tenant_isolation on outbox.message
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- The application publishes and reads its own tenant's events. It does NOT get
-- UPDATE: marking a message published is the dispatcher's job, and the
-- dispatcher runs as the owner. An application that can mark its own events
-- published can silently drop them.
grant usage on schema outbox to sms_app;
grant select, insert on outbox.message to sms_app;
