import type { PersonId, TenantId, UserId } from '@sms/kernel';
import type { IdentityUser, Membership, MembershipStatus } from '../domain/types.js';
import type { membershipTable, userTable } from './schema.js';

type MembershipRow = typeof membershipTable.$inferSelect;
type UserRow = typeof userTable.$inferSelect;

export function toMembership(row: MembershipRow): Membership {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    userId: row.userId as UserId,
    personId: row.personId as PersonId | null,
    status: row.status as MembershipStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toIdentityUser(row: UserRow): IdentityUser {
  return {
    id: row.id as UserId,
    email: row.email,
    name: row.name,
    emailVerified: row.emailVerified,
    twoFactorEnabled: row.twoFactorEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
