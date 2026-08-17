import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { ForbiddenError, isSystemContext, unwrap, type DateOnly, type PersonId } from '@sms/kernel';
import { requireContext } from '@sms/db';
import { ACCESS_CONTRACT, RequirePermission, type AccessContract, type ScopeConstraint } from '@sms/access';
import { GRADEBOOK_CONTRACT, type GradebookContract } from '../contract.js';
import type { CalculationRules, CorrectionStatus, GradeScaleKind, ProficiencyLevel, ScoreStatus } from '../domain/types.js';
import {
  CalculateSectionGradesQueryDto,
  CreateAssignmentDto,
  CreateCalculationRuleSetDto,
  CreateCategoryDto,
  CreateGradeScaleDto,
  CreateLearningOutcomeDto,
  DecideCorrectionDto,
  EnterScoresDto,
  GetStudentGradesQueryDto,
  PublishRuleSetVersionDto,
  PublishScaleVersionDto,
  RecordOutcomeResultDto,
  RequestCorrectionDto,
  UpdateAssignmentDto,
  UpdateCategoryDto,
} from './dto/gradebook.dto.js';

/**
 * `@RequirePermission('academic.gradebook:read'|'write')` only answers the
 * CASL question - "may this user touch the gradebook AT ALL" - a
 * type-level check with no particular section to test conditions against
 * (see `@sms/access`'s `ability.types.ts`). A Teacher's grant is scoped
 * `section`; the guard alone cannot know WHICH section a category/
 * assignment/score request names. `assertSectionAccess` below is the
 * second, REQUIRED half - the data-filtering layer `resolveScopeConstraints`
 * exists for - applied to every read AND write here, exactly like
 * `@sms/attendance`'s `AttendanceController` (see that file's own comment)
 * and per `docs/decisions.md`'s "a list endpoint cannot be secured by a
 * per-row check it never performs".
 */
@ApiTags('gradebook')
@Controller('gradebook')
export class GradebookController {
  constructor(
    @Inject(GRADEBOOK_CONTRACT) private readonly gradebook: GradebookContract,
    @Inject(ACCESS_CONTRACT) private readonly access: AccessContract,
  ) {}

  // ---------------------------------------------------------------------
  // Grade scales / calculation rule sets - tenant-wide policy, gated by
  // gradebook.scale:manage for writes; read is the coarse
  // academic.gradebook:read check alone (no section to narrow by - a scale
  // is not a per-section resource, same posture as attendance.code).
  // ---------------------------------------------------------------------

  @RequirePermission('academic.gradebook:read')
  @Get('scales')
  listGradeScales() {
    return this.gradebook.listGradeScales();
  }

  @RequirePermission('gradebook.scale:manage')
  @Post('scales')
  async createGradeScale(@Body(new ZodValidationPipe(CreateGradeScaleDto)) body: CreateGradeScaleDto) {
    return unwrap(await this.gradebook.createGradeScale({ ...body, kind: body.kind as GradeScaleKind }));
  }

  @RequirePermission('academic.gradebook:read')
  @Get('scales/:id/versions')
  listScaleVersions(@Param('id', ParseUUIDPipe) id: string) {
    return this.gradebook.listScaleVersions(id);
  }

