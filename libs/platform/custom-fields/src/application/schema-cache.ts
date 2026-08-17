import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { TenantId } from '@sms/kernel';

function cacheKey(tenantId: TenantId, entityType: string): string {
  return `${tenantId}:${entityType}`;
}

/**
 * Per-`(tenantId, entityType)` in-process cache of a compiled Zod schema, so
 * validating several `people.person` writes in a row does not re-query and
 * re-compile the field definitions each time. Same shape and reasoning as
 * `@sms/access`'s `AbilityCache`: explicit invalidation only, no TTL - a
 * stale entry here means a just-added `required` field is not enforced until
 * something remembers to clear it, which is the wrong default. Every write
 * path that changes `custom_fields.field_definition`
 * (`FieldDefinitionService.create/update/delete`) invalidates through this
 * class, so "forgetting" is structurally impossible rather than a discipline
 * everyone has to remember.
 */
@Injectable()
export class SchemaCache {
  private readonly entries = new Map<string, z.ZodTypeAny>();

  get(tenantId: TenantId, entityType: string): z.ZodTypeAny | undefined {
    return this.entries.get(cacheKey(tenantId, entityType));
  }

  set(tenantId: TenantId, entityType: string, schema: z.ZodTypeAny): void {
    this.entries.set(cacheKey(tenantId, entityType), schema);
  }

  invalidate(tenantId: TenantId, entityType: string): void {
    this.entries.delete(cacheKey(tenantId, entityType));
  }

  clear(): void {
    this.entries.clear();
  }
}
