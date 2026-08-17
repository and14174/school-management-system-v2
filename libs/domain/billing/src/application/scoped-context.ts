import { isSystemContext, newId, type TenantContext, type TenantId } from '@sms/kernel';
import { getContext } from '@sms/db';

/**
 * A read/write scoped to exactly one tenant, for every service method in
 * this module, all of which take `tenantId` explicitly rather than reading
 * it off ambient context - so they work equally from a real request, the
 * seed script (no ambient context at all), or a test. Duplicated from
 * `@sms/communications`'s `application/scoped-context.ts` rather than
 * imported - see its own comment for why (module-boundary: only a sibling's
 * public entrypoint is reachable, never its internal `application/*`).
 */
export function scopedContext(tenantId: TenantId): TenantContext {
  const ambient = getContext();
  if (ambient && !isSystemContext(ambient) && ambient.tenantId === tenantId) {
    return ambient;
  }
  return { tenantId, roles: [], requestId: newId() };
}
