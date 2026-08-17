-- Makes a reverted import actually revert.
--
-- `people.person` deliberately grants sms_app no DELETE (see the 0500 header:
-- a person row is never truly removed, because old ids live on in URLs,
-- exports and external integrations). That rule is right for a MERGE, where the
-- losing id was real and may still be referenced.
--
-- But it also meant a bulk import that created 1,200 people could not be undone
-- at all: `import_export.revert()` undoes a CREATE by deleting the row, and the
-- grant refused. A school that imports the wrong file and is then told the
-- import cannot be reversed has lost more trust than a missing feature ever
-- would - and reversible bulk operations are one of the product's stated
-- differentiators.
--
-- So reverting ARCHIVES instead of deleting. The row survives (ids keep
-- resolving, exactly like a merge tombstone) but disappears from every read
-- path, which is what the school actually asked for. It stays visible to audit
-- and can be un-archived, so a mistaken revert is not a second disaster.
--
-- Note this needs no new grant: sms_app already has UPDATE.

alter table people.person
  add column archived_at  timestamptz,
  add column archived_reason text;

comment on column people.person.archived_at is
  'Set when the row is withdrawn from view without being deleted (e.g. a reverted import). Archived people are excluded from every read path but keep resolving by id, like a merge tombstone.';

-- Partial index: the overwhelmingly common query is "not archived", and a
-- partial index keeps that path the same cost it was before this column existed.
create index person_active_idx
  on people.person (tenant_id)
  where archived_at is null;
