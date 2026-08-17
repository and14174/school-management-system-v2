import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ForbiddenError, isSystemContext } from '@sms/kernel';
import { requireContext } from '@sms/db';
import { IDENTITY_CONTRACT, type IdentityContract } from '@sms/identity';
import { ACCESS_CONTRACT, type AccessContract } from '../contract.js';

/**
 * The caller's effective permissions - what the web app uses to gate
 * navigation (e.g. hide the "Grades" tab from a Parent). Reads the ambient
 * `TenantContext`'s `userId`, which `apps/api`'s `TenantContextInterceptor`
 * has already resolved to the EFFECTIVE identity (the impersonation target,
 * if a session is currently impersonating - see that interceptor's own
 * comment) - so a support engineer impersonating a teacher sees exactly the
 * permissions that teacher would see here, not their own.
 */
@ApiTags('access')
@Controller('access')
export class MeController {
  constructor(
    @Inject(ACCESS_CONTRACT) private readonly access: AccessContract,
    @Inject(IDENTITY_CONTRACT) private readonly identity: IdentityContract,
  ) {}

  @Get('me')
  async me() {
    const ctx = requireContext();
    if (isSystemContext(ctx) || !ctx.userId) {
      throw new ForbiddenError('No authenticated tenant context is resolved for this request.');
    }

    const [permissions, impersonation] = await Promise.all([
      this.access.listEffectivePermissions(ctx.userId, ctx.tenantId),
      // Keyed on the REAL actor, not ctx.userId - by this point ctx.userId is
      // already the impersonation target, who knows nothing about the session.
      ctx.actorUserId ? this.access.getActiveImpersonation(ctx.actorUserId, ctx.tenantId) : null,
    ]);

    // Resolve display names: an id is not something a human can sanity-check.
    // "You are acting as Yusuf Karimi" is the one fact the banner exists to
    // convey, and a uuid does not convey it.
    const [actor, target] = impersonation
      ? await Promise.all([
          this.identity.getUser(impersonation.actorUserId),
          this.identity.getUser(impersonation.targetUserId),
        ])
      : [null, null];

    // `impersonating` is not cosmetic. While impersonating, the caller's
    // permissions collapse to the target's - a support engineer acting as a
    // student legitimately sees almost nothing. Without this field the web app
    // cannot tell "you have no permissions" apart from "you are acting as
    // someone who has none", so the navigation silently empties with no
    // explanation and no way back. The banner it drives is the only exit.
    return {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      permissions,
      roles: ctx.roles,
      impersonating: impersonation
        ? {
            actorUserId: impersonation.actorUserId,
            actorName: actor?.ok ? (actor.value.name ?? actor.value.email) : null,
            targetUserId: impersonation.targetUserId,
            targetName: target?.ok ? (target.value.name ?? target.value.email) : null,
            reason: impersonation.reason,
            startedAt: impersonation.startedAt,
          }
        : null,
    };
  }
}
