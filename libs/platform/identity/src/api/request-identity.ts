import type { TenantId, UserId } from '@sms/kernel';

/**
 * What `AuthGuard` resolves from the session and stashes on the request for
 * `apps/api`'s `TenantContextInterceptor` to read - the replacement for the
 * `x-tenant-id`/`x-user-id` headers it used to trust directly. Guards run
 * before interceptors in Nest's request lifecycle, so this is always
 * populated (or the property is simply absent, on a `@Public()` route where
 * `AuthGuard` did not run) by the time the interceptor looks for it.
 */
export interface RequestIdentity {
  readonly userId: UserId;
  /** `null` when the session has no active tenant yet (a multi-membership user who hasn't called `setActiveTenant`). */
  readonly activeTenantId: TenantId | null;
}

export interface FastifyRequestWithIdentity {
  identity?: RequestIdentity;
}
