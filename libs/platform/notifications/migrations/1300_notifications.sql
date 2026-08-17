-- =============================================================================
-- notifications - turning a domain fact into a message a person actually gets
-- =============================================================================
-- This is the module the transactional outbox (@sms/outbox) was built for:
-- `attendance.marked_absent` becoming a real email in a guardian's inbox. Two
-- design decisions carry the whole schema:
--
--   * Consent and preference are enforced at SEND time, not at compose time.
--     A guardian who has opted out of a channel, or whose
--     `people.relationship.may_receive_comms` is false, must not receive a
--     message - no matter what rule or template asked for it. Checking only
--     when composing means every future caller has to remember to re-check;
--     checking at the point of delivery means it cannot be forgotten. This is
--     why `notifications.preference` exists as its own table (checked by
--     `NotificationsService.notify` immediately before a channel is called)
--     rather than as a filter some caller applies before enqueuing.
--
--   * "Sent" is not "delivered". `notifications.delivery` records a status per
--     RECIPIENT per CHANNEL (queued/sent/delivered/failed/suppressed), with a
--     reason when suppressed. A school that cannot answer "did that parent
--     actually get told?" has not really sent anything - collapsing this to a
--     boolean on the notification itself would throw that answer away.
--
-- notifications.template / notifications.template_version follow the exact
-- shape and reasoning as documents.template / documents.template_version
-- (see @sms/documents' 1100 migration header): a template is a stable
-- (tenant, key, channel) identity; each published version is immutable
-- (enforced by trigger below, not just convention) so a notification always
-- points at the exact copy that produced it, and a school can edit copy by
-- publishing a new version, never by mutating history.
--
-- notifications.notification is one logical message about one subject
-- (subject_type/subject_id - deliberately untyped text/uuid, no FK, for the
-- same reason documents.document's are: this module is type:platform and may
-- not depend on the domain modules that own people.person / attendance.record
-- / etc). dedupe_key is UNIQUE per tenant - this is what makes at-least-once
-- outbox delivery safe: a redelivered outbox message calls notify() again
-- with the same dedupe_key, the INSERT no-ops on conflict, and no second
-- delivery is ever attempted for something already handled.
-- =============================================================================

create schema notifications;

-- -----------------------------------------------------------------------------
-- notifications.template
-- -----------------------------------------------------------------------------
create table notifications.template (
  id          uuid        primary key default uuidv7(),
  tenant_id   uuid        not null references tenancy.tenant (id) on delete restrict,
  key         text        not null,
  channel     text        not null,
  name        text        not null,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, key, channel)
);

comment on table notifications.template is
  'One row per (tenant, key, channel) a template has been published for - e.g. (''attendance.absence'', ''email''). The code that calls notify() only knows the key; this is the tenant''s published-content anchor for whichever channels have copy, same role documents.template plays for @sms/documents.';

-- -----------------------------------------------------------------------------
-- notifications.template_version
-- -----------------------------------------------------------------------------
-- Immutable once inserted, exactly like documents.template_version - see the
-- file header and the trigger below.
create table notifications.template_version (
  id                 uuid        primary key default uuidv7(),
  tenant_id          uuid        not null references tenancy.tenant (id) on delete restrict,
  template_id        uuid        not null references notifications.template (id) on delete restrict,
  version            integer     not null,
  locale             text        not null default 'en',
  subject_template   text        not null default '',
  body_template       text        not null,
  published_at       timestamptz not null default now(),
  created_by_user_id uuid        references identity.user (id) on delete restrict,
  unique (template_id, version)
);

comment on table notifications.template_version is
  'Immutable, append-only. A notification.template_version_id snapshot always points at exactly the copy that produced it - a template edit can never silently rewrite a message already sent. UPDATE/DELETE are refused at the table level - see trg_forbid_notification_template_version_mutation below.';

create index template_version_template_idx on notifications.template_version (template_id, version desc);

-- -----------------------------------------------------------------------------
-- notifications.preference
-- -----------------------------------------------------------------------------
-- Per person, per channel, per category. Absence of a row means "no explicit
-- preference recorded" - NotificationsService treats that as opted in (the
-- relationship-level may_receive_comms flag, checked by the caller-supplied
-- recipient resolver, is the primary consent gate; this table is the finer-
-- grained dial a guardian can turn down category-by-category or channel-by-
-- channel without opting out of everything).
create table notifications.preference (
  id         uuid        primary key default uuidv7(),
  tenant_id  uuid        not null references tenancy.tenant (id) on delete restrict,
  person_id  uuid        not null,
  channel    text        not null,
  category   text        not null,
  opted_in   boolean     not null,
  updated_at timestamptz not null default now(),
  unique (tenant_id, person_id, channel, category)
);

comment on table notifications.preference is
  'One row per (person, channel, category): whether this person wants to be told about this category of thing on this channel. person_id is deliberately untyped uuid (no FK to people.person - this module is type:platform, see the file header).';

create index preference_tenant_person_idx on notifications.preference (tenant_id, person_id);

