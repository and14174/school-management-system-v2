import type { CampusId, DateOnly, DomainError, NotFoundError, PersonId, Result } from '@sms/kernel';
import type {
  AlertCategory,
  AlertSeverity,
  ContactPoint,
  ContactPointKind,
  DuplicateCandidate,
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
  PageResult,
} from './domain/types.js';

export * from './domain/types.js';

export interface CreatePersonInput {
  readonly givenName: string;
  readonly familyName: string;
  readonly preferredName?: string | null;
  readonly dateOfBirth?: DateOnly | null;
  readonly gender?: string | null;
  readonly photoFileId?: string | null;
  readonly customFields?: Record<string, unknown>;
}

export interface UpdatePersonInput {
  readonly givenName?: string;
  readonly familyName?: string;
  readonly preferredName?: string | null;
  readonly dateOfBirth?: DateOnly | null;
  readonly gender?: string | null;
  readonly photoFileId?: string | null;
  readonly customFields?: Record<string, unknown>;
}

export interface SearchPeopleInput {
  readonly query?: string;
  readonly role?: PersonRoleType;
  readonly campusId?: CampusId;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface AssignRoleInput {
  readonly personId: PersonId;
  readonly role: PersonRoleType;
  readonly campusId?: CampusId | null;
  readonly validFrom?: DateOnly;
  readonly validTo?: DateOnly | null;
}

export interface EndRoleInput {
  readonly personId: PersonId;
  readonly role: PersonRoleType;
  /** Narrows which assignment to end when the same role was assigned at more than one campus. */
  readonly campusId?: CampusId | null;
  /** The role's `validTo` is set to this date (default: today) rather than the row being deleted. */
  readonly asOf?: DateOnly;
}

export interface CreateHouseholdInput {
  readonly name: string;
  readonly primaryAddress?: Record<string, unknown>;
}

export interface UpdateHouseholdInput {
  readonly name?: string;
  readonly primaryAddress?: Record<string, unknown>;
}

export interface AddHouseholdMemberInput {
  readonly householdId: string;
  readonly personId: PersonId;
  readonly isPrimaryContact?: boolean;
  readonly validFrom?: DateOnly;
  readonly validTo?: DateOnly | null;
}

export interface EndHouseholdMemberInput {
  readonly householdId: string;
  readonly personId: PersonId;
  readonly asOf?: DateOnly;
}

export interface CreateRelationshipInput {
  readonly fromPersonId: PersonId;
  readonly toPersonId: PersonId;
  readonly type: RelationshipType;
  readonly hasCustody?: boolean;
  readonly mayPickup?: boolean;
  readonly mayReceiveComms?: boolean;
  readonly priority?: number;
}

export interface UpdateRelationshipInput {
  readonly hasCustody?: boolean;
  readonly mayPickup?: boolean;
  readonly mayReceiveComms?: boolean;
  readonly priority?: number;
}

export interface CreateIdentifierInput {
  readonly personId: PersonId;
  readonly type: PersonIdentifierType;
  readonly value: string;
}

export interface CreateAlertInput {
  readonly personId: PersonId;
  readonly category: AlertCategory;
  readonly severity: AlertSeverity;
  readonly summary: string;
  readonly detail?: string | null;
  readonly validFrom?: DateOnly;
  readonly validTo?: DateOnly | null;
}

export interface AddContactPointInput {
  readonly personId: PersonId;
  readonly kind: ContactPointKind;
  readonly value: string;
  readonly label?: string | null;
  /** Defaults to `false`. When `true`, any existing non-archived primary of the same (person, kind) is demoted first, in the same transaction - see `ContactPointService`. */
  readonly isPrimary?: boolean;
}

export interface UpdateContactPointInput {
  readonly value?: string;
  readonly label?: string | null;
  /** Setting `true` demotes any other existing non-archived primary of the same (person, kind), same as `AddContactPointInput.isPrimary`. */
  readonly isPrimary?: boolean;
  readonly verifiedAt?: Date | null;
}

/** Either an existing person (find duplicates of someone already in the system) or a not-yet-created candidate (pre-create duplicate check). */
export type FindDuplicatesInput =
  | { readonly personId: PersonId }
  | { readonly givenName: string; readonly familyName: string; readonly dateOfBirth?: DateOnly | null };

export interface MergePersonsInput {
  readonly survivingId: PersonId;
  readonly mergedId: PersonId;
  readonly reason: string;
}

/**
 * The public port this module exposes to the rest of the system
 * (`apps/api`'s `PeopleController`, and eventually the enrollment/academic/
 * billing modules that hang records off a `people.person` id) - matching
 * `@sms/access`'s `AccessContract` pattern: every other module should depend
 * on this interface, not on the concrete `PeopleService` behind it.
 *
 * Every method resolves the ambient ordinary tenant context
 * (`currentTenantContext()`), exactly like `AccessContract.listRoles` -
 * `PeopleService` (the implementation behind this interface) is the REST-
 * facing facade; the individual services it composes
 * (`PersonService`/`RoleService`/...) take `tenantId` explicitly so they
 * also work from `seed.ts` and from tests with no ambient context at all.
 */
export interface PeopleContract {
  createPerson(input: CreatePersonInput): Promise<Result<Person, DomainError>>;
  /** Resolves `id` through any merge chain first - see `resolvePerson`. */
  getPerson(id: PersonId): Promise<Result<Person, NotFoundError>>;
  updatePerson(id: PersonId, input: UpdatePersonInput): Promise<Result<Person, DomainError>>;
  searchPeople(input: SearchPeopleInput): Promise<PageResult<Person>>;

