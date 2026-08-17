import { ForbiddenError, isSystemContext, type TenantContext } from '@sms/kernel';
import { requireContext } from '@sms/db';

/**
 * Duplicated from `@sms/enrollment`'s `application/current-context.ts` rather
 * than imported - see that module's own comment for why (module-boundary:
 * only a sibling's public entrypoint is reachable, never its internal
 * `application/*`).
 *
 * Used only by `AdmissionsService` (the `AdmissionsContract` facade REST
 * controllers call through), which needs the ambient tenant - every other
 * service in this module takes `tenantId` explicitly (see `scoped-context.ts`).
 */
export function currentTenantContext(): TenantContext {
  const context = requireContext();
  if (isSystemContext(context)) {
    throw new ForbiddenError('This operation requires a resolved tenant context and cannot run under a system context.');
  }
  return context;
}
