import { isSystemContext, newId, type TenantContext, type TenantId } from '@sms/kernel';
import { getContext } from '@sms/db';

/**
 * A read/write scoped to exactly one tenant, for methods (`AbilityService`,
 * `RoleService`, `ImpersonationService`) that take `tenantId` explicitly
 * rather than reading it off ambient context - so they work equally from a
 * request (`AccessService`, which already resolved `currentTenantContext()`
 * one layer up), a seed script (no ambient context at all), or a test.
 *
 * Prefers the REAL ambient context when one is set and its tenant matches -
 * not just a bare `{ tenantId, roles: [], requestId }` throwaway (the
 * pattern `@sms/identity`'s `MembershipService.scopedContext` and
 * `@sms/tenancy`'s `TenantService.selfScopedContext` use, where the
 * ambient identity genuinely doesn't matter for the read in question).
 * Here it matters a great deal: `audit.record_history()` stamps
 * `changed_by` from `app.person_id`, which `withTenantTx` sets from
 * `TenantContext.personId` - a bare throwaway context has no `personId`,
 * which would make every write through this helper permanently
 * unattributable (`changed_by` always `NULL`), silently defeating the
 * impersonation-attribution property `apps/api`'s `TenantContextInterceptor`
 * establishes (see its own comment on the `app.person_id` bridge). Reusing
 * the real ambient context - already carrying the correct `personId` for
 * exactly this reason - costs nothing and fixes that for free, since
 * `RoleService`/`ImpersonationService`'s writes all run inside the same
 * `AsyncLocalStorage` call tree `AccessService` was already in.
 */
export function scopedContext(tenantId: TenantId): TenantContext {
  const ambient = getContext();
  if (ambient && !isSystemContext(ambient) && ambient.tenantId === tenantId) {
    return ambient;
  }
  return { tenantId, roles: [], requestId: newId() };
}
