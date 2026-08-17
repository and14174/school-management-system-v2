import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenError, type DomainError, type NotFoundError, type PersonId, type Result, type UserId } from '@sms/kernel';
import { ACCESS_CONTRACT, type AccessContract } from '@sms/access';
import type {
  AddContactPointInput,
  AddHouseholdMemberInput,
  AssignRoleInput,
  CreateAlertInput,
  CreateHouseholdInput,
  CreateIdentifierInput,
  CreatePersonInput,
  CreateRelationshipInput,
  EndHouseholdMemberInput,
  EndRoleInput,
  FindDuplicatesInput,
  MergePersonsInput,
  PeopleContract,
  SearchPeopleInput,
  UpdateContactPointInput,
  UpdateHouseholdInput,
  UpdatePersonInput,
  UpdateRelationshipInput,
} from '../contract.js';
import type {
  ContactPoint,
  DuplicateCandidate,
  Household,
  HouseholdMember,
  PageResult,
  Person,
  PersonAlert,
  PersonIdentifier,
  PersonMerge,
  PersonRole,
  Relationship,
} from '../domain/types.js';
import { AlertService } from './alert.service.js';
import { ContactPointService } from './contact-point.service.js';
import { currentTenantContext } from './current-context.js';
import { DuplicateService } from './duplicate.service.js';
import { HouseholdService } from './household.service.js';
import { IdentifierService } from './identifier.service.js';
import { MergeService } from './merge.service.js';
import { PersonService } from './person.service.js';
import { RelationshipService } from './relationship.service.js';
import { RoleService } from './role.service.js';

function requireUserId(userId: UserId | undefined): UserId {
  if (!userId) {
    throw new ForbiddenError('No authenticated user is resolved for this request.');
  }
  return userId;
}

/**
 * Implements `PeopleContract`. Thin composition layer over the individual
 * services (`PersonService`, `RoleService`, ...) - exactly the shape
 * `AccessService` composes `AbilityService`/`RoleService`/
 * `ImpersonationService` in `@sms/access`. Every method resolves the
 * ambient tenant via `currentTenantContext()`; the services underneath all
 * take `tenantId` explicitly so they work equally from `seed.ts` (no
 * ambient context at all).
 */
@Injectable()
export class PeopleService implements PeopleContract {
  constructor(
    @Inject(ContactPointService) private readonly contactPoints: ContactPointService,
    @Inject(PersonService) private readonly persons: PersonService,
    @Inject(RoleService) private readonly roles: RoleService,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(RelationshipService) private readonly relationships: RelationshipService,
    @Inject(IdentifierService) private readonly identifiers: IdentifierService,
    @Inject(AlertService) private readonly alerts: AlertService,
    @Inject(DuplicateService) private readonly duplicates: DuplicateService,
    @Inject(MergeService) private readonly merges: MergeService,
    @Inject(ACCESS_CONTRACT) private readonly access: AccessContract,
  ) {}

  createPerson(input: CreatePersonInput): Promise<Result<Person, DomainError>> {
    const ctx = currentTenantContext();
    return this.persons.createPerson(ctx.tenantId, input);
  }

  getPerson(id: PersonId): Promise<Result<Person, NotFoundError>> {
    const ctx = currentTenantContext();
    return this.persons.getPerson(ctx.tenantId, id);
  }

  updatePerson(id: PersonId, input: UpdatePersonInput): Promise<Result<Person, DomainError>> {
    const ctx = currentTenantContext();
    return this.persons.updatePerson(ctx.tenantId, id, input);
  }

  searchPeople(input: SearchPeopleInput): Promise<PageResult<Person>> {
    const ctx = currentTenantContext();
    return this.persons.searchPeople(ctx.tenantId, input);
  }

  listRoles(personId: PersonId): Promise<PersonRole[]> {
    const ctx = currentTenantContext();
    return this.roles.listRoles(ctx.tenantId, personId);
  }

  assignRole(input: AssignRoleInput): Promise<Result<PersonRole, DomainError>> {
    const ctx = currentTenantContext();
    return this.roles.assignRole(ctx.tenantId, input);
  }

  endRole(input: EndRoleInput): Promise<Result<void, DomainError>> {
    const ctx = currentTenantContext();
    return this.roles.endRole(ctx.tenantId, input);
  }

  createHousehold(input: CreateHouseholdInput): Promise<Result<Household, DomainError>> {
    const ctx = currentTenantContext();
    return this.households.createHousehold(ctx.tenantId, input);
  }

  getHousehold(id: string): Promise<Result<Household, NotFoundError>> {
    const ctx = currentTenantContext();
    return this.households.getHousehold(ctx.tenantId, id);
  }

  updateHousehold(id: string, input: UpdateHouseholdInput): Promise<Result<Household, DomainError>> {
    const ctx = currentTenantContext();
    return this.households.updateHousehold(ctx.tenantId, id, input);
  }

