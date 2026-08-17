import type { DateOnly, PersonId, TenantId, UserId } from '@sms/kernel';
import type {
  Assignment,
  CalculationRuleSet,
  CalculationRuleSetVersion,
  CalculationRules,
  CorrectionStatus,
  GradeBand,
  GradeCategory,
  GradeCorrection,
  GradeScale,
  GradeScaleKind,
  GradeScaleVersion,
  GradingPeriodLock,
  LearningOutcome,
  OutcomeResult,
  ProficiencyLevel,
  Score,
  ScoreStatus,
  ScoreSubmission,
} from '../domain/types.js';
import type {
  assignmentTable,
  calculationRuleSetTable,
  calculationRuleSetVersionTable,
  categoryTable,
  correctionTable,
  gradeScaleTable,
  gradeScaleVersionTable,
  gradingPeriodLockTable,
  learningOutcomeTable,
  outcomeResultTable,
  scoreTable,
  submissionTable,
} from './schema.js';

type GradeScaleRow = typeof gradeScaleTable.$inferSelect;
type GradeScaleVersionRow = typeof gradeScaleVersionTable.$inferSelect;
type CalculationRuleSetRow = typeof calculationRuleSetTable.$inferSelect;
type CalculationRuleSetVersionRow = typeof calculationRuleSetVersionTable.$inferSelect;
type CategoryRow = typeof categoryTable.$inferSelect;
type AssignmentRow = typeof assignmentTable.$inferSelect;
type ScoreRow = typeof scoreTable.$inferSelect;
type SubmissionRow = typeof submissionTable.$inferSelect;
type GradingPeriodLockRow = typeof gradingPeriodLockTable.$inferSelect;
type CorrectionRow = typeof correctionTable.$inferSelect;
type LearningOutcomeRow = typeof learningOutcomeTable.$inferSelect;
type OutcomeResultRow = typeof outcomeResultTable.$inferSelect;

export function toGradeScale(row: GradeScaleRow): GradeScale {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    name: row.name,
    kind: row.kind as GradeScaleKind,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toGradeScaleVersion(row: GradeScaleVersionRow): GradeScaleVersion {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    gradeScaleId: row.gradeScaleId,
    version: row.version,
    bands: row.bands as readonly GradeBand[],
    effectiveFrom: row.effectiveFrom,
    createdAt: row.createdAt,
  };
}

export function toCalculationRuleSet(row: CalculationRuleSetRow): CalculationRuleSet {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    name: row.name,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toCalculationRuleSetVersion(row: CalculationRuleSetVersionRow): CalculationRuleSetVersion {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    calculationRuleSetId: row.calculationRuleSetId,
    version: row.version,
    rules: row.rules as CalculationRules,
    effectiveFrom: row.effectiveFrom,
    createdAt: row.createdAt,
  };
}

export function toCategory(row: CategoryRow): GradeCategory {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    sectionId: row.sectionId,
    name: row.name,
    weight: row.weight,
    dropLowest: row.dropLowest,
    sequence: row.sequence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toAssignment(row: AssignmentRow): Assignment {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    sectionId: row.sectionId,
    categoryId: row.categoryId,
    gradingPeriodId: row.gradingPeriodId,
    title: row.title,
    description: row.description,
    pointsPossible: row.pointsPossible,
    dueOn: row.dueOn as DateOnly | null,
    published: row.published,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toScore(row: ScoreRow): Score {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    assignmentId: row.assignmentId,
    personId: row.personId as PersonId,
    points: row.points,
    status: row.status as ScoreStatus,
    gradeScaleVersionId: row.gradeScaleVersionId,
    comment: row.comment,
    gradedByUserId: (row.gradedByUserId as UserId | null) ?? null,
    gradedAt: row.gradedAt,
  };
}

export function toSubmission(row: SubmissionRow): ScoreSubmission {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    idempotencyKey: row.idempotencyKey,
    assignmentId: row.assignmentId,
    submittedByUserId: (row.submittedByUserId as UserId | null) ?? null,
    scoreCount: row.scoreCount,
    createdAt: row.createdAt,
  };
}

export function toGradingPeriodLock(row: GradingPeriodLockRow): GradingPeriodLock {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    gradingPeriodId: row.gradingPeriodId,
    locked: row.locked,
    lockedByUserId: (row.lockedByUserId as UserId | null) ?? null,
    lockedAt: row.lockedAt,
    unlockedByUserId: (row.unlockedByUserId as UserId | null) ?? null,
    unlockedAt: row.unlockedAt,
  };
}

export function toCorrection(row: CorrectionRow): GradeCorrection {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    scoreId: row.scoreId,
    fromPoints: row.fromPoints,
    toPoints: row.toPoints,
    fromStatus: row.fromStatus as ScoreStatus,
    toStatus: row.toStatus as ScoreStatus,
    reason: row.reason,
    requestedByUserId: (row.requestedByUserId as UserId | null) ?? null,
    status: row.status as CorrectionStatus,
    decidedByUserId: (row.decidedByUserId as UserId | null) ?? null,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
  };
}

export function toLearningOutcome(row: LearningOutcomeRow): LearningOutcome {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    subjectId: row.subjectId,
    code: row.code,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toOutcomeResult(row: OutcomeResultRow): OutcomeResult {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    sectionId: row.sectionId,
    personId: row.personId as PersonId,
    outcomeId: row.outcomeId,
    assignmentId: row.assignmentId,
    proficiencyLevel: row.proficiencyLevel as ProficiencyLevel,
    comment: row.comment,
    scoredByUserId: (row.scoredByUserId as UserId | null) ?? null,
    scoredAt: row.scoredAt,
  };
}
