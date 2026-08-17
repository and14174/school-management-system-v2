import { ForbiddenError, isSystemContext, type TenantContext } from '@sms/kernel';
import { requireContext } from '@sms/db';

/**
 * Every read/write in this module below `resolveScope` (which deliberately
 * takes its tenant explicitly, since it runs *before* ambient context exists
 * - see `tenancy.service.ts`) operates on "the current tenant", carried via
 * `AsyncLocalStorage` by `@sms/db`'s `runWithContext` (set for every HTTP
 * request by `TenantContextInterceptor`). This is one of the six
 * hard-to-reverse decisions `arch-check.ts` guards structurally: this helper
 * is the one place that reaches for it, so a service can never accidentally
 * trust a caller-supplied tenant id instead.
 */
export function currentTenantContext(): TenantContext {
  const context = requireContext();
  if (isSystemContext(context)) {
    throw new ForbiddenError(
      'This operation requires a resolved tenant context and cannot run under a system context.',
    );
  }
  return context;
}