  listRoles(personId: PersonId): Promise<PersonRole[]>;
  assignRole(input: AssignRoleInput): Promise<Result<PersonRole, DomainError>>;
  endRole(input: EndRoleInput): Promise<Result<void, DomainError>>;

  createHousehold(input: CreateHouseholdInput): Promise<Result<Household, DomainError>>;
  getHousehold(id: string): Promise<Result<Household, NotFoundError>>;
  updateHousehold(id: string, input: UpdateHouseholdInput): Promise<Result<Household, DomainError>>;
  addHouseholdMember(input: AddHouseholdMemberInput): Promise<Result<HouseholdMember, DomainError>>;
  endHouseholdMember(input: EndHouseholdMemberInput): Promise<Result<void, DomainError>>;
  listHouseholdMembers(householdId: string): Promise<HouseholdMember[]>;

  createRelationship(input: CreateRelationshipInput): Promise<Result<Relationship, DomainError>>;
  updateRelationship(id: string, input: UpdateRelationshipInput): Promise<Result<Relationship, DomainError>>;
  deleteRelationship(id: string): Promise<Result<void, DomainError>>;
  /** Every relationship where `personId` is either side (`fromPersonId` or `toPersonId`). */
  listRelationships(personId: PersonId): Promise<Relationship[]>;

  addIdentifier(input: CreateIdentifierInput): Promise<Result<PersonIdentifier, DomainError>>;
  listIdentifiers(personId: PersonId): Promise<PersonIdentifier[]>;

  /** Demotes any existing non-archived primary of the same (person, kind) first when `input.isPrimary` is `true` - see `ContactPointService`. */
  addContactPoint(input: AddContactPointInput): Promise<Result<ContactPoint, DomainError>>;
  /** Non-archived contact points for one person, newest first. */
  listContactPoints(personId: PersonId): Promise<ContactPoint[]>;
  updateContactPoint(id: string, input: UpdateContactPointInput): Promise<Result<ContactPoint, DomainError>>;
  /** Archives (never deletes) - see the `0503` migration header. Archived rows drop out of `listContactPoints`/`listContactPointsForPeople` and free up the (person, kind) primary slot for a replacement. */
  archiveContactPoint(id: string): Promise<Result<void, DomainError>>;
  /**
   * Non-archived contact points for MANY people in one query, keyed by
   * `personId` - for callers (e.g. `apps/api`'s guardian recipient resolver)
   * that would otherwise call `listContactPoints` once per person and N+1.
   * A `personId` with no contact points on file is present in the map with
   * an empty array, never omitted, so callers can distinguish "no contact
   * points" from "didn't ask".
   */
  listContactPointsForPeople(personIds: PersonId[]): Promise<Map<PersonId, ContactPoint[]>>;

  createAlert(input: CreateAlertInput): Promise<Result<PersonAlert, DomainError>>;
  /** Filtered by the caller's `people.student:read_medical`/`read_safeguarding` grants - see `AlertService`. */
  listAlerts(personId: PersonId): Promise<PersonAlert[]>;

  findPotentialDuplicates(input: FindDuplicatesInput): Promise<DuplicateCandidate[]>;

  /**
   * Merges `mergedId` into `survivingId`: repoints every related row
   * (`person_role`, `household_member`, `relationship` in both directions,
   * `person_identifier`, `person_alert`) to the survivor, writes a
   * `person_merge` record, and tombstones the loser
   * (`merged_into_id = survivingId`) - never deletes it. Runs inside one
   * `withTenantTx`.
   */
  mergePersons(input: MergePersonsInput): Promise<Result<PersonMerge, DomainError>>;

  /** Follows `merged_into_id` to the current survivor (guarding against a cycle) - what every other read in this contract already does internally. */
  resolvePerson(id: PersonId): Promise<Result<Person, NotFoundError>>;
}

/**
 * DI token for `PeopleContract` - see `TENANCY_CONTRACT` in `@sms/tenancy`
 * for why a concrete Symbol token is used instead of relying on implicit
 * type-based DI.
 */
export const PEOPLE_CONTRACT = Symbol('PEOPLE_CONTRACT');
