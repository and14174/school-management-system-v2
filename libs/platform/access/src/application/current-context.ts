import { ForbiddenError, isSystemContext, type TenantContext } from '@sms/kernel';
import { requireContext } from '@sms/db';

/**
 * Duplicated from `@sms/tenancy`'s `application/current-context.ts` rather
 * than imported - a package can only reach another workspace package's
 * public entrypoint, never a sibling's internal `application/*` file (see
 * `@sms/identity`'s `application/sql-errors.ts` for the same reasoning).
 *
 * Every ambient-tenant read/write in this module below `compileAbility`
 * (which deliberately takes its tenant/user explicitly, since `PermissionGuard`
 * and `TenantContextInterceptor` need to compile an ability for someone
 * other than "whoever is ambient" - the impersonation target) goes through
 * `AsyncLocalStorage` via `@sms/db`'s `requireContext`, set for every HTTP
 * request by `TenantContextInterceptor`.
 */
export function currentTenantContext(): TenantContext {
  const context = requireContext();
  if (isSystemContext(context)) {
    throw new ForbiddenError('This operation requires a resolved tenant context and cannot run under a system context.');
  }
  return context;
}
