import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { ForbiddenError, isSystemContext, unwrap, type CampusId, type DateOnly, type PersonId } from '@sms/kernel';
import { requireContext } from '@sms/db';
import { ACCESS_CONTRACT, RequirePermission, maskFields, type AccessContract } from '@sms/access';
import { PEOPLE_CONTRACT, type PeopleContract } from '../contract.js';
import type { PersonRoleType } from '../domain/types.js';
import { CreatePersonDto, UpdatePersonDto } from './dto/person.dto.js';
import { MergePersonsDto } from './dto/merge.dto.js';

/**
 * `people.person` is the resource everything in this controller is gated
 * against (`people.person:read`/`:write`/`:merge`) - the "one person, one
 * record" model applies to a student, guardian, staff member or alumnus
 * alike, so profile access is not keyed to any one role's permission (the
 * pre-existing `people.student:*` catalogue entries stay reserved for the
 * medical/safeguarding alert split - see `AlertService`'s own comment, and
 * `@sms/access`'s field registry).
 *
 * `GET /people/:id`'s response carries two derived flags
 * (`hasMedicalAlerts`/`hasSafeguardingAlerts`), masked out for a caller who
 * lacks `read_medical`/`read_safeguarding` - the field-registry
 * demonstration the brief asks for, replacing the module's old placeholder
 * `people.student` entries (see `@sms/access`'s `field-registry.ts`).
 * Applied by calling `maskFields` DIRECTLY here rather than through
 * `@MaskFields`/`FieldMaskingInterceptor`. Both now work - the interceptor
 * originally read the context via `requireContext()` from an RxJS operator in
 * the response pipeline, which runs after `TenantContextInterceptor`'s
 * `AsyncLocalStorage.run()` has returned and therefore saw nothing; it now
 * reads the context off the request instead.
 *
 * The direct call is kept because this handler has already had to compile an
 * ability for `listAlerts`, so routing the same work through the interceptor
 * would compile it a second time for no benefit. Note the asymmetry that makes
 * this safe: a route HANDLER does run inside the ALS scope (it executes while
 * the innermost Observable is being built), which is why `requireContext()`
 * below is fine here and was not fine there.
 */
@ApiTags('people')
@Controller('people')
export class PeopleController {
  // Explicit @Inject(): see apps/api's HealthController for why implicit
  // type-based DI is not trusted in this codebase.
  constructor(
    @Inject(PEOPLE_CONTRACT) private readonly people: PeopleContract,
    @Inject(ACCESS_CONTRACT) private readonly access: AccessContract,
  ) {}

