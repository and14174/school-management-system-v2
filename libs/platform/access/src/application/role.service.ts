import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';
import {
  ConflictError,
  NotFoundError,
  newId,
  todayDateOnly,
  type DateOnly,
  type DomainError,
  type Result,
  type TenantId,
  type UserId,
  err,
  ok,
} from '@sms/kernel';
import { withSystemTx, withTenantTx } from '@sms/db';
import type { AssignRoleInput, RevokeRoleInput } from '../contract.js';
import type { Permission, Role, RoleAssignment, RolePermissionMatrixEntry, RoleWithGrants } from '../domain/types.js';
import { getAccessDb } from '../infrastructure/db.js';
import { toPermission, toPermissionScope, toRole, toRoleAssignment } from '../infrastructure/mappers.js';
import { permissionTable, roleAssignmentTable, rolePermissionTable, roleTable } from '../infrastructure/schema.js';
import { AbilityService } from './ability.service.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

@Injectable()
export class RoleService {
  constructor(@Inject(AbilityService) private readonly ability: AbilityService) {}

  /** `access.permission` is `@global` - read over the plain pooled connection, see `infrastructure/db.ts`. */
  async listPermissions(): Promise<Permission[]> {
    const rows = await getAccessDb().select().from(permissionTable).orderBy(permissionTable.resource, permissionTable.action);
    return rows.map(toPermission);
  }

  async findPermissionByKey(key: string): Promise<Permission | null> {
    const rows = await getAccessDb().select().from(permissionTable).where(eq(permissionTable.key, key)).limit(1);
    const row = rows[0];
    return row ? toPermission(row) : null;
  }

  async listRoles(tenantId: TenantId): Promise<RoleWithGrants[]> {
    const ctx = scopedContext(tenantId);
    const roles = await withTenantTx(ctx, (db) => db.select().from(roleTable).where(eq(roleTable.tenantId, tenantId)));
    if (roles.length === 0) {
      return [];
    }

    const grantRows = await withTenantTx(ctx, (db) =>
      db
        .select({ roleId: rolePermissionTable.roleId, scope: rolePermissionTable.scope, permission: permissionTable })
        .from(rolePermissionTable)
        .innerJoin(permissionTable, eq(rolePermissionTable.permissionId, permissionTable.id))
        .where(eq(rolePermissionTable.tenantId, tenantId)),
    );

    return roles.map((role) => ({
      ...toRole(role),
      grants: grantRows
        .filter((row) => row.roleId === role.id)
        .map((row) => ({ permission: toPermission(row.permission), scope: toPermissionScope(row.scope) })),
    }));
  }

  async getRole(tenantId: TenantId, id: string): Promise<Result<RoleWithGrants, NotFoundError>> {
    const roles = await this.listRoles(tenantId);
    const role = roles.find((candidate) => candidate.id === id);
    return role ? ok(role) : err(new NotFoundError(`Role ${id} not found.`));
  }

  /**
   * The full permission catalogue joined to `id`'s grants - every catalogue
   * entry, `scope: null` for the ones this role does not hold (see
   * `RolePermissionMatrixEntry`'s own comment for why null-not-omit was
   * chosen). `getRole` (tenant-scoped via `listRoles`/RLS) is what makes a
   * role id belonging to a different tenant indistinguishable from a
   * nonexistent one - a `NotFoundError`, not a data leak that happens to be
   * empty.
   */
  async listPermissionMatrix(tenantId: TenantId, roleId: string): Promise<Result<RolePermissionMatrixEntry[], NotFoundError>> {
    const roleResult = await this.getRole(tenantId, roleId);
    if (!roleResult.ok) {
      return roleResult;
    }
    const role = roleResult.value;
    const scopeByPermissionId = new Map(role.grants.map((grant) => [grant.permission.id, grant.scope]));

    const catalogue = await this.listPermissions();
    return ok(
      catalogue.map((permission) => ({
        key: permission.key,
        resource: permission.resource,
        action: permission.action,
        description: permission.description,
        scope: scopeByPermissionId.get(permission.id) ?? null,
      })),
    );
  }

