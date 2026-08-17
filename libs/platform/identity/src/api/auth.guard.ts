import { Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyRequest } from 'fastify';
import type { UserId } from '@sms/kernel';
import { IDENTITY_CONTRACT, type IdentityContract } from '../contract.js';
import { MembershipService } from '../application/membership.service.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import type { FastifyRequestWithIdentity } from './request-identity.js';

/**
 * Global authentication gate (`APP_GUARD` in `apps/api`'s `AppModule`),
 * replacing the header-trust `TenantContextInterceptor` used to do alone
 * (M1a: `x-tenant-id` et al., a local-diagnostics mechanism, not real auth).
 *
 * Resolves the Better Auth session from the request's cookies and, if the
 * session has an `activeTenantId`, confirms an *active* `identity.membership`
 * still exists for it - defense in depth against a session carrying a stale
 * or tampered tenant (membership status can change - e.g. suspended - after
 * the session was issued). Attaches the result to the request for
 * `TenantContextInterceptor` to build the ambient `TenantContext` from
 * (`request.identity`); does not build that context itself - `resolveScope`
 * validation of the requested campus/academic year stays the interceptor's
 * job, per the module spec.
 *
 * A session with no `activeTenantId` (a multi-membership user who has not
 * called `setActiveTenant` yet) is authenticated but not tenant-scoped: it
 * is let through with `activeTenantId: null` so it can still reach
 * `GET /api/v1/auth/me`, `listMemberships`, and `setActiveTenant` - any
 * genuinely tenant-scoped endpoint then fails downstream (`currentTenantContext()`
 * throwing `ForbiddenError`) rather than here.
 *
 * Reads the `@Public()` metadata with `Reflect.getMetadata` rather than
 * injecting Nest's `Reflector`. This originally worked around `apps/api` and
 * this package resolving separate physical copies of `@nestjs/core`, which made
 * `Reflector` a different class here than the token Nest's container registers,
 * so `@Inject(Reflector)` failed at boot. That root cause is gone - the
 * workspace now uses `nodeLinker: hoisted` (see `.npmrc`), so there is exactly
 * one copy of every Nest package and `Reflector` would inject correctly.
 *
 * Kept as-is because it is not a workaround so much as the same thing one layer
 * down: `SetMetadata` and `Reflector` are themselves thin wrappers over this
 * global `reflect-metadata` polyfill, which `main.ts` imports once per process.
 * Switching to `Reflector` would be equally correct and slightly more idiomatic.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(IDENTITY_CONTRACT) private readonly identity: IdentityContract,
    @Inject(MembershipService) private readonly memberships: MembershipService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic =
      Boolean(Reflect.getMetadata(IS_PUBLIC_KEY, context.getHandler())) ||
      Boolean(Reflect.getMetadata(IS_PUBLIC_KEY, context.getClass()));
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest & FastifyRequestWithIdentity>();

    // Already authenticated by an earlier-registered guard - @sms/public-api's
    // ApiKeyGuard, for `Authorization: Bearer <api key>` requests, populates
    // `request.identity` in this exact shape before this guard ever runs (see
    // its own comment for the full reasoning: a machine client has no cookie
    // to resolve a Better Auth session from at all, so falling through to the
    // lookup below would always 401 it). Guards run in APP_GUARD registration
    // order, and apps/api's AppModule registers ApiKeyGuard first - this is
    // the ONE place that ordering is load-bearing.
    if (request.identity) {
      return true;
    }

    const headers = fromNodeHeaders(request.headers);

    const session = await this.identity.getSession(headers);
    if (!session) {
      throw new UnauthorizedException('No valid session.');
    }

    let activeTenantId = session.activeTenantId;
    if (activeTenantId) {
      const membership = await this.memberships.getForUserAndTenant(session.user.id, activeTenantId);
      if (!membership || membership.status !== 'active') {
        // The session's tenant is no longer a usable one (revoked/suspended
        // after the session was issued, or otherwise invalid) - treat as no
        // active tenant rather than trusting the stale value.
        activeTenantId = null;
      }
    }

    request.identity = { userId: session.user.id as UserId, activeTenantId };
    return true;
  }
}