  @RequirePermission('gradebook.scale:manage')
  @Post('scales/:id/versions')
  async publishScaleVersion(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(PublishScaleVersionDto)) body: PublishScaleVersionDto) {
    return unwrap(
      await this.gradebook.publishScaleVersion({
        gradeScaleId: id,
        bands: body.bands,
        ...(body.effectiveFrom !== undefined && body.effectiveFrom !== null ? { effectiveFrom: body.effectiveFrom as DateOnly } : {}),
      }),
    );
  }

  @RequirePermission('academic.gradebook:read')
  @Get('rule-sets')
  listCalculationRuleSets() {
    return this.gradebook.listCalculationRuleSets();
  }

  @RequirePermission('gradebook.scale:manage')
  @Post('rule-sets')
  async createCalculationRuleSet(@Body(new ZodValidationPipe(CreateCalculationRuleSetDto)) body: CreateCalculationRuleSetDto) {
    return unwrap(await this.gradebook.createCalculationRuleSet(body));
  }

  @RequirePermission('academic.gradebook:read')
  @Get('rule-sets/:id/versions')
  listRuleSetVersions(@Param('id', ParseUUIDPipe) id: string) {
    return this.gradebook.listRuleSetVersions(id);
  }

  @RequirePermission('gradebook.scale:manage')
  @Post('rule-sets/:id/versions')
  async publishRuleSetVersion(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(PublishRuleSetVersionDto)) body: PublishRuleSetVersionDto) {
    return unwrap(
      await this.gradebook.publishRuleSetVersion({
        calculationRuleSetId: id,
        rules: body.rules as CalculationRules,
        ...(body.effectiveFrom !== undefined && body.effectiveFrom !== null ? { effectiveFrom: body.effectiveFrom as DateOnly } : {}),
      }),
    );
  }

  // ---------------------------------------------------------------------
  // Categories - scoped to their section.
  // ---------------------------------------------------------------------

  @RequirePermission('academic.gradebook:read')
  @Get('sections/:sectionId/categories')
  async listCategories(@Param('sectionId', ParseUUIDPipe) sectionId: string) {
    await this.assertSectionAccess(sectionId, 'academic.gradebook:read');
    return this.gradebook.listCategories(sectionId);
  }

  @RequirePermission('academic.gradebook:write')
  @Post('sections/:sectionId/categories')
  async createCategory(@Param('sectionId', ParseUUIDPipe) sectionId: string, @Body(new ZodValidationPipe(CreateCategoryDto)) body: CreateCategoryDto) {
    await this.assertSectionAccess(sectionId, 'academic.gradebook:write');
    return unwrap(await this.gradebook.createCategory({ ...body, sectionId }));
  }

  @RequirePermission('academic.gradebook:write')
  @Patch('categories/:id')
  async updateCategory(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(UpdateCategoryDto)) body: UpdateCategoryDto) {
    const context = await this.gradebook.getCategoryContext(id);
    if (!context) {
      throw new ForbiddenError(`Category ${id} not found.`);
    }
    await this.assertSectionAccess(context.sectionId, 'academic.gradebook:write');
    return unwrap(await this.gradebook.updateCategory(id, body));
  }

  // ---------------------------------------------------------------------
  // Assignments - scoped to their section.
  // ---------------------------------------------------------------------

  @RequirePermission('academic.gradebook:read')
  @Get('sections/:sectionId/assignments')
  async listAssignments(@Param('sectionId', ParseUUIDPipe) sectionId: string, @Query('gradingPeriodId') gradingPeriodId?: string) {
    await this.assertSectionAccess(sectionId, 'academic.gradebook:read');
    return this.gradebook.listAssignments(sectionId, gradingPeriodId);
  }

  @RequirePermission('academic.gradebook:write')
  @Post('sections/:sectionId/assignments')
  async createAssignment(@Param('sectionId', ParseUUIDPipe) sectionId: string, @Body(new ZodValidationPipe(CreateAssignmentDto)) body: CreateAssignmentDto) {
    await this.assertSectionAccess(sectionId, 'academic.gradebook:write');
    return unwrap(
      await this.gradebook.createAssignment({
        sectionId,
        categoryId: body.categoryId,
        gradingPeriodId: body.gradingPeriodId,
        title: body.title,
        pointsPossible: body.pointsPossible,
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.dueOn !== undefined && body.dueOn !== null ? { dueOn: body.dueOn as DateOnly } : {}),
      }),
    );
  }

  @RequirePermission('academic.gradebook:read')
  @Get('assignments/:id')
  async getAssignment(@Param('id', ParseUUIDPipe) id: string) {
    const context = await this.gradebook.getAssignmentContext(id);
    if (!context) {
      throw new ForbiddenError(`Assignment ${id} not found.`);
    }
    await this.assertSectionAccess(context.sectionId, 'academic.gradebook:read');
    return unwrap(await this.gradebook.getAssignment(id));
  }

  @RequirePermission('academic.gradebook:write')
  @Patch('assignments/:id')
  async updateAssignment(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(UpdateAssignmentDto)) body: UpdateAssignmentDto) {
    const context = await this.gradebook.getAssignmentContext(id);
    if (!context) {
      throw new ForbiddenError(`Assignment ${id} not found.`);
    }
    await this.assertSectionAccess(context.sectionId, 'academic.gradebook:write');
    return unwrap(
      await this.gradebook.updateAssignment(id, {
        ...(body.categoryId !== undefined ? { categoryId: body.categoryId } : {}),
        ...(body.gradingPeriodId !== undefined ? { gradingPeriodId: body.gradingPeriodId } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.pointsPossible !== undefined ? { pointsPossible: body.pointsPossible } : {}),
        ...(body.dueOn !== undefined ? { dueOn: body.dueOn as DateOnly | null } : {}),
      }),
    );
  }

  @RequirePermission('academic.gradebook:write')
  @Post('assignments/:id/publish')
  async publishAssignment(@Param('id', ParseUUIDPipe) id: string) {
    const context = await this.gradebook.getAssignmentContext(id);
    if (!context) {
      throw new ForbiddenError(`Assignment ${id} not found.`);
    }
    await this.assertSectionAccess(context.sectionId, 'academic.gradebook:write');
    return unwrap(await this.gradebook.publishAssignment(id));
  }

  // ---------------------------------------------------------------------
  // Scores - scoped via the assignment's section.
  // ---------------------------------------------------------------------

  @RequirePermission('academic.gradebook:read')
  @Get('assignments/:id/scores')
  async listScoresForAssignment(@Param('id', ParseUUIDPipe) id: string) {
    const context = await this.gradebook.getAssignmentContext(id);
    if (!context) {
      throw new ForbiddenError(`Assignment ${id} not found.`);
    }
    await this.assertSectionAccess(context.sectionId, 'academic.gradebook:read');
    return this.gradebook.listScoresForAssignment(id);
  }

  @RequirePermission('academic.gradebook:write')
  @Post('assignments/:id/scores')
  async enterScores(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(EnterScoresDto)) body: EnterScoresDto) {
    const context = await this.gradebook.getAssignmentContext(id);
    if (!context) {
      throw new ForbiddenError(`Assignment ${id} not found.`);
    }
    await this.assertSectionAccess(context.sectionId, 'academic.gradebook:write');
    return unwrap(
      await this.gradebook.enterScores({
        assignmentId: id,
        idempotencyKey: body.idempotencyKey,
        scores: body.scores.map((s) => ({
          personId: s.personId as PersonId,
          status: s.status as ScoreStatus,
          ...(s.points !== undefined ? { points: s.points } : {}),
          ...(s.comment !== undefined ? { comment: s.comment } : {}),
        })),
      }),
    );
  }

  // ---------------------------------------------------------------------
  // Computed views.
  // ---------------------------------------------------------------------

  @RequirePermission('academic.gradebook:read')
  @Get('sections/:sectionId/grades')
  async calculateSectionGrades(
    @Param('sectionId', ParseUUIDPipe) sectionId: string,
    @Query(new ZodValidationPipe(CalculateSectionGradesQueryDto)) query: CalculateSectionGradesQueryDto,
  ) {
    await this.assertSectionAccess(sectionId, 'academic.gradebook:read');
    return this.gradebook.calculateSectionGrades({
      sectionId,
      gradingPeriodId: query.gradingPeriodId,
      ...(query.asOf ? { asOf: query.asOf as DateOnly } : {}),
    });
  }

  @RequirePermission('academic.gradebook:read')
  @Get('students/:personId/grades')
  async getStudentGrades(
    @Param('personId', ParseUUIDPipe) personId: string,
    @Query(new ZodValidationPipe(GetStudentGradesQueryDto)) query: GetStudentGradesQueryDto,
  ) {
    const grades = await this.gradebook.getStudentGrades({ personId: personId as PersonId, gradingPeriodId: query.gradingPeriodId });
    return this.applyStudentGradesConstraint(personId as PersonId, grades);
  }

  // ---------------------------------------------------------------------
  // Grading-period locking - gradebook.grade:approve, never granted to
  // Teacher (see @sms/access's seeded roles).
  // ---------------------------------------------------------------------

  @RequirePermission('gradebook.grade:approve')
  @Post('grading-periods/:id/lock')
  async lockGradingPeriod(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.gradebook.lockGradingPeriod(id));
  }

  @RequirePermission('gradebook.grade:approve')
  @Post('grading-periods/:id/unlock')
  async unlockGradingPeriod(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.gradebook.unlockGradingPeriod(id));
  }

  @RequirePermission('academic.gradebook:read')
  @Get('grading-periods/:id/lock')
  async getGradingPeriodLock(@Param('id', ParseUUIDPipe) id: string) {
    return this.gradebook.getGradingPeriodLock(id);
  }

  // ---------------------------------------------------------------------
  // Corrections. `gradebook.grade:approve` is never granted to Teacher - a
  // teacher must not approve their own correction (module brief).
  // requestCorrection stays scoped through the underlying score's section,
  // same as attendance.record:write covers requestCorrection there.
  // ---------------------------------------------------------------------

  @RequirePermission('academic.gradebook:write')
  @Post('corrections')
  async requestCorrection(@Body(new ZodValidationPipe(RequestCorrectionDto)) body: RequestCorrectionDto) {
    const context = await this.gradebook.getScoreContext(body.scoreId);
    if (!context) {
      throw new ForbiddenError(`Score ${body.scoreId} not found.`);
    }
    await this.assertSectionAccess(context.sectionId, 'academic.gradebook:write');
    return unwrap(
      await this.gradebook.requestCorrection({
        scoreId: body.scoreId,
        toStatus: body.toStatus as ScoreStatus,
        ...(body.toPoints !== undefined ? { toPoints: body.toPoints } : {}),
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      }),
    );
  }

  @RequirePermission('gradebook.grade:approve')
  @Post('corrections/:id/decide')
  async decideCorrection(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(DecideCorrectionDto)) body: DecideCorrectionDto) {
    return unwrap(
      await this.gradebook.decideCorrection({
        correctionId: id,
        approve: body.approve,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      }),
    );
  }

  @RequirePermission('gradebook.grade:approve')
  @Get('corrections')
  listCorrections(@Query('status') status?: string) {
    return this.gradebook.listCorrections(status ? { status: status as CorrectionStatus } : {});
  }

  // ---------------------------------------------------------------------
  // Standards-based grading. Outcomes are a tenant-wide catalogue
  // (gradebook.scale:manage to create - same posture as a grade scale);
  // outcome results are section-scoped like scores.
  // ---------------------------------------------------------------------

  @RequirePermission('academic.gradebook:read')
  @Get('outcomes')
  listLearningOutcomes() {
    return this.gradebook.listLearningOutcomes();
  }

  @RequirePermission('gradebook.scale:manage')
  @Post('outcomes')
  async createLearningOutcome(@Body(new ZodValidationPipe(CreateLearningOutcomeDto)) body: CreateLearningOutcomeDto) {
    return unwrap(await this.gradebook.createLearningOutcome(body));
  }

  @RequirePermission('academic.gradebook:read')
  @Get('outcome-results')
  async listOutcomeResults(@Query('sectionId') sectionId?: string, @Query('personId') personId?: string, @Query('outcomeId') outcomeId?: string) {
    if (sectionId) {
      await this.assertSectionAccess(sectionId, 'academic.gradebook:read');
    }
    return this.gradebook.listOutcomeResults({
      ...(sectionId ? { sectionId } : {}),
      ...(personId ? { personId: personId as PersonId } : {}),
      ...(outcomeId ? { outcomeId } : {}),
    });
  }

  @RequirePermission('academic.gradebook:write')
  @Post('outcome-results')
  async recordOutcomeResult(@Body(new ZodValidationPipe(RecordOutcomeResultDto)) body: RecordOutcomeResultDto) {
    await this.assertSectionAccess(body.sectionId, 'academic.gradebook:write');
    return unwrap(
      await this.gradebook.recordOutcomeResult({
        sectionId: body.sectionId,
        personId: body.personId as PersonId,
        outcomeId: body.outcomeId,
        proficiencyLevel: body.proficiencyLevel as ProficiencyLevel,
        ...(body.assignmentId !== undefined ? { assignmentId: body.assignmentId } : {}),
        ...(body.comment !== undefined ? { comment: body.comment } : {}),
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

  /** Authorizes a request against a SPECIFIC section - not just "may this user touch the gradebook at all". */
  private async assertSectionAccess(sectionId: string, permissionKey: string): Promise<void> {
    const constraint = await this.resolveConstraint(permissionKey);
    if (constraint.kind === 'tenant') {
      return;
    }
    if (constraint.kind === 'section' && constraint.sectionIds.includes(sectionId)) {
      return;
    }
    // 'campus'/'own'/'dependants'/'none' say nothing a gradebook grant should
    // ever resolve to for this module's seeded roles - fail closed rather
    // than guessing, per docs/decisions.md.
    throw new ForbiddenError(`You do not have access to section ${sectionId}'s gradebook.`);
  }

  /**
   * Narrows `getStudentGrades`' result (potentially several sections) to
   * what the caller's `academic.gradebook:read` grant actually covers:
   * `tenant` sees everything, `own` only the caller's own record,
   * `dependants` a guardian's own child's record, `section` only the
   * sections they teach. Same acknowledged in-memory-filtering posture as
   * `@sms/attendance`'s `applyUnmarkedSessionsConstraint`.
   */
  private async applyStudentGradesConstraint(personId: PersonId, grades: Awaited<ReturnType<GradebookContract['getStudentGrades']>>) {
    const constraint = await this.resolveConstraint('academic.gradebook:read');
    if (constraint.kind === 'tenant') {
      return grades;
    }
    if (constraint.kind === 'own' && constraint.personId === personId) {
      return grades;
    }
    if (constraint.kind === 'dependants' && constraint.personIds.includes(personId)) {
      return grades;
    }
    if (constraint.kind === 'section') {
      return grades.filter((grade) => constraint.sectionIds.includes(grade.sectionId));
    }
    return [];
  }
}
