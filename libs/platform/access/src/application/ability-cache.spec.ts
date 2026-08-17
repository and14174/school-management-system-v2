import { describe, expect, it } from 'vitest';
import type { TenantId, UserId } from '@sms/kernel';
import { AbilityCache } from './ability-cache.js';
import type { AppAbility } from './ability.types.js';

const TENANT_A = 'aaaaaaaa-0000-7000-8000-000000000001' as TenantId;
const TENANT_B = 'bbbbbbbb-0000-7000-8000-000000000002' as TenantId;
const USER_1 = '11111111-0000-7000-8000-000000000001' as UserId;
const USER_2 = '22222222-0000-7000-8000-000000000002' as UserId;

const ability = (name: string) => ({ name } as unknown as AppAbility);

describe('AbilityCache', () => {
  it('caches and invalidates per user', () => {
    const cache = new AbilityCache();
    cache.set(TENANT_A, USER_1, ability('a1'));
    cache.set(TENANT_A, USER_2, ability('a2'));

    cache.invalidate(TENANT_A, USER_1);

    expect(cache.get(TENANT_A, USER_1)).toBeUndefined();
    expect(cache.get(TENANT_A, USER_2)).toBeDefined();
  });

  /**
   * Changing a ROLE's permissions changes what every holder of that role can
   * do, but this cache is keyed per user, so there is no per-user key to clear.
   * Before `invalidateTenant` existed, granting or revoking a permission on a
   * role had no effect until the process restarted - an admin could revoke
   * access, be told it worked, and have the permission keep working.
   */
  it('invalidates every user in a tenant, and only that tenant', () => {
    const cache = new AbilityCache();
    cache.set(TENANT_A, USER_1, ability('a1'));
    cache.set(TENANT_A, USER_2, ability('a2'));
    cache.set(TENANT_B, USER_1, ability('b1'));

    cache.invalidateTenant(TENANT_A);

    expect(cache.get(TENANT_A, USER_1)).toBeUndefined();
    expect(cache.get(TENANT_A, USER_2)).toBeUndefined();
    // A role change in one school must not evict another school's cache.
    expect(cache.get(TENANT_B, USER_1)).toBeDefined();
  });

  it('tolerates invalidating a tenant with nothing cached', () => {
    const cache = new AbilityCache();
    expect(() => cache.invalidateTenant(TENANT_A)).not.toThrow();
  });
});
