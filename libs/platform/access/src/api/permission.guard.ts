import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ForbiddenError, type TenantId, type UserId } from '@sms/kernel';
import type { FastifyRequestWithIdentity } from '@sms/identity';
import { ACCESS_CONTRACT, type AccessContract } from '../contract.js';
import { REQUIRE_PERMISSION_KEY } from './require-permission.decorator.js';

/**
 * Runs after `@sms/identity`'s `AuthGuard` (registered after it in
 * `apps/api`'s `AppModule` - guards run in registration order). Only routes
 * carrying `@RequirePermission(key)` are checked; everything else is left
 * alone, so this never has to duplicate `AuthGuard`'s `@Public()` handling -
 * an undecorated route (health checks, `@sms/tenancy`/`@sms/identity`'s own
 * endpoints, this module's own read endpoints) is simply not this guard's
 * concern.
 *
 * Runs BEFORE `TenantContextInterceptor` (guards run before interceptors),
 * so no ambient `TenantContext`/`AsyncLocalStorage` value exists yet here -
 * this resolves tenant/user straight off `request.identity`
 * (`AuthGuard`-populated), exactly like `TenantContextInterceptor` itself
 * does to build that ambient context afterwards.
 *
 * Checks the EFFECTIVE identity, not the signed-in one: if the caller has an
 * active impersonation session, the permission check runs against the
 * impersonation target's compiled ability, because impersonation means
 * "see and do exactly what this user can" - not "use my own admin
 * permissions while looking at their account". Audit attribution back to the
 * real actor is a separate concern, handled by `TenantContextInterceptor`
 * (see its comment on `app.person_id`), not by this guard.
 *
 * Reads the `@RequirePermission` metadata with `Reflect.getMetadata` rather
 * than injecting Nest's `Reflector`, for the exact reason `AuthGuard`'s own
 * comment documents (kept for consistency with it, even though the original
 * cross-package `Reflector` identity issue is gone).
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(@Inject(ACCESS_CONTRACT) private readonly access: AccessContract) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required =
      (Reflect.getMetadata(REQUIRE_PERMISSION_KEY, context.getHandler()) as string | undefined) ??
      (Reflect.getMetadata(REQUIRE_PERMISSION_KEY, context.getClass()) as string | undefined);
    if (!required) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest & FastifyRequestWithIdentity>();
    const identity = request.identity;
    if (!identity?.activeTenantId) {
      throw new ForbiddenError('No tenant is resolved for this request.');
    }

    const tenantId = identity.activeTenantId as TenantId;
    const activeImpersonation = await this.access.getActiveImpersonation(identity.userId, tenantId);
    const effectiveUserId: UserId = activeImpersonation?.targetUserId ?? identity.userId;

    const ability = await this.access.compileAbility(effectiveUserId, tenantId);

    const separatorIndex = required.lastIndexOf(':');
    const resource = required.slice(0, separatorIndex);
    const action = required.slice(separatorIndex + 1);

    if (!ability.can(action, resource)) {
      throw new ForbiddenError(`Missing permission "${required}".`);
    }

    return true;
  }
}
