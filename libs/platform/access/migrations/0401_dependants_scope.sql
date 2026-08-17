-- =============================================================================
-- access: add the 'dependants' permission scope
-- =============================================================================
-- 'own' resolves to exactly the acting person - it cannot express "a parent
-- may read their own child's attendance/grades/report cards", because a
-- guardian's login and the child's people.person record are two different
-- people. 'dependants' is that missing scope: a guardian's grant resolves to
-- the set of children they are a guardian OF, via a new inversion port
-- (`DEPENDANT_SCOPE_RESOLVER`, @sms/access's application/
-- dependant-scope-resolver.ts) implemented in apps/api - same shape as
-- 'section'/SECTION_SCOPE_RESOLVER, and the same fail-closed rule applies: a
-- resolver that finds no children (or is not wired up at all) emits NO rule,
-- never "everything" - see application/ability.service.ts's 'dependants'
-- case.
--
-- Only ADDs the enum value; nothing in this migration file uses it, since
-- Postgres forbids using a value added by ALTER TYPE ... ADD VALUE within the
-- same transaction that added it.
-- =============================================================================

alter type access.permission_scope add value 'dependants';

comment on type access.permission_scope is
  'How far a grant reaches. own/campus/tenant are resolvable today. section (a teacher''s currently-taught sections, via SECTION_SCOPE_RESOLVER) and dependants (a guardian''s own children, via DEPENDANT_SCOPE_RESOLVER) are resolvable once their respective port is wired up in apps/api, and resolve to NOTHING (never "everything") if it is not. grade_level is declared for a future module and has no resolver yet - see the 0400 migration header and ability.service.ts.';
