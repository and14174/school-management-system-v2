import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { ForbiddenError, isSystemContext, unwrap, type PersonId } from '@sms/kernel';
import { requireContext } from '@sms/db';
import { ACCESS_CONTRACT, RequirePermission, type AccessContract, type ScopeConstraint } from '@sms/access';
import { DOCUMENTS_CONTRACT, type DocumentsContract } from '../contract.js';
import { GenerateDocumentDto, ListDocumentsQueryDto, PublishTemplateVersionDto, ReissueDocumentDto } from './dto/documents.dto.js';

/**
 * `api/v1/documents/*`. Gated with its own `documents.document:read`/
 * `:generate` and `documents.template:manage` pair (see `@sms/access`'s
 * `domain/permissions.ts`) - NOT `people.person:read`/`:write` as this
 * controller used to be wired, which was a deliberate placeholder (see the
 * git history and `docs/decisions.md`'s
 * "`documents.document:read` must not be wired up until that controller has
 * scope narrowing" entry) left in place until the narrowing below existed.
 *
 * `@RequirePermission` only answers "may this user touch documents AT ALL" -
 * a type-level check with no particular subject to test conditions against
 * (see `@sms/access`'s `ability.types.ts`). Parent/Guardian, Student and
 * Teacher all hold `documents.document:read` (scoped `dependants`/`own`/
 * `section` respectively - see `@sms/access`'s `seed.ts`), so EVERY read
 * here - the list AND the two single-record reads - additionally calls
 * `assertSubjectAccess` below, the data-filtering layer
 * `resolveScopeConstraints` exists for, exactly like `@sms/records`'
 * `RecordsController.assertReportCardAccess` (the reference implementation
 * this mirrors) and per `docs/decisions.md`'s "a list endpoint cannot be
 * secured by a per-row check it never performs".
 *
 * `generate`/`reissue` stay gated by `documents.document:generate` alone,
 * with no additional narrowing: only School Administrator and Registrar
 * hold that permission, and both hold it scoped `tenant` (see `seed.ts`) -
 * nobody with a narrower grant can reach these two routes at all, same
 * reasoning `RecordsController.issueReportCards`'s own comment gives for
 * not narrowing `documents.document:generate` there either.
 *
 * `listDocuments` validates `(subjectType, subjectId)` BEFORE calling
 * `DocumentsContract.listDocuments` - the query itself is already scoped to
 * one subject, so authorizing the subject up front (denying before the query
 * ever runs) satisfies "filter in the query, never fetch-then-filter"
 * without needing row-level SQL filtering.
 *
 * Static routes (`templates`, `templates/versions`) are declared before the
 * `:id` routes so they can never be shadowed by it.
 */
@ApiTags('documents')
@Controller('documents')
export class DocumentsController {
  constructor(
    @Inject(DOCUMENTS_CONTRACT) private readonly documents: DocumentsContract,
    @Inject(ACCESS_CONTRACT) private readonly access: AccessContract,
  ) {}

  // ---------------------------------------------------------------------
  // Templates - tenant-wide configuration (report card layout, transcript,
  // certificate...), not a per-record scoped resource - same posture as
  // `@sms/attendance`'s `codes`. Only School Administrator/Registrar ever
  // hold `documents.template:manage` (see `seed.ts`), so no caller with a
  // narrower grant can reach either route.
  // ---------------------------------------------------------------------

  @RequirePermission('documents.template:manage')
  @Get('templates')
  async listTemplates() {
    return this.documents.listTemplates();
  }

  @RequirePermission('documents.template:manage')
  @Post('templates/versions')
  async publishTemplateVersion(@Body(new ZodValidationPipe(PublishTemplateVersionDto)) body: PublishTemplateVersionDto) {
    return unwrap(await this.documents.publishTemplateVersion(body));
  }

  // ---------------------------------------------------------------------
  // Generate / reissue - see this file's top-of-file comment for why these
  // two need no additional per-record narrowing beyond the guard.
  // ---------------------------------------------------------------------

  @RequirePermission('documents.document:generate')
  @Post()
  async generate(@Body(new ZodValidationPipe(GenerateDocumentDto)) body: GenerateDocumentDto) {
    return unwrap(await this.documents.generate(body));
  }

