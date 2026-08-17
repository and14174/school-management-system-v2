import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { ForbiddenError, isSystemContext, unwrap, todayDateOnly, type AcademicYearId, type DateOnly, type PersonId } from '@sms/kernel';
import { requireContext } from '@sms/db';
import { ACCESS_CONTRACT, RequirePermission, type AccessContract, type ScopeConstraint } from '@sms/access';
import { ACADEMIC_CONTRACT, type AcademicContract } from '@sms/academic';
import { DOCUMENTS_CONTRACT, type DocumentsContract } from '@sms/documents';
import { RECORDS_CONTRACT, type RecordsContract } from '../contract.js';
import type { GpaScope } from '../domain/types.js';
import {
  CalculateGpaQueryDto,
  CreateCreditRuleSetDto,
  FinaliseTranscriptEntriesDto,
  IssueReportCardsDto,
  PreviewReportCardDto,
  PublishCreditRuleSetVersionDto,
} from './dto/records.dto.js';

/**
 * `api/v1/records/*`. Every route is gated with `@RequirePermission` AND
 * (per `docs/decisions.md`'s "a list endpoint cannot be secured by a per-row
 * check it never performs") additionally applies
 * `AccessContract.resolveScopeConstraints` itself - both the list endpoints
 * and the single-record reads, exactly like `@sms/gradebook`'s
 * `GradebookController` (the reference implementation this file mirrors).
 *
 * Issuing report cards and finalising transcripts are gated with
 * `documents.document:generate`/`records.transcript:finalise` - permissions
 * School Administrator and Registrar hold tenant-wide and Teacher holds
 * NEITHER of (see `@sms/access`'s seeded roles), so those two endpoints need
 * no additional scope narrowing beyond the guard itself (a caller without
 * the grant is denied outright, before ever reaching this controller's
 * body).
 */
@ApiTags('records')
@Controller('records')
export class RecordsController {
  constructor(
    @Inject(RECORDS_CONTRACT) private readonly records: RecordsContract,
    @Inject(ACCESS_CONTRACT) private readonly access: AccessContract,
    @Inject(ACADEMIC_CONTRACT) private readonly academic: AcademicContract,
    @Inject(DOCUMENTS_CONTRACT) private readonly documents: DocumentsContract,
  ) {}

  // ---------------------------------------------------------------------
  // Report cards
  // ---------------------------------------------------------------------

  @RequirePermission('documents.document:generate')
  @Post('report-cards/preview')
  async previewReportCard(@Body(new ZodValidationPipe(PreviewReportCardDto)) body: PreviewReportCardDto) {
    return unwrap(await this.records.previewReportCard({ personId: body.personId as PersonId, gradingPeriodId: body.gradingPeriodId }));
  }

  @RequirePermission('documents.document:generate')
  @Post('report-cards/issue')
  async issueReportCards(@Body(new ZodValidationPipe(IssueReportCardsDto)) body: IssueReportCardsDto) {
    if (body.sectionId) {
      await this.assertSectionAccess(body.sectionId, 'documents.document:generate');
    }
    return unwrap(
      await this.records.issueReportCards({
        gradingPeriodId: body.gradingPeriodId,
        idempotencyKey: body.idempotencyKey,
        ...(body.sectionId ? { sectionId: body.sectionId } : {}),
      }),
    );
  }

  @RequirePermission('documents.document:read')
  @Get('report-cards')
  async listReportCards(@Query('personId') personId?: string, @Query('runId') runId?: string) {
    const cards = await this.records.listReportCards({
      ...(personId ? { personId: personId as PersonId } : {}),
      ...(runId ? { runId } : {}),
    });
    return this.applyReportCardListConstraint(cards);
  }

  @RequirePermission('documents.document:read')
  @Get('report-cards/:id')
  async getReportCard(@Param('id', ParseUUIDPipe) id: string) {
    const context = await this.records.getReportCardContext(id);
    if (!context) {
      throw new ForbiddenError(`Report card ${id} not found.`);
    }
    await this.assertReportCardAccess(context, 'documents.document:read');
    return unwrap(await this.records.getReportCard(id));
  }

