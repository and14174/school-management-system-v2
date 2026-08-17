import { Injectable } from '@nestjs/common';
import type { TenantId, UserId } from '@sms/kernel';
import type { AppAbility } from './ability.types.js';

function cacheKey(tenantId: TenantId, userId: UserId): string {
  return `${tenantId}:${userId}`;
}

/**
 * Per-`(tenantId, userId)` in-process cache of a compiled ability, so a
 * request that checks several permissions (a guard, then a field-masking
 * pass) does not re-run the role/permission queries for each one.
 *
 * Explicit invalidation only (`invalidate`), called by `RoleService`'s
 * `assignRole`/`revokeRole` - no TTL, because a stale entry here means a
 * revoked permission stays usable until something remembers to clear it,
 * which is the wrong default for an authorization cache. `AbilityService`
 * only ever reads/writes through this class, so "every write path that
 * changes who-can-do-what also calls `invalidate`" is enforced by there
 * being exactly one place that could forget to.
 *
 * Deliberately does not cache across `asOf` values - only "as of today"
 * (`compileAbility`'s default) is cached; a caller-supplied `asOf` always
 * recompiles, since that is inherently a point-in-time query, not the
 * ambient "right now" this cache exists to speed up.
 */
@Injectable()
export class AbilityCache {
  private readonly entries = new Map<string, AppAbility>();

  get(tenantId: TenantId, userId: UserId): AppAbility | undefined {
    return this.entries.get(cacheKey(tenantId, userId));
  }

  set(tenantId: TenantId, userId: UserId, ability: AppAbility): void {
    this.entries.set(cacheKey(tenantId, userId), ability);
  }

  invalidate(tenantId: TenantId, userId: UserId): void {
    this.entries.delete(cacheKey(tenantId, userId));
  }

  /**
   * Drops every cached ability for a tenant.
   *
   * Changing a ROLE's permissions changes what every holder of that role can
   * do, and this cache is keyed per user - so there is no per-user key to
   * invalidate. Without this, granting or revoking a permission on a role has
   * no effect until the process restarts: an admin revokes access, the UI says
   * it worked, and the permission keeps working. Coarse is correct here, since
   * role definitions change rarely and always by deliberate admin action,
   * whereas an authorization cache that serves revoked permissions is never
   * acceptable.
   */
  invalidateTenant(tenantId: TenantId): void {
    const prefix = `${tenantId}:`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
