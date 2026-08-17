-- =============================================================================
-- custom_fields: tenant-defined field catalogue
-- =============================================================================
-- Every tenant needs to record data this product did not anticipate - a
-- "bus route" field on a student, a "dietary flag" on a guardian - without a
-- code change. Two designs get this wrong:
--
--   1. An entity-attribute-value table (one row per value: entity_id, key,
--      value). It looks flexible, but it makes every report unwritable: a
--      simple "list students where bus_route = 'B12'" becomes a pivot over an
--      unbounded number of key/value rows, and the query planner has nothing
--      to index against. Rejected outright - see the module brief.
--   2. A single untyped `jsonb` blob with no schema at all. Nothing stops a
--      "date_of_birth" custom field from holding the string "banana", and no
--      UI can render a sensible input for a field it knows nothing about.
--
-- The design here is the third option: the SET of fields a tenant has defined
-- for an entity type lives here, in one normal, indexable, reportable table
-- (`custom_fields.field_definition`) - not the values. The VALUES themselves
-- live on the owning table's own `custom_fields jsonb` column (e.g.
-- `people.person.custom_fields`), validated on write against a Zod schema
-- this module compiles from the matching rows here (see
-- `application/schema-compiler.ts`). A `jsonb_path_ops` GIN index on that
-- owning column is what keeps "students where custom_fields @> {...}"
-- queries fast without needing a table per tenant per field.
-- =============================================================================

create schema custom_fields;

-- -----------------------------------------------------------------------------
-- custom_fields.field_definition
-- -----------------------------------------------------------------------------
create table custom_fields.field_definition (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references tenancy.tenant (id) on delete restrict,
  -- Dotted module.entity string, matching the resource-naming convention
  -- @sms/access's permission catalogue already uses (e.g. 'people.person').
  -- Not a foreign key to anything - the set of valid entity types is defined
  -- by which owning tables declare a `custom_fields jsonb` column, in code,
  -- across modules this one cannot see.
  entity_type    text not null,
  key            text not null check (key ~ '^[a-z][a-z0-9_]*$'),
  label          text not null,
  data_type      text not null check (data_type in ('text', 'number', 'date', 'boolean', 'select', 'multiselect')),
  -- Allowed values for select/multiselect (a JSON array of strings); ignored
  -- for every other data_type. Enforced by application code when compiling
  -- the Zod schema, not by a CHECK here - a CHECK can see this row's own
  -- data_type change atomically with its own options, but cannot express
  -- "options must be a non-empty string array" as cleanly as Zod already
  -- does for us at compile time.
  options        jsonb not null default '[]'::jsonb,
  required       boolean not null default false,
  -- Whether this field should be offered as a filter/column in reporting UIs.
  -- Purely descriptive metadata - every field is reportable via the GIN index
  -- on the owning table's custom_fields column regardless of this flag.
  reportable     boolean not null default true,
  display_order  integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, entity_type, key)
);

comment on table custom_fields.field_definition is
  'The catalogue of tenant-defined custom fields per entity type. Values are NOT stored here - see the migration header. Compiled to a cached Zod schema by @sms/custom-fields''s application/schema-compiler.ts.';

create index field_definition_tenant_entity_idx
  on custom_fields.field_definition (tenant_id, entity_type, display_order);

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function custom_fields.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_set_updated_at before update on custom_fields.field_definition
  for each row execute function custom_fields.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
alter table custom_fields.field_definition enable row level security;
create policy field_definition_tenant_isolation on custom_fields.field_definition
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Audit history
-- -----------------------------------------------------------------------------
select audit.attach_history('custom_fields.field_definition');

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Migrations run as sms_owner, which owns this table; sms_app gets no default
-- privileges on objects sms_owner creates, so it needs explicit grants.
-- sms_app is NOBYPASSRLS and owns nothing here (arch-check.ts checks 3 and 4).
grant usage on schema custom_fields to sms_app;
grant select, insert, update, delete on custom_fields.field_definition to sms_app;
