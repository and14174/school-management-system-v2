-- audit.record_history.changed_by must hold ONE kind of id, forever.
--
-- It was stamped from `app.person_id`, which is intended to carry a
-- `people.person` id once that table exists (M2). Until then there is no person
-- id, so the identity module was bridging a USER id into that GUC to avoid
-- leaving every write unattributed. That works today and quietly breaks later:
-- when M2 wires up the real person id, this column silently changes id space
-- part-way through its history, and no row records which space it belongs to.
-- An audit trail you cannot resolve back to a human is not an audit trail.
--
-- So changed_by is now explicitly the authenticated USER, read from its own
-- GUC. `app.person_id` stays reserved for the real person link and RLS `own`
-- scoping. The two are genuinely different facts: a person may have no login
-- at all (a young student), and a login is not a person record.
--
-- The impersonation case is the reason this matters most. `app.actor_user_id`
-- is always the REAL signed-in human, never the impersonation target - so an
-- impersonated write is attributable to whoever actually performed it, which
-- is the entire point of allowing impersonation at all.

alter table audit.record_history rename column changed_by to changed_by_user_id;

comment on column audit.record_history.changed_by_user_id is
  'The authenticated identity.user who made the change - the REAL actor, never an impersonation target. Always a user id, never a person id.';

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
    if v_before = v_after then
      return null;
    end if;
  else
    v_before := to_jsonb(old) - v_excluded;
  end if;

  v_record_id := coalesce(v_after, v_before) ->> 'id';
  if v_record_id is null then
    raise exception
      'audit.record_history: %.% has no "id" column; history cannot be attributed to a record',
      tg_table_schema, tg_table_name;
  end if;

  insert into audit.record_history (
    table_schema, table_name, record_id, operation,
    before, after, changed_by_user_id, tenant_id, request_id, bulk_operation_id
  )
  values (
    tg_table_schema,
    tg_table_name,
    v_record_id,
    lower(tg_op),
    v_before,
    v_after,
    -- app.actor_user_id, NOT app.person_id: see this migration's header.
    nullif(current_setting('app.actor_user_id', true), '')::uuid,
    coalesce(
      nullif(current_setting('app.tenant_id', true), '')::uuid,
      (coalesce(v_after, v_before) ->> 'tenant_id')::uuid
    ),
    nullif(current_setting('app.request_id', true), ''),
    nullif(current_setting('app.bulk_operation_id', true), '')::uuid
  );

  return null;
end;
$$;
