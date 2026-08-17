import type { DateOnly, TenantId, UserId } from '@sms/kernel';

/**
 * The inversion point that lets `section`-scoped grants resolve WITHOUT
 * `@sms/access` (`type:platform`) depending on `@sms/academic`
 * (`type:domain`) - the `@nx/enforce-module-boundaries` rule forbids that
 * direction outright, and for good reason: platform modules are meant to be
 * usable by every domain module, not coupled to one of them.
 *
 * `@sms/access` defines this PORT and a safe default implementation
 * (`DEFAULT_SECTION_SCOPE_RESOLVER`, below) that resolves to nothing;
 * `@sms/academic` implements the real thing (`SectionScopeResolverService`,
 * mapping a user to their `people.person` id via `identity.membership`, then
 * to their current `academic.section_teacher` rows); `apps/api` is the only
 * place that wires the two together, via `AcademicModule` being `@Global()`
 * and providing this same token (see that module's own comment) - the one
 * layer allowed to depend on both `type:platform` and `type:domain`.
 */
export interface SectionScopeResolver {
  /** Section ids this user is currently assigned to teach, as of `asOf` (default: today). */
  resolveTeachingSectionIds(userId: UserId, tenantId: TenantId, asOf?: DateOnly): Promise<string[]>;
}

/**
 * DI token for `SectionScopeResolver`. Not registered as a provider inside
 * `AccessModule` itself (deliberately - see `AbilityService`'s constructor):
 * doing so would make `AccessModule`'s own local binding permanently win
 * over anything `apps/api` tries to supply from outside, since Nest resolves
 * a class's dependencies from the providers visible to the module that
 * DECLARES the class, not the module composing the app. Leaving it
 * unregistered here and letting `AcademicModule` provide it as a `@Global()`
 * module is what makes the override actually reach `AbilityService`.
 */
export const SECTION_SCOPE_RESOLVER = Symbol('SECTION_SCOPE_RESOLVER');

/**
 * The safe default: preserves today's fail-closed behaviour when nothing
 * implements the port (no academic module wired up, or a test that
 * constructs `AbilityService` directly) - a MISSING resolver must never
 * widen a grant to "everything", so it resolves to zero sections rather than
 * throwing or being treated as unrestricted.
 */
export const DEFAULT_SECTION_SCOPE_RESOLVER: SectionScopeResolver = {
  async resolveTeachingSectionIds(): Promise<string[]> {
    return [];
  },
};