  @RequirePermission('people.person:read')
  @Get()
  async search(
    @Query('query') query?: string,
    @Query('role') role?: PersonRoleType,
    @Query('campusId') campusId?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.people.searchPeople({
      ...(query ? { query } : {}),
      ...(role ? { role } : {}),
      ...(campusId ? { campusId: campusId as CampusId } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
      ...(cursor ? { cursor } : {}),
    });
  }

  @RequirePermission('people.person:write')
  @Post()
  async create(@Body(new ZodValidationPipe(CreatePersonDto)) body: CreatePersonDto) {
    return unwrap(
      await this.people.createPerson({
        givenName: body.givenName,
        familyName: body.familyName,
        preferredName: body.preferredName ?? undefined,
        dateOfBirth: (body.dateOfBirth as DateOnly | null) ?? undefined,
        gender: body.gender ?? undefined,
        photoFileId: body.photoFileId ?? undefined,
        customFields: body.customFields,
      }),
    );
  }

  // ---------------------------------------------------------------------
  // Self-referential reads. Declared BEFORE `:id` so the literal "me" can
  // never be swallowed by the parameterised route (the same ordering rule
  // `DocumentsController` documents for its `templates` routes).
  //
  // These take no id at all, which is the point: the caller can only ever
  // ask about THEMSELVES, so there is no scope puzzle to get wrong. That
  // matters because a guardian holds `people.student:read` at `dependants`
  // scope and therefore cannot call `GET /people/:id` or
  // `GET /people/:id/relationships` (both gated on `people.person:read`) -
  // without these two routes a parent has no way to discover their own
  // children, and the parent portal cannot list them at all.
  //
  // Gated on `people.student:read` because that is the one permission both
  // portal-facing roles hold; the guard's bare-subject check ignores scope
  // conditions, and the data returned is bounded by the caller's identity
  // rather than by that grant.
  // ---------------------------------------------------------------------

  @RequirePermission('people.student:read')
  @Get('me')
  async me() {
    return unwrap(await this.people.getPerson(this.requireOwnPersonId()));
  }

  /**
   * The people this caller is responsible for - for a guardian, their
   * children. Derived from `people.relationship` in the direction the
   * contract documents (`fromPersonId` is the guardian OF `toPersonId`).
   *
   * Deliberately NOT filtered on `may_receive_comms`: that flag governs
   * whether someone is sent broadcast communications and says nothing about
   * whether they may see their child's record - the same distinction the
   * `dependants` scope resolver makes, and conflating the two would hide a
   * child from their own parent over a mailing preference.
   */
  @RequirePermission('people.student:read')
  @Get('me/dependants')
  async myDependants() {
    const personId = this.requireOwnPersonId();
    const relationships = await this.people.listRelationships(personId);

    const dependants = [];
    for (const relationship of relationships) {
      if (relationship.fromPersonId !== personId) {
        continue;
      }
      const person = await this.people.getPerson(relationship.toPersonId);
      if (!person.ok) {
        continue;
      }
      dependants.push({
        personId: relationship.toPersonId,
        givenName: person.value.givenName,
        familyName: person.value.familyName,
        relationshipType: relationship.type,
        hasCustody: relationship.hasCustody,
        mayPickup: relationship.mayPickup,
        priority: relationship.priority,
      });
    }

    // `priority` is the column that orders a person's relationships; the name
    // is only a tie-break, so the list cannot reshuffle between reloads when
    // several children share a priority.
    return dependants.sort(
      (a, b) =>
        a.priority - b.priority ||
        a.familyName.localeCompare(b.familyName) ||
        a.givenName.localeCompare(b.givenName),
    );
  }

  @RequirePermission('people.person:read')
  @Get(':id')
  async getById(@Param('id', ParseUUIDPipe) id: string) {
    const person = unwrap(await this.people.getPerson(id as PersonId));
    const alerts = await this.people.listAlerts(id as PersonId);
    const record = {
      ...person,
      hasMedicalAlerts: alerts.some((alert) => alert.category === 'medical'),
      hasSafeguardingAlerts: alerts.some((alert) => alert.category === 'safeguarding'),
    };

    const ctx = requireContext();
    if (isSystemContext(ctx) || !ctx.userId) {
      // Same "nothing to mask against" fallback FieldMaskingInterceptor's
      // own comment documents - never true for a real HTTP request (AuthGuard/
      // TenantContextInterceptor always resolve one before this runs).
      return record;
    }
    const ability = await this.access.compileAbility(ctx.userId, ctx.tenantId);
    return maskFields(record, 'people.person', ability);
  }

  @RequirePermission('people.person:write')
  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(UpdatePersonDto)) body: UpdatePersonDto) {
    return unwrap(
      await this.people.updatePerson(id as PersonId, {
        ...(body.givenName !== undefined ? { givenName: body.givenName } : {}),
        ...(body.familyName !== undefined ? { familyName: body.familyName } : {}),
        ...(body.preferredName !== undefined ? { preferredName: body.preferredName } : {}),
        ...(body.dateOfBirth !== undefined ? { dateOfBirth: body.dateOfBirth as DateOnly | null } : {}),
        ...(body.gender !== undefined ? { gender: body.gender } : {}),
        ...(body.photoFileId !== undefined ? { photoFileId: body.photoFileId } : {}),
        ...(body.customFields !== undefined ? { customFields: body.customFields } : {}),
      }),
    );
  }

  @RequirePermission('people.person:read')
  @Get(':id/relationships')
  async relationships(@Param('id', ParseUUIDPipe) id: string) {
    return this.people.listRelationships(id as PersonId);
  }

  // No @MaskFields here: the ENTIRE list is already permission-filtered
  // row-by-row inside PeopleService.listAlerts/AlertService.listAlerts - see
  // those files' own comments for why field masking (uniform per field name)
  // is the wrong tool for a per-row category, and row-level filtering is the
  // right one.
  @RequirePermission('people.person:read')
  @Get(':id/alerts')
  async alerts(@Param('id', ParseUUIDPipe) id: string) {
    return this.people.listAlerts(id as PersonId);
  }

  @RequirePermission('people.person:read')
  @Get(':id/duplicates')
  async duplicates(@Param('id', ParseUUIDPipe) id: string) {
    return this.people.findPotentialDuplicates({ personId: id as PersonId });
  }

  @RequirePermission('people.person:merge')
  @Post('merge')
  async merge(@Body(new ZodValidationPipe(MergePersonsDto)) body: MergePersonsDto) {
    return unwrap(
      await this.people.mergePersons({
        survivingId: body.survivingId as PersonId,
        mergedId: body.mergedId as PersonId,
        reason: body.reason,
      }),
    );
  }

  /**
   * The caller's own linked person. Identical in spirit to
   * `CommunicationsController.requireOwnPersonId` - an account with no person
   * record cannot answer "who am I", and that is a forbidden request rather
   * than an empty result.
   */
  private requireOwnPersonId(): PersonId {
    const ctx = requireContext();
    if (isSystemContext(ctx) || !ctx.personId) {
      throw new ForbiddenError('The caller has no linked person record.');
    }
    return ctx.personId;
  }
}
