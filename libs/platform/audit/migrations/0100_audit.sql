-- =============================================================================
-- audit: row history, read-access logging, and reversible bulk operations
-- =============================================================================
-- Retrofitting this is the expensive mistake. Once twenty modules exist, adding
-- history means backfilling changes that were never recorded - which is not
-- possible. So it lands before the first domain table.
--
-- Design notes that matter:
--   * The trigger is GENERIC. Attaching it to a new table is one line, with no
--     per-table configuration, because anything requiring per-table work will
--     eventually be forgotten on some table.
--   * The trigger function is SECURITY DEFINER and sms_app gets no write grants
--     on the history tables. The application therefore cannot forge, amend or
--     delete history - it can only cause it to be written by changing data.
--   * record_history is partitioned by month from the start. It becomes the
--     largest table in the system by an order of magnitude, and converting a
--     large unpartitioned table later means downtime.
-- =============================================================================

create schema if not exists audit;

-- -----------------------------------------------------------------------------
-- Row history
-- -----------------------------------------------------------------------------
create table audit.record_history (
  id                uuid        not null default uuidv7(),
  table_schema      text        not null,
  table_name        text        not null,
  record_id         text        not null,
  operation         text        not null check (operation in ('insert', 'update', 'delete')),
  before            jsonb,
  after             jsonb,
  changed_by        uuid,
  tenant_id         uuid,
  request_id        text,
  bulk_operation_id uuid,
  occurred_at       timestamptz not null default now(),
  -- The partition key has to be part of the primary key.
  primary key (id, occurred_at)
) partition by range (occurred_at);

comment on table audit.record_history is
  'Append-only before/after images for every tracked table. Written only by the audit.record_history() trigger. @no-audit';

create index record_history_record_idx
  on audit.record_history (table_schema, table_name, record_id, occurred_at desc);
create index record_history_tenant_idx
  on audit.record_history (tenant_id, occurred_at desc);
create index record_history_bulk_idx
  on audit.record_history (bulk_operation_id)
  where bulk_operation_id is not null;

-- Creates the partition covering the month containing p_month, if absent.
-- Called by the migration below for the current + next two months, and by a
-- scheduled job thereafter.
create or replace function audit.create_month_partition(p_month date)
returns void
language plpgsql
as $$
declare
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text := format('record_history_%s', to_char(v_start, 'YYYY_MM'));
begin
  if to_regclass(format('audit.%I', v_name)) is not null then
    return;
  end if;

  execute format(
    'create table audit.%I partition of audit.record_history for values from (%L) to (%L)',
    v_name, v_start, v_end
  );

  -- Partitions get no grants of their own: they are reachable only through the
  -- partitioned parent, so the parent's policy governs all access.
  execute format('alter table audit.%I owner to sms_owner', v_name);
end;
$$;

select audit.create_month_partition(current_date);
select audit.create_month_partition((current_date + interval '1 month')::date);
select audit.create_month_partition((current_date + interval '2 months')::date);

-- -----------------------------------------------------------------------------
-- Read-access log
-- -----------------------------------------------------------------------------
-- Triggers cannot observe reads, so this is written by the API when a response
-- includes a restricted field (medical, counselling, safeguarding).
create table audit.access_log (
  id          uuid        primary key default uuidv7(),
  tenant_id   uuid        not null,
  actor_id    uuid,
  person_id   uuid,
  resource    text        not null,
  field_names text[]      not null default '{}',
  reason      text,
  request_id  text,
  occurred_at timestamptz not null default now()
);

comment on table audit.access_log is
  'Who read restricted data about whom. Written by the API, not by a trigger. @no-audit';

create index access_log_tenant_idx on audit.access_log (tenant_id, occurred_at desc);
create index access_log_person_idx on audit.access_log (person_id, occurred_at desc);

-- -----------------------------------------------------------------------------
-- Bulk operations
-- -----------------------------------------------------------------------------
-- Groups the row changes made by an import or bulk edit so they can be reversed
-- as a unit. The trigger stamps bulk_operation_id from a session GUC, so nothing
-- inside a bulk operation has to remember to tag itself.
create table audit.bulk_operation (
  id                       uuid        primary key default uuidv7(),
  tenant_id                uuid        not null,
  kind                     text        not null,
  actor_id                 uuid,
  status                   text        not null default 'running'
                                       check (status in ('running', 'completed', 'failed', 'reverted')),
  summary                  jsonb       not null default '{}'::jsonb,
  started_at               timestamptz not null default now(),
  completed_at             timestamptz,
  reverted_by_operation_id uuid        references audit.bulk_operation (id)
);

