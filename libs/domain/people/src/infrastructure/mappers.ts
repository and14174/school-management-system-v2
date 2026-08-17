import type { CampusId, DateOnly, PersonId, TenantId, UserId } from '@sms/kernel';
import type {
  AlertCategory,
  AlertSeverity,
  ContactPoint,
  ContactPointKind,
  Household,
  HouseholdMember,
  Person,
  PersonAlert,
  PersonIdentifier,
  PersonIdentifierType,
  PersonMerge,
  PersonRole,
  PersonRoleType,
  Relationship,
  RelationshipType,
} from '../domain/types.js';
import type {
  contactPointTable,
  householdMemberTable,
  householdTable,
  personAlertTable,
  personIdentifierTable,
  personMergeTable,
  personRoleTable,
  personTable,
  relationshipTable,
} from './schema.js';

type PersonRow = typeof personTable.$inferSelect;
type PersonRoleRow = typeof personRoleTable.$inferSelect;
type HouseholdRow = typeof householdTable.$inferSelect;
type HouseholdMemberRow = typeof householdMemberTable.$inferSelect;
type RelationshipRow = typeof relationshipTable.$inferSelect;
type PersonIdentifierRow = typeof personIdentifierTable.$inferSelect;
type PersonAlertRow = typeof personAlertTable.$inferSelect;
type PersonMergeRow = typeof personMergeTable.$inferSelect;
type ContactPointRow = typeof contactPointTable.$inferSelect;

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function toPerson(row: PersonRow): Person {
  return {
    id: row.id as PersonId,
    tenantId: row.tenantId as TenantId,
    givenName: row.givenName,
    familyName: row.familyName,
    preferredName: row.preferredName,
    dateOfBirth: (row.dateOfBirth as DateOnly | null) ?? null,
    gender: row.gender,
    photoFileId: row.photoFileId,
    customFields: toRecord(row.customFields),
    mergedIntoId: (row.mergedIntoId as PersonId | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPersonRole(row: PersonRoleRow): PersonRole {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    personId: row.personId as PersonId,
    role: row.role as PersonRoleType,
    campusId: (row.campusId as CampusId | null) ?? null,
    validFrom: row.validFrom as DateOnly,
    validTo: (row.validTo as DateOnly | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toHousehold(row: HouseholdRow): Household {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    name: row.name,
    primaryAddress: toRecord(row.primaryAddress),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toHouseholdMember(row: HouseholdMemberRow): HouseholdMember {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    householdId: row.householdId,
    personId: row.personId as PersonId,
    isPrimaryContact: row.isPrimaryContact,
    validFrom: row.validFrom as DateOnly,
    validTo: (row.validTo as DateOnly | null) ?? null,
  };
}

export function toRelationship(row: RelationshipRow): Relationship {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    fromPersonId: row.fromPersonId as PersonId,
    toPersonId: row.toPersonId as PersonId,
    type: row.type as RelationshipType,
    hasCustody: row.hasCustody,
    mayPickup: row.mayPickup,
    mayReceiveComms: row.mayReceiveComms,
    priority: row.priority,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPersonIdentifier(row: PersonIdentifierRow): PersonIdentifier {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    personId: row.personId as PersonId,
    type: row.type as PersonIdentifierType,
    value: row.value,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPersonAlert(row: PersonAlertRow): PersonAlert {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    personId: row.personId as PersonId,
    category: row.category as AlertCategory,
    severity: row.severity as AlertSeverity,
    summary: row.summary,
    detail: row.detail,
    validFrom: row.validFrom as DateOnly,
    validTo: (row.validTo as DateOnly | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toContactPoint(row: ContactPointRow): ContactPoint {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    personId: row.personId as PersonId,
    kind: row.kind as ContactPointKind,
    value: row.value,
    label: row.label,
    isPrimary: row.isPrimary,
    verifiedAt: row.verifiedAt,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPersonMerge(row: PersonMergeRow): PersonMerge {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    survivingPersonId: row.survivingPersonId as PersonId,
    mergedPersonId: row.mergedPersonId as PersonId,
    mergedByUserId: row.mergedByUserId as UserId,
    reason: row.reason,
    mergedAt: row.mergedAt,
    payload: toRecord(row.payload),
  };
}
