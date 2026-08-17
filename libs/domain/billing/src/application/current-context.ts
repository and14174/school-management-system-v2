import { ForbiddenError, isSystemContext, type TenantContext } from '@sms/kernel';
import { requireContext } from '@sms/db';

/**
 * Duplicated from `@sms/records`'s `application/current-context.ts` rather
 * than imported - a package can only reach another workspace package's
 * public entrypoint, never a sibling's internal `application/*` file (module
 * boundary). See that copy for the fuller reasoning; this is the same
 * helper.
 *
 * Used only by `BillingService` (the `BillingContract` facade REST
 * controllers call through), which needs the ambient tenant - every other
 * service in this module takes `tenantId` explicitly (see
 * `scoped-context.ts`).
 */
export function currentTenantContext(): TenantContext {
  const context = requireContext();
  if (isSystemContext(context)) {
    throw new ForbiddenError('This operation requires a resolved tenant context and cannot run under a system context.');
  }
  return context;
}
