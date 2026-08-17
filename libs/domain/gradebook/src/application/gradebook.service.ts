import { Inject, Injectable } from '@nestjs/common';
import type { DomainError, NotFoundError, Result } from '@sms/kernel';
import type {
  Assignment,
  AssignmentSectionContext,
  CalculateSectionGradesInput,
  CalculationRuleSet,
  CalculationRuleSetVersion,
  CreateAssignmentInput,
  CreateCalculationRuleSetInput,
  CreateCategoryInput,
  CreateGradeScaleInput,
  CreateLearningOutcomeInput,
  DecideCorrectionInput,
  EnterScoresInput,
  EnterScoresResult,
  GetStudentGradesInput,
  GradeCategory,
  GradeCorrection,
  GradeScale,
  GradeScaleVersion,
  GradebookContract,
  GradingPeriodLock,
  LearningOutcome,
  ListCorrectionsInput,
  ListOutcomeResultsInput,
  OutcomeResult,
  PublishRuleSetVersionInput,
  PublishScaleVersionInput,
  RecordOutcomeResultInput,
  RequestCorrectionInput,
  Score,
  ScoreSectionContext,
  StudentSectionGrade,
  UpdateAssignmentInput,
  UpdateCategoryInput,
} from '../contract.js';
import { AssignmentService } from './assignment.service.js';
import { CalculationRuleSetService } from './calculation-rule-set.service.js';
import { CategoryService } from './category.service.js';
import { CorrectionService } from './correction.service.js';
import { currentTenantContext } from './current-context.js';
import { GradeScaleService } from './grade-scale.service.js';
import { GradingPeriodLockService } from './grading-period-lock.service.js';
import { OutcomeService } from './outcome.service.js';
import { ScoreService } from './score.service.js';

/**
 * Implements `GradebookContract`. Thin composition layer over the
 * individual services - exactly the shape `AttendanceService` composes
 * `AttendanceCodeService`/`AttendanceRecordService`/`AttendanceCorrectionService`
 * in `@sms/attendance`. Every method resolves the ambient tenant via
 * `currentTenantContext()`; the services underneath all take `tenantId`
 * explicitly so they also work from `seed.ts` and from tests with no
 * ambient context at all.
 */
@Injectable()
export class GradebookService implements GradebookContract {
  constructor(
    @Inject(GradeScaleService) private readonly gradeScales: GradeScaleService,
    @Inject(CalculationRuleSetService) private readonly ruleSets: CalculationRuleSetService,
    @Inject(CategoryService) private readonly categories: CategoryService,
    @Inject(AssignmentService) private readonly assignments: AssignmentService,
    @Inject(ScoreService) private readonly scores: ScoreService,
    @Inject(CorrectionService) private readonly corrections: CorrectionService,
    @Inject(GradingPeriodLockService) private readonly locks: GradingPeriodLockService,
    @Inject(OutcomeService) private readonly outcomes: OutcomeService,
  ) {}

  createGradeScale(input: CreateGradeScaleInput): Promise<Result<GradeScale, DomainError>> {
    return this.gradeScales.createGradeScale(currentTenantContext().tenantId, input);
  }
  listGradeScales(): Promise<GradeScale[]> {
    return this.gradeScales.listGradeScales(currentTenantContext().tenantId);
  }
  publishScaleVersion(input: PublishScaleVersionInput): Promise<Result<GradeScaleVersion, DomainError>> {
    return this.gradeScales.publishScaleVersion(currentTenantContext().tenantId, input);
  }
  listScaleVersions(gradeScaleId: string): Promise<GradeScaleVersion[]> {
    return this.gradeScales.listScaleVersions(currentTenantContext().tenantId, gradeScaleId);
  }

  createCalculationRuleSet(input: CreateCalculationRuleSetInput): Promise<Result<CalculationRuleSet, DomainError>> {
    return this.ruleSets.createRuleSet(currentTenantContext().tenantId, input);
  }
  listCalculationRuleSets(): Promise<CalculationRuleSet[]> {
    return this.ruleSets.listRuleSets(currentTenantContext().tenantId);
  }
  publishRuleSetVersion(input: PublishRuleSetVersionInput): Promise<Result<CalculationRuleSetVersion, DomainError>> {
    return this.ruleSets.publishRuleSetVersion(currentTenantContext().tenantId, input);
  }
  listRuleSetVersions(calculationRuleSetId: string): Promise<CalculationRuleSetVersion[]> {
    return this.ruleSets.listRuleSetVersions(currentTenantContext().tenantId, calculationRuleSetId);
  }

