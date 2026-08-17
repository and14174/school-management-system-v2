import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenError, type DateOnly, type DomainError, type NotFoundError, type Result, type TenantId, type UserId } from '@sms/kernel';
import type {
  AccessContract,
  AssignRoleInput,
  RevokeRoleInput,
  StartImpersonationInput,
} from '../contract.js';
import type {
  EffectivePermission,
  Impersonation,
  Permission,
  RoleAssignment,
  RolePermissionMatrixEntry,
  RoleWithGrants,
  ScopeConstraint,
} from '../domain/types.js';
import type { AppAbility } from './ability.types.js';
import { AbilityService } from './ability.service.js';
import { currentTenantContext } from './current-context.js';
import { ImpersonationService } from './impersonation.service.js';
import { RoleService } from './role.service.js';

function requireUserId(userId: UserId | undefined): UserId {
  if (!userId) {
    throw new ForbiddenError('No authenticated user is resolved for this request.');
  }
  return userId;
}

/**
 * Implements `AccessContract`. Thin composition layer over `AbilityService`
 * (ability compilation + caching), `RoleService` (catalogue + role
 * assignment CRUD) and `ImpersonationService` - exactly the shape
 * `IdentityService` composes `MembershipService` in `@sms/identity`, and
 * `TenancyService` composes its own CRUD services in `@sms/tenancy`.
 */
@Injectable()
export class AccessService implements AccessContract {
  constructor(
    @Inject(AbilityService) private readonly ability: AbilityService,
    @Inject(RoleService) private readonly roles: RoleService,
    @Inject(ImpersonationService) private readonly impersonation: ImpersonationService,
  ) {}

  compileAbility(userId: UserId, tenantId: TenantId, asOf?: DateOnly): Promise<AppAbility> {
    return this.ability.compileAbility(userId, tenantId, asOf);
  }

  listPermissions(): Promise<Permission[]> {
    return this.roles.listPermissions();
  }

  listRoles(): Promise<RoleWithGrants[]> {
    const ctx = currentTenantContext();
    return this.roles.listRoles(ctx.tenantId);
  }

  getRole(id: string): Promise<Result<RoleWithGrants, NotFoundError>> {
    const ctx = currentTenantContext();
    return this.roles.getRole(ctx.tenantId, id);
  }

  listRolePermissionMatrix(id: string): Promise<Result<RolePermissionMatrixEntry[], NotFoundError>> {
    const ctx = currentTenantContext();
    return this.roles.listPermissionMatrix(ctx.tenantId, id);
  }

  listEffectivePermissions(userId: UserId, tenantId: TenantId, asOf?: DateOnly): Promise<EffectivePermission[]> {
    return this.ability.listEffectivePermissions(userId, tenantId, asOf);
  }

  resolveScopeConstraints(userId: UserId, tenantId: TenantId, asOf?: DateOnly): Promise<Record<string, ScopeConstraint>> {
    return this.ability.resolveScopeConstraints(userId, tenantId, asOf);
  }

  assignRole(input: AssignRoleInput): Promise<Result<RoleAssignment, DomainError>> {
    const ctx = currentTenantContext();
    return this.roles.assignRole(ctx.tenantId, input);
  }

  revokeRole(input: RevokeRoleInput): Promise<Result<void, DomainError>> {
    const ctx = currentTenantContext();
    return this.roles.revokeRole(ctx.tenantId, input);
  }

  startImpersonation(input: StartImpersonationInput): Promise<Result<Impersonation, DomainError>> {
    const ctx = currentTenantContext();
    // actorUserId, not userId: an impersonation record belongs to the REAL
    // human. ctx.userId is the effective identity and is already the target
    // whenever a session is active.
    const actorUserId = requireUserId(ctx.actorUserId ?? ctx.userId);
    return this.impersonation.start(ctx.tenantId, actorUserId, input);
  }

  endImpersonation(): Promise<Result<boolean, DomainError>> {
    const ctx = currentTenantContext();
    // This is the bug that made impersonation a one-way door: using ctx.userId
    // here matched the TARGET against access.impersonation.actor_user_id, so
    // the UPDATE hit zero rows and the session could never be ended. The real
    // actor is the only one who can end their own session.
    const actorUserId = requireUserId(ctx.actorUserId ?? ctx.userId);
    return this.impersonation.end(ctx.tenantId, actorUserId);
  }

  getActiveImpersonation(actorUserId: UserId, tenantId: TenantId): Promise<Impersonation | null> {
    return this.impersonation.getActive(tenantId, actorUserId);
  }

  listEffectiveRoleKeys(userId: UserId, tenantId: TenantId, asOf?: DateOnly): Promise<string[]> {
    return this.roles.listEffectiveRoleKeys(tenantId, userId, asOf);
  }

  invalidateAbility(tenantId: TenantId, userId: UserId): void {
    this.ability.invalidate(tenantId, userId);
  }
}
