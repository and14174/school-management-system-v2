import { ForbiddenError, isSystemContext, type TenantContext } from '@sms/kernel';
import { requireContext } from '@sms/db';

/**
 * Duplicated from `@sms/access`'s `application/current-context.ts` rather
 * than imported - see that module's own comment for why (module-boundary:
 * only a sibling's public entrypoint is reachable, never its internal
 * `application/*`).
 *
 * Used by `ImportExportService` (the `ImportExportContract` facade REST
 * controllers call through) - every method on the contract takes only the
 * ids the caller already knows (`jobId`, ...), never `tenantId` explicitly,
 * exactly like `PeopleContract`.
 */
export function currentTenantContext(): TenantContext {
  const context = requireContext();
  if (isSystemContext(context)) {
    throw new ForbiddenError('This operation requires a resolved tenant context and cannot run under a system context.');
  }
  return context;
}
