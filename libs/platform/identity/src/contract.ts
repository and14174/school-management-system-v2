import type { DomainError, NotFoundError, Result, TenantId, UserId } from '@sms/kernel';
import type { IdentityUser, Membership, ResolvedSession } from './domain/types.js';

export * from './domain/types.js';

export interface CreateUserWithMembershipInput {
  readonly email: string;
  readonly name: string;
  readonly password: string;
  readonly tenantId: TenantId;
}

export interface CreateUserWithMembershipResult {
  readonly user: IdentityUser;
  readonly membership: Membership;
}

/**
 * The public port this module exposes to the rest of the system (`apps/api`'s
 * `AuthGuard` and `TenantContextInterceptor`, `AuthController`) - matching
 * `@sms/tenancy`'s `TenancyContract` pattern: every other module should
 * depend on this interface, not on the concrete `IdentityService` behind it.
 */
export interface IdentityContract {
  /**
   * Resolves the caller's session from request headers (the Better Auth
   * session cookie), or `null` if there is none / it is invalid or expired.
   * Takes a standard `Headers` object (not a Fastify request) so this port
   * has no dependency on any particular HTTP framework.
   */
  getSession(headers: Headers): Promise<ResolvedSession | null>;

  /** Every tenant `userId` belongs to, active or not - feeds the frontend's tenant switcher. */
  listMemberships(userId: UserId): Promise<Membership[]>;

  /**
   * Switches the session's active tenant. Rejects (`ForbiddenError`) a
   * tenant the user has no *active* membership in - a suspended or
   * nonexistent membership cannot be switched to, exactly like a stale
   * `activeTenantId` cannot resolve a request's `TenantContext` (see
   * `AuthGuard`).
   */
  setActiveTenant(sessionToken: string, tenantId: TenantId): Promise<Result<void, DomainError>>;

  /**
   * Creates a Better Auth user (email + password) and an `active`
   * `identity.membership` for it in one step. Used by seeding and future
   * invite-acceptance flows - the public sign-up endpoint Better Auth itself
   * exposes creates a user only, with no tenant attached (correctly: a
   * self-service sign-up has not been invited to any school yet).
   */
  createUserWithMembership(input: CreateUserWithMembershipInput): Promise<Result<CreateUserWithMembershipResult, DomainError>>;

  getUser(id: UserId): Promise<Result<IdentityUser, NotFoundError>>;
}

/**
 * DI token for `IdentityContract` - see `TENANCY_CONTRACT` in `@sms/tenancy`
 * for why a concrete Symbol token is used instead of relying on
 * implicit type-based DI.
 */
export const IDENTITY_CONTRACT = Symbol('IDENTITY_CONTRACT');
