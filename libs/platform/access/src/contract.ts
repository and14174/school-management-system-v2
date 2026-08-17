import type { CampusId, DateOnly, DomainError, NotFoundError, Result, TenantId, UserId } from '@sms/kernel';
import type { AppAbility } from './application/ability.types.js';
import type {
  EffectivePermission,
  Impersonation,
  Permission,
  RoleAssignment,
  RolePermissionMatrixEntry,
  RoleWithGrants,
  ScopeConstraint,
} from './domain/types.js';

export * from './domain/types.js';
export type { AppAbility } from './application/ability.types.js';
// The inversion port `@sms/academic` implements and `apps/api` binds - see
// that file's own comment for the full reasoning.
export {
  SECTION_SCOPE_RESOLVER,
  DEFAULT_SECTION_SCOPE_RESOLVER,
  type SectionScopeResolver,
} from './application/section-scope-resolver.js';
// The inversion port `apps/api` implements directly (no domain module owns
// "a guardian's own children") and binds - see that file's own comment for
// the full reasoning.
export {
  DEPENDANT_SCOPE_RESOLVER,
  DEFAULT_DEPENDANT_SCOPE_RESOLVER,
  type DependantScopeResolver,
} from './application/dependant-scope-resolver.js';

export interface AssignRoleInput {
  readonly userId: UserId;
  readonly roleId: string;
  readonly campusId?: CampusId;
  /** Defaults to today. */
  readonly validFrom?: DateOnly;
  /** Defaults to open-ended (`null`). */
  readonly validTo?: DateOnly | null;
}

export interface RevokeRoleInput {
  readonly userId: UserId;
  readonly roleId: string;
  /** Narrows which assignment to revoke when the same role was assigned at more than one campus. */
  readonly campusId?: CampusId;
  /** The assignment's `validTo` is set to this date (default: today) rather than the row being deleted - see `RoleService.revoke`. */
  readonly asOf?: DateOnly;
}

export interface StartImpersonationInput {
  readonly targetUserId: UserId;
  readonly reason: string;
}

/**
 * The public port this module exposes to the rest of the system
 * (`apps/api`'s `PermissionGuard`, `FieldMaskingInterceptor`,
 * `TenantContextInterceptor`, and this module's own REST controllers) -
 * matching `@sms/tenancy`'s `TenancyContract` / `@sms/identity`'s
 * `IdentityContract` pattern: every other module should depend on this
 * interface, not on the concrete `AccessService` behind it.
 */
export interface AccessContract {
  /**
   * Compiles a CASL ability for `userId` in `tenantId`, resolved as of
   * `asOf` (default: today). Role assignments outside their effective
   * window (not yet started, or ended) contribute nothing; a `section`- or
   * `grade_level`-scoped grant contributes nothing today, deliberately (see
   * the `0400` migration header and `application/ability.service.ts`) -
   * both are logged, neither is silently treated as unrestricted.
   */
  compileAbility(userId: UserId, tenantId: TenantId, asOf?: DateOnly): Promise<AppAbility>;

  /** Every system permission that key/action names, for a permission picker UI and this module's own tests. */
  listPermissions(): Promise<Permission[]>;

  /** Every role in the ambient tenant, with the permissions/scopes it grants. */
  listRoles(): Promise<RoleWithGrants[]>;

  /** The full permission catalogue joined to one role's grants (`scope: null` for permissions it does not hold) - what `GET /access/roles/:id/permissions` reports. `NotFoundError` for a role id that does not exist, or belongs to a different tenant (RLS makes the two indistinguishable). */
  listRolePermissionMatrix(id: string): Promise<Result<RolePermissionMatrixEntry[], NotFoundError>>;

  /** The caller's own effective permissions (ambient tenant/user, `compileAbility` resolved to a flat list) - what `GET /access/me` reports. */
  listEffectivePermissions(userId: UserId, tenantId: TenantId, asOf?: DateOnly): Promise<EffectivePermission[]>;

  /**
   * The data-filtering counterpart to `compileAbility`: per permission key
   * (`resource:action`) the caller currently holds, the concrete constraint
   * a domain module's list endpoint must translate into a SQL `WHERE`
   * clause - see `ScopeConstraint`'s own doc comment for why this is a
   * separate layer from the CASL decision `compileAbility` makes.
   */
  resolveScopeConstraints(userId: UserId, tenantId: TenantId, asOf?: DateOnly): Promise<Record<string, ScopeConstraint>>;

  assignRole(input: AssignRoleInput): Promise<Result<RoleAssignment, DomainError>>;
  revokeRole(input: RevokeRoleInput): Promise<Result<void, DomainError>>;

  /**
   * Starts an impersonation session: the ambient caller (`currentTenantContext().userId`)
   * becomes `actorUserId`, acting as `input.targetUserId`. Requires the
   * caller to hold `access.impersonation:create` themselves - checked by
   * `PermissionGuard` on the REST endpoint, not re-checked here, exactly
   * like every other write in this codebase trusts its controller's guard.
   */
  startImpersonation(input: StartImpersonationInput): Promise<Result<Impersonation, DomainError>>;

  /** Ends the ambient caller's own active impersonation session, if any. A no-op `ok(undefined)` if there isn't one. */
  endImpersonation(): Promise<Result<boolean, DomainError>>;

  /** The caller's currently active impersonation session (`ended_at is null`), or `null`. Used by `TenantContextInterceptor` to resolve the request's effective user. */
  getActiveImpersonation(actorUserId: UserId, tenantId: TenantId): Promise<Impersonation | null>;

  /** The role `key`s `userId` currently holds in `tenantId`. Used by `TenantContextInterceptor` to populate `TenantContext.roles`. */
  listEffectiveRoleKeys(userId: UserId, tenantId: TenantId, asOf?: DateOnly): Promise<string[]>;

  getRole(id: string): Promise<Result<RoleWithGrants, NotFoundError>>;

  /** Invalidates the cached compiled ability for `(tenantId, userId)` - called by `assignRole`/`revokeRole` so a change takes effect on the very next request, not after the cache TTL. */
  invalidateAbility(tenantId: TenantId, userId: UserId): void;
}

/**
 * DI token for `AccessContract` - see `TENANCY_CONTRACT` in `@sms/tenancy`
 * for why a concrete Symbol token is used instead of relying on implicit
 * type-based DI.
 */
export const ACCESS_CONTRACT = Symbol('ACCESS_CONTRACT');
