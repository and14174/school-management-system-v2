import type { DateOnly, PersonId, TenantId, UserId } from '@sms/kernel';

/**
 * The inversion point that lets `dependants`-scoped grants resolve WITHOUT
 * `@sms/access` (`type:platform`) depending on `@sms/people`
 * (`type:domain`) - the `@nx/enforce-module-boundaries` rule forbids that
 * direction outright, and for good reason: platform modules are meant to be
 * usable by every domain module, not coupled to one of them.
 *
 * `@sms/access` defines this PORT and a safe default implementation
 * (`DEFAULT_DEPENDANT_SCOPE_RESOLVER`, below) that resolves to nothing;
 * `apps/api` implements the real thing, mapping a user to their
 * `people.person` id via `identity.membership`, then to the children of
 * that person via `people.relationship` (`from_person_id` = guardian,
 * `to_person_id` = child - see `@sms/people`'s `contract.ts` and its `0500`
 * migration header for that direction); `apps/api` is the only place that
 * wires the two together - the one layer allowed to depend on both
 * `type:platform` and `type:domain`. This mirrors `SectionScopeResolver`
 * (`application/section-scope-resolver.ts`) in every respect except one:
 * that port's real implementation lives inside `@sms/academic` itself
 * (a domain module `apps/api` merely wires up as `@Global()`), whereas this
 * one is implemented directly in `apps/api`, because no domain module owns
 * "a guardian's own children" the way `@sms/academic` owns sections.
 */
export interface DependantScopeResolver {
  /** Person ids of every child this user is a guardian of, as of `asOf` (default: today). */
  resolveDependantPersonIds(userId: UserId, tenantId: TenantId, asOf?: DateOnly): Promise<PersonId[]>;
}

/**
 * DI token for `DependantScopeResolver`. Not registered as a provider inside
 * `AccessModule` itself (deliberately - see `AbilityService`'s constructor):
 * doing so would make `AccessModule`'s own local binding permanently win
 * over anything `apps/api` tries to supply from outside, since Nest resolves
 * a class's dependencies from the providers visible to the module that
 * DECLARES the class, not the module composing the app. Leaving it
 * unregistered here and letting `apps/api` provide it as a `@Global()`
 * module is what makes the override actually reach `AbilityService`.
 */
export const DEPENDANT_SCOPE_RESOLVER = Symbol('DEPENDANT_SCOPE_RESOLVER');

/**
 * The safe default: preserves today's fail-closed behaviour when nothing
 * implements the port (no `apps/api` binding wired up, or a test that
 * constructs `AbilityService` directly) - a MISSING resolver must never
 * widen a grant to "everything", so it resolves to zero dependants rather
 * than throwing or being treated as unrestricted.
 */
export const DEFAULT_DEPENDANT_SCOPE_RESOLVER: DependantScopeResolver = {
  async resolveDependantPersonIds(): Promise<PersonId[]> {
    return [];
  },
};
