-- =============================================================================
-- Closes the M1 loop: identity.membership.person_id -> people.person(id)
-- =============================================================================
-- identity.membership.person_id (0301_identity_membership.sql, in @sms/identity
-- - not edited; that module's migrations are frozen, see this module report's
-- constraints) was deliberately left as a bare, unconstrained uuid: "M2
-- (people) adds: references people.person (id) on delete restrict. Left as a
-- bare, unconstrained uuid until that table exists." That table now exists,
-- so this adds exactly the FK that comment promised, as its own migration in
-- this module's reserved range rather than editing identity's file.
--
-- ON DELETE RESTRICT (not CASCADE, not SET NULL): a person row is never
-- actually deleted (see people.person.merged_into_id / the 0500 migration
-- header - tombstones, not deletions), so this FK's delete action is
-- belt-and-braces and should in practice never fire.
-- =============================================================================

alter table identity.membership
  add constraint membership_person_id_fkey
  foreign key (person_id) references people.person (id) on delete restrict;
