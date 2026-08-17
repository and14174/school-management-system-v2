import type { CampusId, DateOnly, PersonId, TenantId, UserId } from '@sms/kernel';

export type PersonRoleType = 'student' | 'guardian' | 'staff' | 'alumni';
export const PERSON_ROLE_TYPES: readonly PersonRoleType[] = ['student', 'guardian', 'staff', 'alumni'];

export type RelationshipType = 'parent' | 'guardian' | 'sibling' | 'emergency_contact' | 'authorized_pickup' | 'other';
export const RELATIONSHIP_TYPES: readonly RelationshipType[] = [
  'parent',
  'guardian',
  'sibling',
  'emergency_contact',
  'authorized_pickup',
  'other',
];

export type PersonIdentifierType = 'student_number' | 'national_id' | 'previous_school' | 'other';
export const PERSON_IDENTIFIER_TYPES: readonly PersonIdentifierType[] = [
  'student_number',
  'national_id',
  'previous_school',
  'other',
];

export type AlertCategory = 'medical' | 'safeguarding' | 'access' | 'other';
export const ALERT_CATEGORIES: readonly AlertCategory[] = ['medical', 'safeguarding', 'access', 'other'];

export type ContactPointKind = 'email' | 'phone';
export const CONTACT_POINT_KINDS: readonly ContactPointKind[] = ['email', 'phone'];

export type AlertSeverity = 'info' | 'warning' | 'critical';
export const ALERT_SEVERITIES: readonly AlertSeverity[] = ['info', 'warning', 'critical'];

/** Mirrors `people.person`. `mergedIntoId` set = this row lost a merge and is a tombstone - see `resolvePerson`. */
export interface Person {
  readonly id: PersonId;
  readonly tenantId: TenantId;
  readonly givenName: string;
  readonly familyName: string;
  readonly preferredName: string | null;
  readonly dateOfBirth: DateOnly | null;
  readonly gender: string | null;
  readonly photoFileId: string | null;
  readonly customFields: Record<string, unknown>;
  readonly mergedIntoId: PersonId | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `people.person_role`. `validFrom`/`validTo` both inclusive, matching `@sms/kernel`'s `Interval`. */
export interface PersonRole {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly role: PersonRoleType;
  readonly campusId: CampusId | null;
  readonly validFrom: DateOnly;
  readonly validTo: DateOnly | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `people.household`. */
export interface Household {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly primaryAddress: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `people.household_member`. */
export interface HouseholdMember {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly householdId: string;
  readonly personId: PersonId;
  readonly isPrimaryContact: boolean;
  readonly validFrom: DateOnly;
  readonly validTo: DateOnly | null;
}

/**
 * Mirrors `people.relationship`. Directed: `fromPersonId` is (e.g.) the
 * parent OF `toPersonId`. `hasCustody`/`mayPickup`/`mayReceiveComms` are
 * legally significant flags, never free text - see the `0500` migration
 * header.
 */
export interface Relationship {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly fromPersonId: PersonId;
  readonly toPersonId: PersonId;
  readonly type: RelationshipType;
  readonly hasCustody: boolean;
  readonly mayPickup: boolean;
  readonly mayReceiveComms: boolean;
  readonly priority: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `people.person_identifier`. One row per id kind - never overload one column with several. */
export interface PersonIdentifier {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly type: PersonIdentifierType;
  readonly value: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `people.person_alert`. Read through `@sms/access`'s separate `read_medical`/`read_safeguarding` permissions - see `AlertService`. */
export interface PersonAlert {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly category: AlertCategory;
  readonly severity: AlertSeverity;
  readonly summary: string;
  readonly detail: string | null;
  readonly validFrom: DateOnly;
  readonly validTo: DateOnly | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `people.person_merge`. The permanent record of a merge. */
export interface PersonMerge {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly survivingPersonId: PersonId;
  readonly mergedPersonId: PersonId;
  readonly mergedByUserId: UserId;
  readonly reason: string | null;
  readonly mergedAt: Date;
  readonly payload: Record<string, unknown>;
}

/**
 * Mirrors `people.contact_point`. One row per address - never one column
 * overloaded with several kinds, same reasoning as `PersonIdentifier`.
 * `isPrimary` is unique per (personId, kind) among non-archived rows - see
 * the `0503` migration's partial unique index; `ContactPointService` clears
 * any existing primary of the same kind before setting a new one so that
 * invariant is never left to the caller to uphold.
 */
export interface ContactPoint {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly kind: ContactPointKind;
  readonly value: string;
  readonly label: string | null;
  readonly isPrimary: boolean;
  readonly verifiedAt: Date | null;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One scored candidate from `findPotentialDuplicates`, with the signals that contributed to its score. */
export interface DuplicateCandidate {
  readonly person: Person;
  /** 0..1, higher = more likely a duplicate. See `DuplicateService` for the scoring weights. */
  readonly score: number;
  readonly reasons: string[];
}

export interface PageResult<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}