  addHouseholdMember(input: AddHouseholdMemberInput): Promise<Result<HouseholdMember, DomainError>> {
    const ctx = currentTenantContext();
    return this.households.addHouseholdMember(ctx.tenantId, input);
  }

  endHouseholdMember(input: EndHouseholdMemberInput): Promise<Result<void, DomainError>> {
    const ctx = currentTenantContext();
    return this.households.endHouseholdMember(ctx.tenantId, input);
  }

  listHouseholdMembers(householdId: string): Promise<HouseholdMember[]> {
    const ctx = currentTenantContext();
    return this.households.listHouseholdMembers(ctx.tenantId, householdId);
  }

  createRelationship(input: CreateRelationshipInput): Promise<Result<Relationship, DomainError>> {
    const ctx = currentTenantContext();
    return this.relationships.createRelationship(ctx.tenantId, input);
  }

  updateRelationship(id: string, input: UpdateRelationshipInput): Promise<Result<Relationship, DomainError>> {
    const ctx = currentTenantContext();
    return this.relationships.updateRelationship(ctx.tenantId, id, input);
  }

  deleteRelationship(id: string): Promise<Result<void, DomainError>> {
    const ctx = currentTenantContext();
    return this.relationships.deleteRelationship(ctx.tenantId, id);
  }

  listRelationships(personId: PersonId): Promise<Relationship[]> {
    const ctx = currentTenantContext();
    return this.relationships.listRelationships(ctx.tenantId, personId);
  }

  addIdentifier(input: CreateIdentifierInput): Promise<Result<PersonIdentifier, DomainError>> {
    const ctx = currentTenantContext();
    return this.identifiers.addIdentifier(ctx.tenantId, input);
  }

  listIdentifiers(personId: PersonId): Promise<PersonIdentifier[]> {
    const ctx = currentTenantContext();
    return this.identifiers.listIdentifiers(ctx.tenantId, personId);
  }

  addContactPoint(input: AddContactPointInput): Promise<Result<ContactPoint, DomainError>> {
    const ctx = currentTenantContext();
    return this.contactPoints.addContactPoint(ctx.tenantId, input);
  }

  listContactPoints(personId: PersonId): Promise<ContactPoint[]> {
    const ctx = currentTenantContext();
    return this.contactPoints.listContactPoints(ctx.tenantId, personId);
  }

  updateContactPoint(id: string, input: UpdateContactPointInput): Promise<Result<ContactPoint, DomainError>> {
    const ctx = currentTenantContext();
    return this.contactPoints.updateContactPoint(ctx.tenantId, id, input);
  }

  archiveContactPoint(id: string): Promise<Result<void, DomainError>> {
    const ctx = currentTenantContext();
    return this.contactPoints.archiveContactPoint(ctx.tenantId, id);
  }

  listContactPointsForPeople(personIds: PersonId[]): Promise<Map<PersonId, ContactPoint[]>> {
    const ctx = currentTenantContext();
    return this.contactPoints.listContactPointsForPeople(ctx.tenantId, personIds);
  }

  createAlert(input: CreateAlertInput): Promise<Result<PersonAlert, DomainError>> {
    const ctx = currentTenantContext();
    return this.alerts.createAlert(ctx.tenantId, input);
  }

  async listAlerts(personId: PersonId): Promise<PersonAlert[]> {
    const ctx = currentTenantContext();
    const userId = ctx.userId;
    // No ambient user (should not happen on a real request - AuthGuard/
    // TenantContextInterceptor always resolve one) - fail closed rather than
    // showing every alert unfiltered to nobody-in-particular.
    if (!userId) {
      return [];
    }
    const ability = await this.access.compileAbility(userId, ctx.tenantId);
    return this.alerts.listAlerts(ctx.tenantId, personId, ability);
  }

  findPotentialDuplicates(input: FindDuplicatesInput): Promise<DuplicateCandidate[]> {
    const ctx = currentTenantContext();
    return this.duplicates.findPotentialDuplicates(ctx.tenantId, input);
  }

  mergePersons(input: MergePersonsInput): Promise<Result<PersonMerge, DomainError>> {
    const ctx = currentTenantContext();
    // The REAL actor, never an impersonation target - same reasoning as
    // @sms/access's AccessService.startImpersonation: a merge is exactly
    // the kind of consequential write that must always trace back to who
    // actually did it.
    const mergedByUserId = requireUserId(ctx.actorUserId ?? ctx.userId);
    return this.merges.mergePersons(ctx.tenantId, mergedByUserId, input);
  }

  resolvePerson(id: PersonId): Promise<Result<Person, NotFoundError>> {
    const ctx = currentTenantContext();
    return this.persons.getPerson(ctx.tenantId, id);
  }
}
