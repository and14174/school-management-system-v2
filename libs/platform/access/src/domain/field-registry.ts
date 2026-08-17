import { isKnownPermission } from './permissions.js';

/**
 * Sensitive fields are their own permissions, not a mask/deny list on a
 * table - see the `0400` migration header. This registry is the other half
 * of that design: it maps a resource's field name to the permission required
 * to see it. `FieldMaskingInterceptor` (src/api/field-masking.interceptor.ts)
 * strips any field present in a response whose required permission the
 * caller's compiled ability does not grant. A field simply absent from this
 * registry is never masked - which is exactly why every sensitive field MUST
 * be registered here the moment it's added to a DTO, not left to a reviewer
 * to remember.
 *
 * `people.person` entries are the real ones, replacing the placeholders that
 * used to live here ahead of the M2 `@sms/people` module (M2 has now
 * landed). `@sms/people`'s schema keeps medical/safeguarding information as
 * `people.person_alert` ROWS distinguished by a `category` column, not as
 * fixed columns on the person itself - field masking (uniform per field
 * name, blind to row content) cannot conditionally hide "this alert" vs
 * "that alert" by category, so the real enforcement for alert CONTENT is
 * row-level filtering in `@sms/people`'s `AlertService` (see its own
 * comment). What field masking DOES gate here are two derived boolean flags
 * `PeopleController`'s `GET /people/:id` response carries
 * (`hasMedicalAlerts`/`hasSafeguardingAlerts`) - even the FACT that a person
 * has a medical or safeguarding alert at all is sensitive, independent of
 * its content. Extend this list (never remove an entry a UI might still
 * render against) as further sensitive columns are added.
 */
export interface FieldRegistryEntry {
  readonly resource: string;
  readonly field: string;
  readonly requiredPermission: string;
}

export const FIELD_REGISTRY: readonly FieldRegistryEntry[] = [
  { resource: 'people.person', field: 'hasMedicalAlerts', requiredPermission: 'people.student:read_medical' },
  { resource: 'people.person', field: 'hasSafeguardingAlerts', requiredPermission: 'people.student:read_safeguarding' },
];

/** Every `FIELD_REGISTRY` entry naming a permission that does not exist in the catalogue - should always be empty; asserted by a test. */
export function unknownPermissionsInFieldRegistry(): FieldRegistryEntry[] {
  return FIELD_REGISTRY.filter((entry) => !isKnownPermission(entry.requiredPermission));
}

export function fieldRegistryFor(resource: string): FieldRegistryEntry[] {
  return FIELD_REGISTRY.filter((entry) => entry.resource === resource);
}
