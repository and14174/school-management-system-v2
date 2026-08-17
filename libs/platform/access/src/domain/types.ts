import type { CampusId, DateOnly, PersonId, TenantId, UserId } from '@sms/kernel';

/**
 * How far a grant reaches. `own`, `campus`, `tenant` and (since the
 * `@sms/academic` module landed and implements `SECTION_SCOPE_RESOLVER`,
 * see `application/section-scope-resolver.ts`) `section` are resolvable;
 * so is `dependants` (since `apps/api` implements `DEPENDANT_SCOPE_RESOLVER`,
 * see `application/dependant-scope-resolver.ts`) - a guardian's own
 * children, as opposed to `own`, which resolves to exactly the acting
 * person and cannot express "my child's record". `grade_level` is declared
 * for the future enrollment module and deliberately has no resolver yet -
 * see `application/ability.service.ts`, which refuses to emit a CASL rule
 * for it rather than letting it silently mean "everything".
 */
export type PermissionScope = 'own' | 'section' | 'dependants' | 'grade_level' | 'campus' | 'tenant';

export const PERMISSION_SCOPES: readonly PermissionScope[] = ['own', 'section', 'dependants', 'grade_level', 'campus', 'tenant'];

/**
 * Scopes that cannot be resolved into a real condition because the module
 * that would define "which grade level" (a future enrollment module) does
 * not exist yet. `section` USED to be in this set too, before `@sms/academic`
 * implemented `SECTION_SCOPE_RESOLVER` - it is a resolvable scope TYPE now,
 * even for a user whose own resolved section list happens to be empty (that
 * is a data fact handled by the resolver returning `[]`, not a reason to
 * treat the scope itself as unresolvable - same as `campus` staying
 * "resolvable" even when a grant's own `campusId` is unset). Kept as a named
 * constant (rather than an inline check) so every place that needs to reason
 * about this - ability compilation, its tests - reads from one list.
 */
export const UNRESOLVABLE_SCOPES: ReadonlySet<PermissionScope> = new Set(['grade_level']);

/**
 * The data-filtering counterpart to a compiled `AppAbility`: CASL answers
 * "may this user read students AT ALL" (a decision, made once, cheaply);
 * this answers "which rows" - what a domain module's list endpoint
 * translates into a SQL `WHERE` clause, since a list endpoint cannot be
 * secured by checking a boolean per row it never fetched. Returned per
 * permission `key` (`resource:action`) by `AccessContract.resolveScopeConstraints`.
 */
export type ScopeConstraint =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'campus'; readonly campusIds: readonly CampusId[] }
  | { readonly kind: 'section'; readonly sectionIds: readonly string[] }
  | { readonly kind: 'dependants'; readonly personIds: readonly PersonId[] }
  | { readonly kind: 'own'; readonly personId: PersonId | null }
  | { readonly kind: 'none' };

/** Mirrors `access.permission`. The catalogue itself lives in code - see `domain/permissions.ts`. */
export interface Permission {
  readonly id: string;
  readonly key: string;
  readonly resource: string;
  readonly action: string;
  readonly description: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `access.role`. */
export interface Role {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `access.role_permission` - one grant, joined with the permission it grants for convenience. */
export interface RolePermission {
  readonly id: string;
  readonly roleId: string;
  readonly permissionId: string;
  readonly tenantId: TenantId;
  readonly scope: PermissionScope;
  readonly permission: Permission;
}

/** Mirrors `access.role_assignment`. `validFrom`/`validTo` are both inclusive, matching `@sms/kernel`'s `Interval`. */
export interface RoleAssignment {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly roleId: string;
  readonly userId: UserId;
  readonly campusId: CampusId | null;
  readonly validFrom: DateOnly;
  readonly validTo: DateOnly | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `access.impersonation`. `endedAt: null` means the session is currently active. */
export interface Impersonation {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly actorUserId: UserId;
  readonly targetUserId: UserId;
  readonly reason: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

/** A role together with the permissions it grants - what `GET /access/roles` and the seed script both work with. */
export interface RoleWithGrants extends Role {
  readonly grants: ReadonlyArray<{ readonly permission: Permission; readonly scope: PermissionScope }>;
}

/** What `GET /access/me` reports: the caller's effective permissions, for the web UI to gate navigation. */
export interface EffectivePermission {
  readonly key: string;
  readonly resource: string;
  readonly action: string;
  readonly scope: PermissionScope;
}

/**
 * What `GET /access/roles/:id/permissions` reports: the FULL permission
 * catalogue, joined to one role's grants - a permission matrix row per
 * catalogue entry, not just the ones the role holds. `scope: null` means the
 * role does not grant that permission at all (chosen over omitting the row
 * entirely so a permission-matrix UI can render every catalogue permission,
 * granted or not, without cross-referencing a second list - see the
 * `GET /access/roles/:id/permissions` controller comment).
 */
export interface RolePermissionMatrixEntry {
  readonly key: string;
  readonly resource: string;
  readonly action: string;
  readonly description: string;
  readonly scope: PermissionScope | null;
}
