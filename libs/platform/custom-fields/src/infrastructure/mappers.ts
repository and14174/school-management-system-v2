import type { TenantId } from '@sms/kernel';
import type { CustomFieldDataType, FieldDefinition } from '../domain/types.js';
import type { fieldDefinitionTable } from './schema.js';

type FieldDefinitionRow = typeof fieldDefinitionTable.$inferSelect;

export function toFieldDefinition(row: FieldDefinitionRow): FieldDefinition {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    entityType: row.entityType,
    key: row.key,
    label: row.label,
    dataType: row.dataType as CustomFieldDataType,
    options: Array.isArray(row.options) ? (row.options as string[]) : [],
    required: row.required,
    reportable: row.reportable,
    displayOrder: row.displayOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