  createCategory(input: CreateCategoryInput): Promise<Result<GradeCategory, DomainError>> {
    return this.categories.createCategory(currentTenantContext().tenantId, input);
  }
  updateCategory(id: string, input: UpdateCategoryInput): Promise<Result<GradeCategory, DomainError>> {
    return this.categories.updateCategory(currentTenantContext().tenantId, id, input);
  }
  listCategories(sectionId: string): Promise<GradeCategory[]> {
    return this.categories.listCategories(currentTenantContext().tenantId, sectionId);
  }
  getCategoryContext(id: string): Promise<{ readonly sectionId: string } | null> {
    return this.categories.getCategoryContext(currentTenantContext().tenantId, id);
  }

  createAssignment(input: CreateAssignmentInput): Promise<Result<Assignment, DomainError>> {
    return this.assignments.createAssignment(currentTenantContext().tenantId, input);
  }
  updateAssignment(id: string, input: UpdateAssignmentInput): Promise<Result<Assignment, DomainError>> {
    return this.assignments.updateAssignment(currentTenantContext().tenantId, id, input);
  }
  publishAssignment(id: string): Promise<Result<Assignment, DomainError>> {
    return this.assignments.publishAssignment(currentTenantContext().tenantId, id);
  }
  listAssignments(sectionId: string, gradingPeriodId?: string): Promise<Assignment[]> {
    return this.assignments.listAssignments(currentTenantContext().tenantId, sectionId, gradingPeriodId);
  }
  getAssignment(id: string): Promise<Result<Assignment, NotFoundError>> {
    return this.assignments.getAssignment(currentTenantContext().tenantId, id);
  }
  getAssignmentContext(id: string): Promise<AssignmentSectionContext | null> {
    return this.assignments.getAssignmentContext(currentTenantContext().tenantId, id);
  }

  enterScores(input: EnterScoresInput): Promise<Result<EnterScoresResult, DomainError>> {
    return this.scores.enterScores(currentTenantContext().tenantId, input);
  }
  listScoresForAssignment(assignmentId: string): Promise<Score[]> {
    return this.scores.listScoresForAssignment(currentTenantContext().tenantId, assignmentId);
  }
  getScoreContext(scoreId: string): Promise<ScoreSectionContext | null> {
    return this.scores.getScoreContext(currentTenantContext().tenantId, scoreId);
  }

  calculateSectionGrades(input: CalculateSectionGradesInput): Promise<StudentSectionGrade[]> {
    return this.scores.calculateSectionGrades(currentTenantContext().tenantId, input);
  }
  getStudentGrades(input: GetStudentGradesInput): Promise<StudentSectionGrade[]> {
    return this.scores.getStudentGrades(currentTenantContext().tenantId, input);
  }

  lockGradingPeriod(gradingPeriodId: string): Promise<Result<GradingPeriodLock, DomainError>> {
    const ctx = currentTenantContext();
    return this.locks.lockGradingPeriod(ctx.tenantId, gradingPeriodId, ctx.actorUserId ?? ctx.userId);
  }
  unlockGradingPeriod(gradingPeriodId: string): Promise<Result<GradingPeriodLock, DomainError>> {
    const ctx = currentTenantContext();
    return this.locks.unlockGradingPeriod(ctx.tenantId, gradingPeriodId, ctx.actorUserId ?? ctx.userId);
  }
  getGradingPeriodLock(gradingPeriodId: string): Promise<GradingPeriodLock | null> {
    return this.locks.getGradingPeriodLock(currentTenantContext().tenantId, gradingPeriodId);
  }

  requestCorrection(input: RequestCorrectionInput): Promise<Result<GradeCorrection, DomainError>> {
    return this.corrections.requestCorrection(currentTenantContext().tenantId, input);
  }
  decideCorrection(input: DecideCorrectionInput): Promise<Result<GradeCorrection, DomainError>> {
    return this.corrections.decideCorrection(currentTenantContext().tenantId, input);
  }
  listCorrections(input?: ListCorrectionsInput): Promise<GradeCorrection[]> {
    return this.corrections.listCorrections(currentTenantContext().tenantId, input ?? {});
  }

  createLearningOutcome(input: CreateLearningOutcomeInput): Promise<Result<LearningOutcome, DomainError>> {
    return this.outcomes.createLearningOutcome(currentTenantContext().tenantId, input);
  }
  listLearningOutcomes(): Promise<LearningOutcome[]> {
    return this.outcomes.listLearningOutcomes(currentTenantContext().tenantId);
  }
  recordOutcomeResult(input: RecordOutcomeResultInput): Promise<Result<OutcomeResult, DomainError>> {
    return this.outcomes.recordOutcomeResult(currentTenantContext().tenantId, input);
  }
  listOutcomeResults(filter: ListOutcomeResultsInput): Promise<OutcomeResult[]> {
    return this.outcomes.listOutcomeResults(currentTenantContext().tenantId, filter);
  }
}