  @RequirePermission('documents.document:generate')
  @Post(':id/reissue')
  async reissue(@Param('id') id: string, @Body(new ZodValidationPipe(ReissueDocumentDto)) body: ReissueDocumentDto) {
    return unwrap(await this.documents.reissue(id, body));
  }

  // ---------------------------------------------------------------------
  // Reads - narrowed per this file's top-of-file comment.
  // ---------------------------------------------------------------------

  @RequirePermission('documents.document:read')
  @Get()
  async listDocuments(@Query(new ZodValidationPipe(ListDocumentsQueryDto)) query: ListDocumentsQueryDto) {
    await this.assertSubjectAccess(query.subjectType, query.subjectId, 'documents.document:read');
    return this.documents.listDocuments({ subjectType: query.subjectType, subjectId: query.subjectId });
  }

  @RequirePermission('documents.document:read')
  @Get(':id')
  async getDocument(@Param('id') id: string) {
    const document = unwrap(await this.documents.getDocument(id));
    await this.assertSubjectAccess(document.subjectType, document.subjectId, 'documents.document:read');
    return document;
  }

  @RequirePermission('documents.document:read')
  @Get(':id/download-url')
  async getDownloadUrl(@Param('id') id: string) {
    const document = unwrap(await this.documents.getDocument(id));
    await this.assertSubjectAccess(document.subjectType, document.subjectId, 'documents.document:read');
    return unwrap(await this.documents.getDownloadUrl(id));
  }

  // ---------------------------------------------------------------------
  // Scope-constraint helpers - the data-filtering half `@RequirePermission`
  // cannot do on its own (see this file's top-of-file comment).
  // ---------------------------------------------------------------------

  private async resolveConstraint(permissionKey: string): Promise<ScopeConstraint> {
    const ctx = requireContext();
    if (isSystemContext(ctx) || !ctx.userId) {
      throw new ForbiddenError('No authenticated tenant context is resolved for this request.');
    }
    const constraints = await this.access.resolveScopeConstraints(ctx.userId, ctx.tenantId);
    return constraints[permissionKey] ?? { kind: 'none' };
  }

  /**
   * A document's subject is opaque to this module (`type:platform` - see
   * `contract.ts`'s own comment on `GenerateDocumentInput.subjectType`), so
   * this can only narrow the ONE subject type it can safely interpret:
   * `'people.person'` (a student), where `subjectId` IS the `PersonId` -
   * exactly the convention `@sms/notifications`' `RecipientResolver` already
   * documents. `own` (the person themselves) and `dependants` (a guardian
   * reading one of THEIR children's documents) are resolvable against that;
   * `tenant` always passes.
   *
   * Everything else fails CLOSED rather than guessing:
   * - any OTHER `subjectType` - this module has no way to know what it means,
   *   and treating an unmapped subject as accessible would be exactly the
   *   silent over-exposure `docs/decisions.md` warns against.
   * - `section` - a Teacher's `documents.document:read` grant IS scoped
   *   `section` (see `seed.ts`), but confirming "is this person one of MY
   *   students" needs section-roster data (`@sms/academic`'s
   *   `listStudentsInSection`) that this platform module cannot reach
   *   (`type:platform` may only depend on `type:platform`/`type:shared` -
   *   see `eslint.config.mjs`'s `depConstraints`). A Teacher therefore
   *   reaches no document through this endpoint today - exactly the access
   *   they had before this gate was swapped from `people.person:read`
   *   (which they never held at all), so this is not a regression. Resolving
   *   it for real needs an inversion port of the same shape as
   *   `@sms/access`'s `SECTION_SCOPE_RESOLVER` - left for when a caller
   *   actually needs it.
   * - `campus`/`none` - neither says anything about which subjects a caller
   *   may reach.
   */
  private async assertSubjectAccess(subjectType: string, subjectId: string, permissionKey: string): Promise<void> {
    const constraint = await this.resolveConstraint(permissionKey);
    if (constraint.kind === 'tenant') {
      return;
    }
    if (subjectType === 'people.person') {
      const personId = subjectId as PersonId;
      if (constraint.kind === 'own' && constraint.personId === personId) {
        return;
      }
      if (constraint.kind === 'dependants' && constraint.personIds.includes(personId)) {
        return;
      }
    }
    throw new ForbiddenError(`You do not have access to documents for subject "${subjectType}:${subjectId}".`);
  }
}
