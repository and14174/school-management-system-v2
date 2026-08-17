import type { PersonId, TenantId, UserId } from '@sms/kernel';

export type MembershipStatus = 'active' | 'invited' | 'suspended';

/** Mirrors `identity.membership`. Links a Better Auth `user` to a tenant it may act as. */
export interface Membership {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly userId: UserId;
  /** Null until M2 (people) links it - see the migration comment on `identity.membership`. */
  readonly personId: PersonId | null;
  readonly status: MembershipStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The subset of a Better Auth `user` row this module exposes across its contract. */
export interface IdentityUser {
  readonly id: UserId;
  readonly email: string;
  readonly name: string;
  readonly emailVerified: boolean;
  readonly twoFactorEnabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What `IdentityContract.getSession` resolves from a request's cookies - or `null` if there is none. */
export interface ResolvedSession {
  readonly sessionToken: string;
  readonly user: IdentityUser;
  readonly activeTenantId: TenantId | null;
}
