import { ForbiddenError, isSystemContext, type TenantContext } from '@sms/kernel';
import { requireContext } from '@sms/db';

/**
 * Same helper as `@sms/notifications`' `application/current-context.ts` -
 * duplicated rather than imported because a package can only reach another
 * workspace package's public entrypoint, never a sibling's internal
 * `application/*` file (module boundary). Every method on `ApprovalsService`
 * resolves the ambient tenant this way, same as `NotificationsService`.
 */
export function requireTenantContext(): TenantContext {
  const context = requireContext();
  if (isSystemContext(context)) {
    throw new ForbiddenError('@sms/approvals operations require a resolved tenant context.');
  }
  return context;
}
