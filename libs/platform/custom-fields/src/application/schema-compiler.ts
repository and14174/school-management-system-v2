import { z } from 'zod';
import type { CustomFieldDataType, FieldDefinition } from '../domain/types.js';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Builds the Zod schema for a single field definition's VALUE (not yet
 * wrapped in `.optional()` for a non-required field - `compileEntitySchema`
 * below does that once, uniformly, for every data type rather than each
 * branch repeating it).
 */
function compileFieldSchema(definition: FieldDefinition): z.ZodTypeAny {
  const dataType: CustomFieldDataType = definition.dataType;

  switch (dataType) {
    case 'text':
      return z.string();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'date':
      // A calendar date, not an instant - see @sms/kernel's DateOnly. Kept as
      // a plain regex-validated string here (this package does not depend on
      // @sms/kernel's DateOnly branding) rather than z.date(), which expects
      // a JS Date/instant.
      return z.string().regex(DATE_ONLY_PATTERN, `"${definition.key}" must be a YYYY-MM-DD date`);
    case 'select':
      // No options defined yet: every value is rejected (z.never()) rather
      // than accepted - a select field is only ever valid once it has an
      // allowed-value list to check against.
      return definition.options.length > 0 ? z.enum(definition.options as [string, ...string[]]) : z.never();
    case 'multiselect':
      return definition.options.length > 0 ? z.array(z.enum(definition.options as [string, ...string[]])) : z.never();
  }
}

/**
 * Compiles a tenant's current `custom_fields.field_definition` rows for one
 * `entityType` into a single Zod object schema - the runtime enforcement
 * half of "values are validated against their definitions" (the other half
 * being that the definitions themselves, not raw values, are what a report
 * or UI introspects). `.strict()`: a key present in the input but absent
 * from the tenant's own definitions is rejected rather than silently
 * accepted and stored - the same "unregistered field is invisible/rejected
 * by construction" discipline `@sms/access`'s field registry uses for reads,
 * applied here to writes.
 */
export function compileEntitySchema(definitions: readonly FieldDefinition[]): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const definition of definitions) {
    const fieldSchema = compileFieldSchema(definition);
    shape[definition.key] = definition.required ? fieldSchema : fieldSchema.optional().nullable();
  }

  return z.object(shape).strict();
}