  /**
   * The `key` of every role `userId` currently holds in `tenantId` (as of
   * `asOf`, default today), deduplicated. What `apps/api`'s
   * `TenantContextInterceptor` populates `TenantContext.roles` with -
   * previously hardcoded to `[]` (M1a).
   */
  async listEffectiveRoleKeys(tenantId: TenantId, userId: UserId, asOf?: DateOnly): Promise<string[]> {
    const resolveDate = asOf ?? todayDateOnly();
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select({ key: roleTable.key })
        .from(roleAssignmentTable)
        .innerJoin(roleTable, eq(roleAssignmentTable.roleId, roleTable.id))
        .where(
          and(
            eq(roleAssignmentTable.tenantId, tenantId),
            eq(roleAssignmentTable.userId, userId),
            lte(roleAssignmentTable.validFrom, resolveDate),
            or(isNull(roleAssignmentTable.validTo), gte(roleAssignmentTable.validTo, resolveDate)),
          ),
        ),
    );
    return [...new Set(rows.map((row) => row.key))];
  }

  async getRoleByKey(tenantId: TenantId, key: string): Promise<Role | null> {
    const rows = await withSystemTx((db) =>
      db
        .select()
        .from(roleTable)
        .where(and(eq(roleTable.tenantId, tenantId), eq(roleTable.key, key)))
        .limit(1),
    );
    const row = rows[0];
    return row ? toRole(row) : null;
  }

  /**
   * Seeding a system role has no ambient actor to trust (`seed.ts` runs as
   * a CLI script, not a request), so - like `TenantService.create` and
   * `MembershipService.create` - this goes through `withSystemTx` rather
   * than fabricating one around a tenant nothing has agreed to yet. Only
   * called from `seed.ts`; request-path role assignment is `assignRole`
   * below, which uses the ambient tenant context.
   */
  async createRole(input: {
    tenantId: TenantId;
    key: string;
    name: string;
    description?: string;
    isSystem?: boolean;
  }): Promise<Result<Role, Error>> {
    const id = newId();
    try {
      const rows = await withSystemTx((db) =>
        db
          .insert(roleTable)
          .values({
            id,
            tenantId: input.tenantId,
            key: input.key,
            name: input.name,
            description: input.description ?? null,
            isSystem: input.isSystem ?? false,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new Error('Insert returned no row.'));
      }
      return ok(toRole(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create role "${input.key}".`));
    }
  }

  /** Same `withSystemTx` reasoning as `createRole` - only called from `seed.ts`. */
  async grantPermission(input: { tenantId: TenantId; roleId: string; permissionId: string; scope: string }): Promise<Result<void, Error>> {
    try {
      await withSystemTx((db) =>
        db
          .insert(rolePermissionTable)
          .values({ id: newId(), roleId: input.roleId, permissionId: input.permissionId, scope: input.scope, tenantId: input.tenantId })
          .onConflictDoUpdate({
            target: [rolePermissionTable.roleId, rolePermissionTable.permissionId],
            set: { scope: input.scope },
          }),
      );
      // Tenant-wide, not per-user: this changes what EVERY holder of the role
      // can do, and the cache is keyed per user, so there is no single key to
      // clear. Without this the grant has no effect until the process restarts.
      this.ability.invalidateTenant(input.tenantId);
      return ok(undefined);
    } catch (error) {
      return err(toDomainError(error, 'Could not grant permission.'));
    }
  }

  /**
   * Runs as the ambient tenant/actor - a normal tenant-scoped write, exactly
   * like `CampusService.create`. Defaults `validFrom` to today and leaves
   * `validTo` open-ended unless the caller says otherwise. Invalidates the
   * target user's cached ability so the change is visible on their very next
   * request, not after some cache TTL.
   */
  async assignRole(tenantId: TenantId, input: AssignRoleInput): Promise<Result<RoleAssignment, DomainError>> {
    const ctx = scopedContext(tenantId);
    const id = newId();
    const validFrom = input.validFrom ?? todayDateOnly();

    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(roleAssignmentTable)
          .values({
            id,
            tenantId,
            roleId: input.roleId,
            userId: input.userId,
            campusId: input.campusId ?? null,
            validFrom,
            validTo: input.validTo ?? null,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new ConflictError('Insert returned no row.'));
      }
      this.ability.invalidate(tenantId, input.userId);
      return ok(toRoleAssignment(row));
    } catch (error) {
      return err(toDomainError(error, 'Could not assign role.') as DomainError);
    }
  }

  /**
   * Ends the currently-effective assignment matching (role, user, campus) as
   * of `asOf` (default: today) by setting `valid_to`, rather than deleting
   * the row - the assignment's past effect must remain a fact of record
   * (see `@sms/kernel`'s `Interval`/effective-dating convention), not
   * disappear.
   */
  async revokeRole(tenantId: TenantId, input: RevokeRoleInput): Promise<Result<void, DomainError>> {
    const ctx = scopedContext(tenantId);
    const asOf = input.asOf ?? todayDateOnly();

    const conditions = [
      eq(roleAssignmentTable.tenantId, tenantId),
      eq(roleAssignmentTable.roleId, input.roleId),
      eq(roleAssignmentTable.userId, input.userId),
    ];
    if (input.campusId !== undefined) {
      conditions.push(eq(roleAssignmentTable.campusId, input.campusId));
    }

    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(roleAssignmentTable)
          .set({ validTo: asOf })
          .where(and(...conditions))
          .returning(),
      );
      if (rows.length === 0) {
        return err(new NotFoundError(`No matching role assignment for role ${input.roleId}, user ${input.userId}.`));
      }
      this.ability.invalidate(tenantId, input.userId);
      return ok(undefined);
    } catch (error) {
      return err(toDomainError(error, 'Could not revoke role.') as DomainError);
    }
  }
}