  @RequirePermission('documents.document:read')
  @Get('report-cards/:id/download-url')
  async getReportCardDownloadUrl(@Param('id', ParseUUIDPipe) id: string) {
    const context = await this.records.getReportCardContext(id);
    if (!context) {
      throw new ForbiddenError(`Report card ${id} not found.`);
    }
    await this.assertReportCardAccess(context, 'documents.document:read');
    const reportCard = unwrap(await this.records.getReportCard(id));
    return unwrap(await this.documents.getDownloadUrl(reportCard.documentId));
  }

  // ---------------------------------------------------------------------
  // Transcripts / GPA / promotion eligibility
  // ---------------------------------------------------------------------

  @RequirePermission('records.transcript:finalise')
  @Post('transcripts/finalise')
  async finaliseTranscriptEntries(@Body(new ZodValidationPipe(FinaliseTranscriptEntriesDto)) body: FinaliseTranscriptEntriesDto) {
    return unwrap(await this.records.finaliseTranscriptEntries({ personId: body.personId as PersonId, termId: body.termId }));
  }

  @RequirePermission('records.transcript:read')
  @Get('transcripts/:personId')
  async getTranscript(@Param('personId', ParseUUIDPipe) personId: string) {
    await this.assertStudentAccess(personId as PersonId, 'records.transcript:read');
    return this.records.getTranscript(personId as PersonId);
  }

  @RequirePermission('records.transcript:read')
  @Get('transcripts/:personId/gpa')
  async calculateGpa(
    @Param('personId', ParseUUIDPipe) personId: string,
    @Query(new ZodValidationPipe(CalculateGpaQueryDto)) query: CalculateGpaQueryDto,
  ) {
    await this.assertStudentAccess(personId as PersonId, 'records.transcript:read');
    const gpa = await this.records.calculateGpa({
      personId: personId as PersonId,
      scope: query.scope as GpaScope,
      ...(query.termId ? { termId: query.termId } : {}),
      ...(query.academicYearId ? { academicYearId: query.academicYearId as AcademicYearId } : {}),
    });
    return { personId, scope: query.scope, gpa };
  }

  @RequirePermission('records.transcript:read')
  @Get('promotion-eligibility/:personId')
  async checkPromotionEligibility(@Param('personId', ParseUUIDPipe) personId: string, @Query('academicYearId', ParseUUIDPipe) academicYearId: string) {
    await this.assertStudentAccess(personId as PersonId, 'records.transcript:read');
    return unwrap(await this.records.checkPromotionEligibility({ personId: personId as PersonId, academicYearId: academicYearId as AcademicYearId }));
  }

  // ---------------------------------------------------------------------
  // Credit rule sets (rules as data) - tenant-wide policy, same posture as
  // @sms/gradebook's grade scales/calculation rule sets: reads are gated by
  // the coarse records.transcript:read grant, writes by
  // records.transcript:finalise (no dedicated "manage" permission - see the
  // module report for why these two are the only new catalogue entries).
  // ---------------------------------------------------------------------

  @RequirePermission('records.transcript:read')
  @Get('credit-rule-sets')
  listCreditRuleSets() {
    return this.records.listCreditRuleSets();
  }

  @RequirePermission('records.transcript:finalise')
  @Post('credit-rule-sets')
  async createCreditRuleSet(@Body(new ZodValidationPipe(CreateCreditRuleSetDto)) body: CreateCreditRuleSetDto) {
    return unwrap(await this.records.createCreditRuleSet(body));
  }

  @RequirePermission('records.transcript:read')
  @Get('credit-rule-sets/:id/versions')
  listCreditRuleSetVersions(@Param('id', ParseUUIDPipe) id: string) {
    return this.records.listCreditRuleSetVersions(id);
  }

