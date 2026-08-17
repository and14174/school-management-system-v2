import { HttpException, HttpStatus, Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ForbiddenError } from '@sms/kernel';
import { IS_PUBLIC_KEY, type FastifyRequestWithIdentity } from '@sms/identity';
import { REQUIRE_PERMISSION_KEY } from '@sms/access';
import { PUBLIC_API_CONTRACT, type PublicApiContract } from '../contract.js';
import { RATE_LIMITER, type RateLimiter } from '../application/rate-limiter.js';

const BEARER_PREFIX = 'Bearer ';
const API_KEY_TOKEN_PREFIX = 'sms_key_';

/**
 * Machine authentication: `Authorization: Bearer sms_key_<prefix>.<secret>`.
 * Registered as an `APP_GUARD` in `apps/api`'s `AppModule`, BEFORE
 * `@sms/identity`'s `AuthGuard` - see that ordering's own comment there.
 *
 * The whole point of this guard is to slot into the EXISTING pipeline, not
 * build a second one:
 *
 *   - On success it populates `request.identity = { userId, activeTenantId }`
 *     in EXACTLY the shape `AuthGuard` populates it from a cookie session -
 *     `userId` is the key's `created_by_user_id` (the human who minted it),
 *     `activeTenantId` is the key's own `tenant_id`. `AuthGuard` (patched
 *     with a two-line early-return - see its own comment) then does nothing
 *     further, and `TenantContextInterceptor`/`PermissionGuard` downstream
 *     cannot tell a key-authenticated request from a cookie-authenticated
 *     one: `PermissionGuard` compiles the CREATOR's role-derived ability
 *     exactly as it would for that user's own session, which is what
 *     enforces "a key can never exceed its creator's permissions" - and
 *     re-enforces it on every request, since a permission removed from that
 *     user's role stops working immediately (`PermissionGuard`'s
 *     `AbilityCache` is invalidated on every role change, unmodified).
 *
 *   - This guard ADDITIONALLY enforces the narrower, key-specific bound:
 *     the route's `@RequirePermission` key must be in THIS key's own
 *     `granted_permissions` (an explicit subset chosen at mint time, itself
 *     never wider than the creator's permissions - see
 *     `ApiKeysService.mint`). A route with no `@RequirePermission` at all is
 *     refused outright for key auth (`ForbiddenError`) - unlike a human
 *     session, a machine key is never given the benefit of "ungated beyond
 *     ordinary authentication" (e.g. `GET /access/roles`); it may only call
 *     endpoints that declare exactly what they need.
 *
 * A `Bearer` token that is present but NOT shaped like one of our keys
 * (`sms_key_...`) is left alone entirely - `canActivate` returns `true` and
 * `AuthGuard` proceeds with its ordinary cookie-session resolution. This
 * matters for Swagger UI's "Authorize" bearer field and any other bearer
 * scheme that might show up in an `Authorization` header without meaning
 * "this is one of our API keys".
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(PUBLIC_API_CONTRACT) private readonly keys: PublicApiContract,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic =
      Boolean(Reflect.getMetadata(IS_PUBLIC_KEY, context.getHandler())) ||
      Boolean(Reflect.getMetadata(IS_PUBLIC_KEY, context.getClass()));
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest & FastifyRequestWithIdentity>();
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith(BEARER_PREFIX)) return true;

    const token = authorization.slice(BEARER_PREFIX.length).trim();
    if (!token.startsWith(API_KEY_TOKEN_PREFIX)) return true;

    const principal = await this.keys.authenticate(token, {
      method: request.method,
      path: request.url ?? '',
    });
    if (!principal) {
      // Deliberately the same message whether the key is unknown, has the
      // wrong secret, is revoked, or is expired - see
      // `PublicApiContract.authenticate`'s own comment on why those are
      // undifferentiated.
      throw new UnauthorizedException('Invalid, revoked, or expired API key.');
    }

    const rate = await this.rateLimiter.consume(principal.id);
    if (!rate.allowed) {
      throw new HttpException(
        `Rate limit of ${rate.limit} requests/minute exceeded for this API key.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const required =
      (Reflect.getMetadata(REQUIRE_PERMISSION_KEY, context.getHandler()) as string | undefined) ??
      (Reflect.getMetadata(REQUIRE_PERMISSION_KEY, context.getClass()) as string | undefined);

    if (!required) {
      throw new ForbiddenError('API keys may only call endpoints that declare a required permission.');
    }
    if (!principal.grantedPermissions.includes(required)) {
      throw new ForbiddenError(`This API key does not have permission "${required}".`);
    }

    // Same shape AuthGuard populates from a cookie session - see this
    // class's own comment.
    request.identity = { userId: principal.createdByUserId, activeTenantId: principal.tenantId };

    return true;
  }
}
