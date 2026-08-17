import type { CampusId, DateOnly, TenantId, UserId } from '@sms/kernel';
import type { Impersonation, Permission, PermissionScope, Role, RoleAssignment } from '../domain/types.js';
import type { impersonationTable, permissionTable, roleAssignmentTable, roleTable } from './schema.js';

type PermissionRow = typeof permissionTable.$inferSelect;
type RoleRow = typeof roleTable.$inferSelect;
type RoleAssignmentRow = typeof roleAssignmentTable.$inferSelect;
type ImpersonationRow = typeof impersonationTable.$inferSelect;

export function toPermission(row: PermissionRow): Permission {
  return {
    id: row.id,
    key: row.key,
    resource: row.resource,
    action: row.action,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toRole(row: RoleRow): Role {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    key: row.key,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toRoleAssignment(row: RoleAssignmentRow): RoleAssignment {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    roleId: row.roleId,
    userId: row.userId as UserId,
    campusId: (row.campusId as CampusId | null) ?? null,
    validFrom: row.validFrom as DateOnly,
    validTo: (row.validTo as DateOnly | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toImpersonation(row: ImpersonationRow): Impersonation {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    actorUserId: row.actorUserId as UserId,
    targetUserId: row.targetUserId as UserId,
    reason: row.reason,
    startedAt: row.startedAt,
    endedAt: row.endedAt ?? null,
  };
}

export function toPermissionScope(value: string): PermissionScope {
  return value as PermissionScope;
}
