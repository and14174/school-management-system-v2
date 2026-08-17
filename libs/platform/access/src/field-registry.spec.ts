import { describe, expect, it } from 'vitest';
import { FIELD_REGISTRY, unknownPermissionsInFieldRegistry } from './domain/field-registry.js';
import { PERMISSION_CATALOGUE, isKnownPermission } from './domain/permissions.js';

/**
 * Pure unit tests, no database: proves the field registry (sensitive fields
 * as their own permissions, not a deny-list - see the `0400` migration
 * header) and the permission catalogue stay internally consistent. The
 * catalogue-vs-database drift check lives in `access.spec.ts` (it needs a
 * real Postgres); this file is everything that doesn't.
 */
describe('field registry', () => {
  it('is non-empty (otherwise the masking interceptor has nothing to enforce)', () => {
    expect(FIELD_REGISTRY.length).toBeGreaterThan(0);
  });

  it('every entry names a permission that exists in the catalogue', () => {
    expect(unknownPermissionsInFieldRegistry()).toEqual([]);
  });

  it('has no duplicate (resource, field) pairs', () => {
    const seen = new Set<string>();
    for (const entry of FIELD_REGISTRY) {
      const key = `${entry.resource}.${entry.field}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe('permission catalogue', () => {
  it('has unique keys', () => {
    const keys = PERMISSION_CATALOGUE.map((permission) => permission.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('derives every key as "resource:action"', () => {
    for (const permission of PERMISSION_CATALOGUE) {
      expect(permission.key).toBe(`${permission.resource}:${permission.action}`);
    }
  });

  it('isKnownPermission agrees with the catalogue', () => {
    expect(isKnownPermission('people.student:read_medical')).toBe(true);
    expect(isKnownPermission('not.a.real:permission')).toBe(false);
  });
});
