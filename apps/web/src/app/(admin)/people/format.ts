import { differenceInYears, format, parseISO } from 'date-fns';
import type { AlertCategory, AlertSeverity, Person, PersonRoleType, RelationshipType } from '../../../lib/api';

/** `givenName`/`familyName` are guaranteed non-empty by `createPersonSchema`; `preferredName` is optional. */
export function fullName(person: Pick<Person, 'givenName' | 'familyName'>): string {
  return `${person.givenName} ${person.familyName}`;
}

/** The name a directory row leads with: preferred name when set, otherwise the legal name. */
export function displayName(person: Pick<Person, 'givenName' | 'familyName' | 'preferredName'>): string {
  return person.preferredName?.trim() || fullName(person);
}

/** Two-letter avatar fallback, from the same name `displayName` would show. */
export function initials(person: Pick<Person, 'givenName' | 'familyName' | 'preferredName'>): string {
  const source = person.preferredName?.trim() || fullName(person);
  const parts = source.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

/** `dateOfBirth`/`validFrom`/`validTo` are `YYYY-MM-DD` `DateOnly` strings - `parseISO` (unlike `new Date(...)`) reads them as a local calendar date, not UTC midnight, so they never display a day early west of UTC. */
export function formatDateOnly(value: string): string {
  return format(parseISO(value), 'MMM d, yyyy');
}

export function formatTimestamp(value: string): string {
  return format(parseISO(value), 'MMM d, yyyy, h:mm a');
}

export function ageFromDateOfBirth(dateOfBirth: string): number {
  return differenceInYears(new Date(), parseISO(dateOfBirth));
}

/** `custom_fields.field_definition.key` -> a readable label, e.g. "grade_level" -> "Grade level". Good enough for the one seeded field (`grade_level`); a real custom-fields UI would read the definition's own `label` instead. */
export function humanizeFieldKey(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export const ROLE_LABELS: Record<PersonRoleType, string> = {
  student: 'Student',
  guardian: 'Guardian',
  staff: 'Staff',
  alumni: 'Alumni',
};

export function formatCustomFieldValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map((entry) => formatCustomFieldValue(entry)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export const RELATIONSHIP_TYPE_LABELS: Record<RelationshipType, string> = {
  parent: 'Parent',
  guardian: 'Guardian',
  sibling: 'Sibling',
  emergency_contact: 'Emergency contact',
  authorized_pickup: 'Authorized pickup',
  other: 'Other',
};

export const ALERT_CATEGORY_LABELS: Record<AlertCategory, string> = {
  medical: 'Medical',
  safeguarding: 'Safeguarding',
  access: 'Access',
  other: 'Other',
};

export const ALERT_SEVERITY_LABELS: Record<AlertSeverity, string> = {
  info: 'Info',
  warning: 'Warning',
  critical: 'Critical',
};
