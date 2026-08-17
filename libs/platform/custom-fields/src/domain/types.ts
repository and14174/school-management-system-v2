import type { TenantId } from '@sms/kernel';

/**
 * The five value shapes a tenant may define a custom field as. Mirrors the
 * `data_type` check constraint on `custom_fields.field_definition` (see the
 * `0450` migration) - kept as a literal union here (not re-derived from the
 * DB enum, which doesn't exist; this column is plain `text` with a CHECK, the
 * same convention `access.permission_scope` avoids for tables this module's
 * migration itself owns) so callers get compile-time exhaustiveness.
 */
export type CustomFieldDataType = 'text' | 'number' | 'date' | 'boolean' | 'select' | 'multiselect';

export const CUSTOM_FIELD_DATA_TYPES: readonly CustomFieldDataType[] = [
  'text',
  'number',
  'date',
  'boolean',
  'select',
  'multiselect',
];

/** Mirrors `custom_fields.field_definition`. One tenant-defined field on one entity type. */
export interface FieldDefinition {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly entityType: string;
  readonly key: string;
  readonly label: string;
  readonly dataType: CustomFieldDataType;
  /** Allowed values for `select`/`multiselect`; empty for every other data type. */
  readonly options: string[];
  readonly required: boolean;
  readonly reportable: boolean;
  readonly displayOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
