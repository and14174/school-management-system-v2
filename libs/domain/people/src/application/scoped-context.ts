import { isSystemContext, newId, type TenantContext, type TenantId } from '@sms/kernel';
import { getContext } from '@sms/db';

/**
 * A read/write scoped to exactly one tenant, for every service method in
 * this module (`PersonService`, `RoleService`, ...), all of which take
 * `tenantId` explicitly rather than reading it off ambient context - so they
 * work equally from a real request (already inside `TenantContextInterceptor`'s
 * ambient context), the seed script (no ambient context at all), or a test.
 * Duplicated from `@sms/access`'s `application/scoped-context.ts` rather
 * than imported - see its own comment for why (module-boundary: only a
 * sibling's public entrypoint is reachable, never its internal
 * `application/*`).
 *
 * Prefers the REAL ambient context when one is set and its tenant matches,
 * so a write made from inside a real request still attributes
 * `audit.record_history.changed_by_user_id` to the actual actor rather than
 * leaving it NULL - see `@sms/access`'s copy for the fuller reasoning.
 */
export function scopedContext(tenantId: TenantId): TenantContext {
  const ambient = getContext();
  if (ambient && !isSystemContext(ambient) && ambient.tenantId === tenantId) {
    return ambient;
  }
  return { tenantId, roles: [], requestId: newId() };
}
