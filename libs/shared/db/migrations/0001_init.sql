-- 0001_init.sql
--
-- Proves the migration pipeline end to end, nothing more: creates the
-- `platform` schema every subsequent platform module hangs off, and a
-- `schema_version` marker table the API's health check reads from to prove
-- it can genuinely reach and query the database (not just open a socket).

create schema if not exists platform;

create table if not exists platform.schema_version (
  id int primary key default 1,
  version text not null,
  applied_at timestamptz not null default now(),
  constraint schema_version_single_row check (id = 1)
);

insert into platform.schema_version (id, version)
values (1, '0001_init')
on conflict (id) do update set version = excluded.version, applied_at = now();

-- sms_app has no default privileges on objects sms_owner creates - grant it
-- exactly what it needs and nothing more.
grant usage on schema platform to sms_app;
grant select on platform.schema_version to sms_app;
