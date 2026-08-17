import { Global, Injectable, Module } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { isSystemContext, newId, type DateOnly, type PersonId, type TenantContext, type TenantId, type UserId } from '@sms/kernel';
import { getContext, withTenantTx, type Tx } from '@sms/db';
import { DEPENDANT_SCOPE_RESOLVER, type DependantScopeResolver } from '@sms/access';

/**
 * `apps/api` and `@sms/db` each resolve their own copy of `drizzle-orm`
 * under this workspace's `nodeLinker: hoisted` pnpm layout - see
 * `import-export/people-import-target.ts`'s own comment for the full
 * explanation (same duplicate-module-instance class of issue `main.ts`
 * documents for `fastify` plugins). `as never` bridges the two type
 * identities; both behave identically at runtime.
 */
function execute(tx: Tx, query: SQL): Promise<unknown> {
  return tx.execute(query as never);
}

/**
 * Duplicated from `@sms/academic`'s `application/scoped-context.ts` (itself
 * duplicated from `@sms/people`'s) rather than imported - same reasoning:
 * this is a five-line helper, not worth reaching into another module's
 * internals for, and `apps/api` has no sibling-module public entrypoint to
 * reach here anyway (this file has no owning domain module of its own).
 */
function scopedContext(tenantId: TenantId): TenantContext {
  const ambient = getContext();
  if (ambient && !isSystemContext(ambient) && ambient.tenantId === tenantId) {
    return ambient;
  }
  return { tenantId, roles: [], requestId: newId() };
}

/**
 * The real `DependantScopeResolver` - `@sms/access`'s `DEPENDANT_SCOPE_RESOLVER`
 * port (`application/dependant-scope-resolver.ts` there). Implemented
 * directly in `apps/api`, unlike `SECTION_SCOPE_RESOLVER` (whose real
 * implementation lives inside `@sms/academic` and is merely wired up here as
 * a `@Global()` module): no domain module owns "a guardian's own children"
 * the way `@sms/academic` owns sections, so this one is `apps/api`'s own
 * code from the start - it is, after all, the one layer allowed to depend on
 * both `@sms/access` (`type:platform`) and `@sms/people`/`@sms/identity`'s
 * schemas (`type:domain`).
 *
 * `userId -> personId` goes through `identity.membership`, and
 * `personId -> children` through `people.relationship` directly, both by raw
 * SQL in a single joined query (same precedent as `AbilityService.
 * resolvePersonId`/`@sms/academic`'s `SectionScopeResolverService`: this
 * package can reach neither module's internal schema, only its public
 * contract, and a raw cross-schema read is the established escape hatch).
 *
 * `people.relationship` is directed: `from_person_id` is the guardian OF
 * `to_person_id` (see `@sms/people`'s `contract.ts` - `CreateRelationshipInput`'s
 * own field comments - and its `0500` migration header). A "dependant" is
 * therefore anyone this person is the `from_person_id` for, restricted to
 * relationship TYPES that actually mean guardianship (`'parent'`,
 * `'guardian'`) rather than every relationship row: a sibling, emergency
 * contact or authorized-pickup relationship does not confer the right to
 * read a child's grades or attendance record - only a parent/guardian
 * relationship does.
 *
 * Deliberately does NOT filter on `may_receive_comms`. That flag governs
 * whether a guardian receives broadcast COMMUNICATIONS (see this file's
 * sibling `notifications/guardian-recipient-resolver.ts`) - it says nothing
 * about whether they may READ their child's record. Filtering on it here
 * would silently deny a parent access to their own child's grades because of
 * an unrelated mailing-preference flag, which is exactly the class of silent
 * over-restriction `docs/decisions.md` warns against elsewhere in this
 * codebase (see "A GRANT without a matching policy is a silent denial" and
 * "Unresolvable permission scopes deny, never widen").
 *
 * Phase 1 posture, stated plainly: EVERY qualifying guardian relationship
 * confers full read access to the child's record. `has_custody` exists as a
 * column on `people.relationship` today but is not consulted here - real
 * custody restrictions (a court order, a parent legally barred from a
 * child's records) are a known future refinement, not something this module
 * invents an approximation of.
 *
 * `people.relationship` carries no effective-dating (`valid_from`/`valid_to`)
 * the way `academic.section_teacher` does, so `asOf` is accepted (to satisfy
 * the port's signature - `AbilityService` always passes it) but unused: a
 * guardian relationship is either on file or it is not, there is no "as of
 * which date" to resolve against.
 */
@Injectable()
class RealDependantScopeResolver implements DependantScopeResolver {
  async resolveDependantPersonIds(userId: UserId, tenantId: TenantId, _asOf?: DateOnly): Promise<PersonId[]> {
    const ctx = scopedContext(tenantId);

    const rows = await withTenantTx(ctx, (db) =>
      execute(
        db,
        sql`
          select distinct r.to_person_id
          from people.relationship r
          join identity.membership m on m.person_id = r.from_person_id and m.tenant_id = r.tenant_id
          where r.tenant_id = ${tenantId}
            and m.user_id = ${userId}
            and r.type in ('parent', 'guardian')
        `,
      ),
    );

    return (rows as Array<{ to_person_id: string }>).map((row) => row.to_person_id as PersonId);
  }
}

/**
 * `@Global()`: this is what actually lets `@sms/access`'s `AbilityService`
 * (living inside `AccessModule`'s own DI container) see the
 * `DEPENDANT_SCOPE_RESOLVER` override - exactly the reasoning
 * `AttendanceSummaryProviderModule`/`AcademicModule` document for their own
 * tokens (same file shape, same precedent). `apps/api`'s `AppModule` still
 * has to import this module once for Nest to instantiate it.
 */
@Global()
@Module({
  providers: [RealDependantScopeResolver, { provide: DEPENDANT_SCOPE_RESOLVER, useExisting: RealDependantScopeResolver }],
  exports: [DEPENDANT_SCOPE_RESOLVER],
})
export class DependantScopeResolverModule {}