  @RequirePermission('records.transcript:finalise')
  @Post('credit-rule-sets/:id/versions')
  async publishCreditRuleSetVersion(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(PublishCreditRuleSetVersionDto)) body: PublishCreditRuleSetVersionDto) {
    return unwrap(
      await this.records.publishCreditRuleSetVersion({
        creditRuleSetId: id,
        rules: body.rules,
        ...(body.effectiveFrom ? { effectiveFrom: body.effectiveFrom as DateOnly } : {}),
      }),
    );
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

  /** Authorizes a request against a SPECIFIC section - not just "may this user touch report cards at all". Same idiom as `@sms/gradebook`'s `GradebookController.assertSectionAccess`. */
  private async assertSectionAccess(sectionId: string, permissionKey: string): Promise<void> {
    const constraint = await this.resolveConstraint(permissionKey);
    if (constraint.kind === 'tenant') return;
    if (constraint.kind === 'section' && constraint.sectionIds.includes(sectionId)) return;
    throw new ForbiddenError(`You do not have access to section ${sectionId}'s report cards.`);
  }

  /**
   * Authorizes a request against a report card, given its `personId` and
   * (nullable, since a `report_card_run` can be tenant-wide) `sectionId`.
   * A `section`-scoped caller can only reach a report card whose RUN was
   * itself issued scoped to one of their sections - a whole-school run's
   * `sectionId` is `null` and therefore never matches a section grant. Fail
   * closed rather than falling through to a student-membership check the
   * report card itself does not carry any record of.
   */
  private async assertReportCardAccess(context: { personId: PersonId; sectionId: string | null }, permissionKey: string): Promise<void> {
    const constraint = await this.resolveConstraint(permissionKey);
    if (constraint.kind === 'tenant') return;
    if (constraint.kind === 'own' && constraint.personId === context.personId) return;
    if (constraint.kind === 'dependants' && constraint.personIds.includes(context.personId)) return;
    if (constraint.kind === 'section' && context.sectionId && constraint.sectionIds.includes(context.sectionId)) return;
    throw new ForbiddenError('You do not have access to this report card.');
  }

  /** Authorizes a request against a specific student's transcript/GPA/eligibility, for a `section`-scoped caller (a teacher) by checking whether that student is currently enrolled in one of their sections, or for a `dependants`-scoped caller (a guardian) by checking whether the student is one of THEIR children. */
  private async assertStudentAccess(personId: PersonId, permissionKey: string): Promise<void> {
    const constraint = await this.resolveConstraint(permissionKey);
    if (constraint.kind === 'tenant') return;
    if (constraint.kind === 'own' && constraint.personId === personId) return;
    if (constraint.kind === 'dependants' && constraint.personIds.includes(personId)) return;
    if (constraint.kind === 'section') {
      const asOf = todayDateOnly();
      for (const sectionId of constraint.sectionIds) {
        const roster = await this.academic.listStudentsInSection(sectionId, asOf);
        if (roster.some((student) => student.personId === personId)) return;
      }
    }
    throw new ForbiddenError(`You do not have access to person ${personId}'s academic records.`);
  }

  /** Narrows `listReportCards`' result to what the caller's `documents.document:read` grant actually covers - same acknowledged in-memory-filtering posture as `@sms/gradebook`'s `applyStudentGradesConstraint`. */
  private async applyReportCardListConstraint(cards: Awaited<ReturnType<RecordsContract['listReportCards']>>) {
    const constraint = await this.resolveConstraint('documents.document:read');
    if (constraint.kind === 'tenant') return cards;
    if (constraint.kind === 'own') return cards.filter((card) => card.personId === constraint.personId);
    if (constraint.kind === 'dependants') return cards.filter((card) => constraint.personIds.includes(card.personId));
    // 'section' report-card runs are per-run, not per-card - only a run
    // whose OWN sectionId is one of the caller's is visible; that context
    // is not on ReportCard itself, so filter via getReportCardContext.
    if (constraint.kind === 'section') {
      const contexts = await Promise.all(cards.map((card) => this.records.getReportCardContext(card.id)));
      return cards.filter((card, index) => {
        const ctx = contexts[index];
        return ctx?.sectionId != null && constraint.sectionIds.includes(ctx.sectionId);
      });
    }
    return [];
  }
}
