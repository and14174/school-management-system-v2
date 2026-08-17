import type { z } from 'zod';
import type { DomainError, NotFoundError, Result, TenantId, ValidationError } from '@sms/kernel';
import type { CustomFieldDataType, FieldDefinition } from './domain/types.js';

export * from './domain/types.js';

export interface CreateFieldDefinitionInput {
  readonly entityType: string;
  readonly key: string;
  readonly label: string;
  readonly dataType: CustomFieldDataType;
  readonly options?: string[];
  readonly required?: boolean;
  readonly reportable?: boolean;
  readonly displayOrder?: number;
}

export interface UpdateFieldDefinitionInput {
  readonly label?: string;
  readonly options?: string[];
  readonly required?: boolean;
  readonly reportable?: boolean;
  readonly displayOrder?: number;
}

/**
 * The public port this module exposes to the rest of the system - in
 * particular `@sms/people`, which validates a person's `custom_fields`
 * against it on create/update. Every method takes `tenantId` explicitly
 * (rather than reading it off ambient request context, the way
 * `@sms/access`'s `AccessContract.listRoles` does) so this works identically
 * from a real request, a seed script, or a test - exactly like
 * `AccessContract.compileAbility` takes its tenant/user explicitly for the
 * same reason.
 */
export interface CustomFieldsContract {
  /** Every field definition for `entityType` in `tenantId`, ordered by `displayOrder`. */
  listDefinitions(tenantId: TenantId, entityType: string): Promise<FieldDefinition[]>;

  getDefinition(tenantId: TenantId, id: string): Promise<Result<FieldDefinition, NotFoundError>>;

  createDefinition(tenantId: TenantId, input: CreateFieldDefinitionInput): Promise<Result<FieldDefinition, DomainError>>;

  updateDefinition(
    tenantId: TenantId,
    id: string,
    input: UpdateFieldDefinitionInput,
  ): Promise<Result<FieldDefinition, DomainError>>;

  deleteDefinition(tenantId: TenantId, id: string): Promise<Result<void, DomainError>>;

  /**
   * Compiles (and caches, per `(tenantId, entityType)` - see `SchemaCache`)
   * a Zod object schema from `entityType`'s current field definitions. The
   * schema is `.strict()`: a key with no matching definition is rejected,
   * not silently accepted.
   */
  compileSchema(tenantId: TenantId, entityType: string): Promise<z.ZodTypeAny>;

  /**
   * Parses `values` against `compileSchema`'s result. Returns the parsed
   * (and therefore validated) record on success, or a `ValidationError`
   * carrying Zod's own issue list as `details` on failure.
   */
  validate(
    tenantId: TenantId,
    entityType: string,
    values: unknown,
  ): Promise<Result<Record<string, unknown>, ValidationError>>;
}

/**
 * DI token for `CustomFieldsContract` - see `TENANCY_CONTRACT` in
 * `@sms/tenancy` for why a concrete Symbol token is used instead of relying
 * on implicit type-based DI.
 */
export const CUSTOM_FIELDS_CONTRACT = Symbol('CUSTOM_FIELDS_CONTRACT');