-- -----------------------------------------------------------------------------
-- notifications.notification
-- -----------------------------------------------------------------------------
-- One logical message. Insert-only: nothing about a notification is ever
-- edited once written - the "did the school later change its mind" question
-- is answered by whether new deliveries are queued, never by mutating this
-- row. dedupe_key uniqueness per tenant is the whole idempotency mechanism -
-- see the file header.
create table notifications.notification (
  id                  uuid        primary key default uuidv7(),
  tenant_id           uuid        not null references tenancy.tenant (id) on delete restrict,
  template_version_id uuid        not null references notifications.template_version (id) on delete restrict,
  category            text        not null,

  -- Deliberately untyped: this module may not depend on the domain modules
  -- that own people.person / attendance.record / etc. See the file header.
  subject_type        text        not null,
  subject_id          uuid        not null,

  payload             jsonb       not null default '{}',
  dedupe_key          text        not null,
  created_at          timestamptz not null default now(),
  unique (tenant_id, dedupe_key)
);

comment on table notifications.notification is
  'One logical message about one subject (subject_type/subject_id). dedupe_key is UNIQUE per tenant - a redelivered outbox message that calls notify() again with the same dedupe_key no-ops here instead of sending a second time. See the file header.';

create index notification_tenant_subject_idx on notifications.notification (tenant_id, subject_type, subject_id, created_at desc);

-- -----------------------------------------------------------------------------
-- notifications.delivery
-- -----------------------------------------------------------------------------
-- One row per recipient per channel. status is the honest record of what
-- actually happened - see the file header on "sent is not delivered":
-- 'sent' means the channel adapter accepted it, never that the recipient
-- received or read it; nothing in this module ever sets 'delivered' itself
-- (that would require a provider webhook, future work) - it exists in the
-- vocabulary so one can be wired in later without a schema change.
create table notifications.delivery (
  id                   uuid        primary key default uuidv7(),
  tenant_id            uuid        not null references tenancy.tenant (id) on delete restrict,
  notification_id      uuid        not null references notifications.notification (id) on delete restrict,
  person_id            uuid        not null,
  channel              text        not null,
  address              text,
  status               text        not null default 'queued'
                         check (status in ('queued', 'sent', 'delivered', 'failed', 'suppressed')),
  suppressed_reason    text,
  provider_message_id  text,
  attempts             integer     not null default 0,
  sent_at              timestamptz,
  delivered_at         timestamptz,
  failed_at            timestamptz,
  last_error           text,
  created_at           timestamptz not null default now(),
  constraint delivery_suppressed_has_reason
    check (status <> 'suppressed' or suppressed_reason is not null)
);

comment on table notifications.delivery is
  'One row per (notification, recipient, channel): the honest record of what was attempted and what happened - queued/sent/delivered/failed/suppressed, with a reason when suppressed (consent/preference). This is what answers "did that parent actually get told?" - see the file header.';

create index delivery_tenant_notification_idx on notifications.delivery (tenant_id, notification_id);
create index delivery_tenant_person_idx on notifications.delivery (tenant_id, person_id);

-- -----------------------------------------------------------------------------
-- notifications.template_version is immutable - UPDATE/DELETE refused outright
-- -----------------------------------------------------------------------------
create or replace function notifications.forbid_template_version_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'notifications.template_version is immutable and cannot be deleted - publish a new version instead';
  end if;

  raise exception 'notifications.template_version is immutable and cannot be updated - publish a new version instead';
end;
$$;

create trigger trg_forbid_notification_template_version_update
  before update on notifications.template_version
  for each row execute function notifications.forbid_template_version_mutation();

create trigger trg_forbid_notification_template_version_delete
  before delete on notifications.template_version
  for each row execute function notifications.forbid_template_version_mutation();

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function notifications.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_set_updated_at before update on notifications.template
  for each row execute function notifications.set_updated_at();
create trigger trg_set_updated_at before update on notifications.preference
  for each row execute function notifications.set_updated_at();

-- -----------------------------------------------------------------------------
-- Audit history
-- -----------------------------------------------------------------------------
select audit.attach_history('notifications.template');
select audit.attach_history('notifications.template_version');
select audit.attach_history('notifications.preference');
select audit.attach_history('notifications.notification');
select audit.attach_history('notifications.delivery');

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
alter table notifications.template enable row level security;
create policy template_tenant_isolation on notifications.template
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table notifications.template_version enable row level security;
create policy template_version_tenant_isolation on notifications.template_version
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table notifications.preference enable row level security;
create policy preference_tenant_isolation on notifications.preference
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table notifications.notification enable row level security;
create policy notification_tenant_isolation on notifications.notification
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table notifications.delivery enable row level security;
create policy delivery_tenant_isolation on notifications.delivery
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
grant usage on schema notifications to sms_app;

grant select, insert on notifications.template to sms_app;

-- No UPDATE/DELETE: the triggers above already refuse both, but withholding
-- the grant too means the refusal does not depend on the trigger alone - same
-- posture as documents.template_version.
grant select, insert on notifications.template_version to sms_app;

-- UPDATE: a guardian (or an admin managing preferences on their behalf) can
-- change opted_in on an existing (person, channel, category) row.
grant select, insert, update on notifications.preference to sms_app;

-- No UPDATE/DELETE: a notification is written once and never edited - see
-- the table comment above.
grant select, insert on notifications.notification to sms_app;

-- UPDATE: a delivery's status/attempts/sent_at/etc progress after the row is
-- first queued - see NotificationsService.notify.
grant select, insert, update on notifications.delivery to sms_app;
