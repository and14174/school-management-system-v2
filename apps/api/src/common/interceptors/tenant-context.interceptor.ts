import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { from, mergeMap, type Observable } from 'rxjs';
import {
  type AcademicYearId,
  type CampusId,
  type ExecutionContext as KernelExecutionContext,
} from '@sms/kernel';
import { runWithContext } from '@sms/db';
import { TENANCY_CONTRACT, type TenancyContract } from '@sms/tenancy';
import { IDENTITY_CONTRACT, type FastifyRequestWithIdentity, type IdentityContract } from '@sms/identity';
import { ACCESS_CONTRACT, type AccessContract } from '@sms/access';

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Builds the ambient `ExecutionContext` (see `@sms/kernel`) for every
 * request and runs the rest of the request inside `runWithContext`, so
 * `withTenantTx` / `withSystemTx` and anything else downstream can reach
 * it via `requireContext()` without threading it through every function
 * signature.
 *
 * M1b: the subject is the real Better Auth session, resolved by the global
 * `AuthGuard` (`@sms/identity`, registered in `AppModule`) *before* this
 * interceptor runs - guards run before interceptors in Nest's request
 * lifecycle. `AuthGuard` stashes the result on the request as
 * `request.identity` (`{ userId, activeTenantId }`); this interceptor reads
 * that, not any header. `x-tenant-id` is no longer honoured at all - a
 * request cannot grant itself tenant access by merely sending a header.
 *
 * What has NOT changed since M1a: `resolveScope` is still what validates the
 * caller-supplied `x-campus-id`/`x-academic-year-id` against the resolved
 * tenant (rejecting a campus/year that belongs to a different tenant) - only
 * the *tenant* half of the input moved from a header to the session.
 *
 * `request.identity` is absent on a `@Public()` route (`AuthGuard` returned
 * early without setting it - health checks, docs, Better Auth's own routes)
 * and when a session has no active tenant yet (a multi-membership user who
 * has not called `setActiveTenant`); both fall back to a system context,
 * exactly like "no x-tenant-id" did before.
 *
 * M1c (`@sms/access`): `userId`/`roles` resolve to the EFFECTIVE identity -
 * if the real signed-in user (`identity.userId`) has an active impersonation
 * session (`access.impersonation`, `ended_at is null`) for this tenant, this
 * builds the ambient context around the impersonation TARGET instead, and
 * `roles` reflects the target's role keys, not the actor's - "act as this
 * user" means seeing and doing exactly what they can, not more.
 *
 * Attribution uses three separate fields, deliberately not collapsed:
 *
 *   actorUserId - the REAL signed-in human, never the impersonation target.
 *                 `audit.record_history()` stamps `changed_by_user_id` from
 *                 this (via `app.actor_user_id`). Attributing an impersonated
 *                 write to the target would launder the very action the audit
 *                 trail exists to record.
 *   userId      - the EFFECTIVE user, which impersonation legitimately
 *                 changes: acting as someone means seeing what they see.
 *   personId    - M2 (`@sms/people`): the `people.person` id linked to the
 *                 EFFECTIVE user's `identity.membership` in this tenant (null
 *                 if that membership has no person link yet - not every
 *                 membership does, and a person is not a login: a young
 *                 student has a person record and no account, and a fresh
 *                 membership may not have been matched to a person record
 *                 yet). Resolved from `identity.membership.person_id` (see
 *                 the `0501` migration in `@sms/people`, which finally adds
 *                 the FK that column's own comment promised), via the
 *                 EFFECTIVE user (impersonation target when one is active),
 *                 matching how `userId`/`roles` already do - "act as this
 *                 user" means seeing exactly what they see, including which
 *                 person record RLS `own`-style scoping would resolve to.
 *                 Deliberately NOT what `changed_by_user_id` is stamped
 *                 from - that stays `app.actor_user_id` (the real actor),
 *                 exactly per this class's `actorUserId` note.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  // Explicit @Inject(): under tsx/esbuild's decorator metadata emission,
  // implicit type-based DI is not trusted in this codebase - see
  // apps/api's HealthController for the fuller explanation.
  constructor(
    @Inject(TENANCY_CONTRACT) private readonly tenancy: TenancyContract,
    @Inject(ACCESS_CONTRACT) private readonly access: AccessContract,
    // Named `identityContract`, not `identity` - `buildContext` below already
    // uses `identity` as the local name for `request.identity` (the
    // AuthGuard-resolved session subject), a different concept entirely.
    @Inject(IDENTITY_CONTRACT) private readonly identityContract: IdentityContract,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest & FastifyRequestWithIdentity>();

    // Fastify's own `genReqId` (configured in main.ts) already assigned
    // request.id - honouring an incoming x-request-id or minting a fresh
    // UUIDv7 if not. nestjs-pino reads the same id, so this is the one
    // value that ties a log line, an error envelope and this context
    // together.
    const requestId = request.id;

    // Building the context is async (resolveScope hits the database), but
    // NestInterceptor#intercept must return an Observable synchronously;
    // from(...) + mergeMap defers next.handle() until it resolves, same
    // shape as any other async guard/interceptor in this codebase.
    return from(this.buildContext(request, requestId)).pipe(
      mergeMap((executionContext) => {
        // Also stash it on the request. `runWithContext` covers everything that
        // runs while the handler executes, but NOT operators further down the
        // response pipeline: it builds the Observable inside the AsyncLocalStorage
        // scope and returns before anything is subscribed, so by the time a value
        // flows back through a downstream interceptor the scope is gone. Anything
        // that inspects the response (field masking, serialisation) has to read
        // the context from here instead.
        (request as { tenantContext?: KernelExecutionContext }).tenantContext = executionContext;
        return runWithContext(executionContext, () => next.handle());
      }),
    );
  }

  private async buildContext(
    request: FastifyRequest & FastifyRequestWithIdentity,
    requestId: string,
  ): Promise<KernelExecutionContext> {
    const identity = request.identity;

    if (!identity?.activeTenantId) {
      // No session-resolved tenant (public route, or an authenticated
      // session with no active tenant yet): treat as a system-level call.
      return { kind: 'system', requestId };
    }

    const scopeResult = await this.tenancy.resolveScope({
      tenantSlugOrId: identity.activeTenantId,
      campusId: firstHeaderValue(request.headers['x-campus-id']),
      academicYearId: firstHeaderValue(request.headers['x-academic-year-id']),
    });

    if (!scopeResult.ok) {
      // Thrown here (inside the async resolver `from()` wraps), so it flows
      // through the same rejected-Observable path next.handle() errors
      // would - the global DomainExceptionFilter maps DomainError.code
      // 'FORBIDDEN' to a 403 exactly as it would for one thrown by a
      // controller.
      throw scopeResult.error;
    }
    const scope = scopeResult.value;

    // Resolve the EFFECTIVE identity: the impersonation target if the real
    // actor currently has an active session for this tenant, else the actor
    // themselves - see this class's own doc comment.
    const activeImpersonation = await this.access.getActiveImpersonation(identity.userId, scope.tenantId);
    const effectiveUserId = activeImpersonation?.targetUserId ?? identity.userId;

    const roles = await this.access.listEffectiveRoleKeys(effectiveUserId, scope.tenantId);

    // The EFFECTIVE user's linked person record in this tenant, if any - see
    // this class's own doc comment on `personId`. `listMemberships` returns
    // every tenant that user belongs to; only this tenant's row matters here.
    const memberships = await this.identityContract.listMemberships(effectiveUserId);
    const personId = memberships.find((membership) => membership.tenantId === scope.tenantId)?.personId ?? undefined;

    return {
      tenantId: scope.tenantId,
      campusId: scope.campusId as CampusId | undefined,
      academicYearId: scope.academicYearId as AcademicYearId | undefined,
      userId: effectiveUserId,
      // The real human, never the impersonation target. Audit reads this.
      actorUserId: identity.userId,
      personId,
      roles,
      requestId,
    };
  }
}