comment on table audit.bulk_operation is
  'Groups row changes so an import or bulk edit can be reversed as a unit. @no-audit';

create index bulk_operation_tenant_idx on audit.bulk_operation (tenant_id, started_at desc);

-- -----------------------------------------------------------------------------
-- The generic history trigger
-- -----------------------------------------------------------------------------
-- Attach with audit.attach_history('schema.table', 'secret_col', 'token_col').
-- Any column named in the arguments is stripped from both images, so secrets and
-- sensitive free text never enter history in the first place.
create or replace function audit.record_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before    jsonb;
  v_after     jsonb;
  v_record_id text;
  v_excluded  text[] := coalesce(tg_argv, '{}')::text[];
begin
  if tg_op = 'INSERT' then
    v_after := to_jsonb(new) - v_excluded;
  elsif tg_op = 'UPDATE' then
    v_before := to_jsonb(old) - v_excluded;
    v_after  := to_jsonb(new) - v_excluded;
    -- Nothing observable changed (e.g. only an excluded column moved), so there
    -- is nothing worth a history row.
    if v_before = v_after then
      return null;
    end if;
  else
    v_before := to_jsonb(old) - v_excluded;
  end if;

  -- Every table in this system has a surrogate `id` primary key. Failing loudly
  -- here is deliberate: a table without one would otherwise get history rows
  -- that can never be traced back to a record.
  v_record_id := coalesce(v_after, v_before) ->> 'id';
  if v_record_id is null then
    raise exception
      'audit.record_history: %.% has no "id" column; history cannot be attributed to a record',
      tg_table_schema, tg_table_name;
  end if;

  insert into audit.record_history (
    table_schema, table_name, record_id, operation,
    before, after, changed_by, tenant_id, request_id, bulk_operation_id
  )
  values (
    tg_table_schema,
    tg_table_name,
    v_record_id,
    lower(tg_op),
    v_before,
    v_after,
    nullif(current_setting('app.person_id', true), '')::uuid,
    coalesce(
      nullif(current_setting('app.tenant_id', true), '')::uuid,
      (coalesce(v_after, v_before) ->> 'tenant_id')::uuid
    ),
    nullif(current_setting('app.request_id', true), ''),
    nullif(current_setting('app.bulk_operation_id', true), '')::uuid
  );

  return null; -- AFTER trigger: return value is ignored
end;
$$;

comment on function audit.record_history() is
  'Generic row-history trigger. SECURITY DEFINER so the application role cannot write history directly.';

-- One-line attachment helper, so adding history to a new table is never skipped
-- for being fiddly.
create or replace function audit.attach_history(p_table regclass, variadic p_exclude text[] default '{}')
returns void
language plpgsql
as $$
declare
  v_trigger text := 'trg_record_history';
  v_args    text;
begin
  v_args := coalesce(
    (select string_agg(quote_literal(e), ', ') from unnest(p_exclude) as e),
    ''
  );

  execute format('drop trigger if exists %I on %s', v_trigger, p_table);
  execute format(
    'create trigger %I after insert or update or delete on %s for each row execute function audit.record_history(%s)',
    v_trigger, p_table, v_args
  );
end;
$$;

comment on function audit.attach_history(regclass, text[]) is
  'Attaches the generic history trigger to a table. Columns listed are stripped from both images.';

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
-- History is tenant data: one school must never read another school's audit
-- trail. System context (withSystemTx, no app.tenant_id set) sees nothing here
-- by design - background jobs have no business reading history, and a NULL GUC
-- silently matching every row is exactly the failure mode RLS exists to prevent.
alter table audit.record_history enable row level security;
create policy record_history_tenant_isolation on audit.record_history
  for select
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table audit.access_log enable row level security;
create policy access_log_tenant_isolation on audit.access_log
  for select
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table audit.bulk_operation enable row level security;
create policy bulk_operation_tenant_isolation on audit.bulk_operation
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Read-only on the history tables: the application can cause history to be
-- written (via the SECURITY DEFINER trigger) but can never write, amend or
-- delete it directly. bulk_operation is application-managed, so it is writable.
grant usage on schema audit to sms_app;
grant select                   on audit.record_history to sms_app;
grant select, insert           on audit.access_log     to sms_app;
grant select, insert, update   on audit.bulk_operation to sms_app;
grant execute on function audit.create_month_partition(date) to sms_app;
