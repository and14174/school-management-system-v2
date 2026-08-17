import type { PersonId, TenantId, UserId } from '@sms/kernel';

// ---------------------------------------------------------------------------
// Grade scales - see the `1000` migration header for why a score points at
// the VERSION, never the scale.
// ---------------------------------------------------------------------------

export type GradeScaleKind = 'points' | 'percentage' | 'letter' | 'standards';
export const GRADE_SCALE_KINDS: readonly GradeScaleKind[] = ['points', 'percentage', 'letter', 'standards'];

/** One band of a grade scale version - `min` is the inclusive lower percentage bound; bands are matched highest-`min`-first. */
export interface GradeBand {
  readonly label: string;
  readonly min: number;
  readonly gpaPoints?: number | null;
}

/** Mirrors `gradebook.grade_scale`. Never edited in place past its first version - see `GradeScaleVersion`. */
export interface GradeScale {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly kind: GradeScaleKind;
  readonly isDefault: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Mirrors `gradebook.grade_scale_version` - IMMUTABLE from the moment it is
 * created (the database refuses UPDATE/DELETE outright - see the `1000`
 * migration). `gradebook.score.gradeScaleVersionId` points here, never at
 * `GradeScale` directly, so a scale edit can never retroactively re-grade a
 * historical score.
 */
export interface GradeScaleVersion {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly gradeScaleId: string;
  readonly version: number;
  readonly bands: readonly GradeBand[];
  readonly effectiveFrom: string;
  readonly createdAt: Date;
}

// ---------------------------------------------------------------------------
// Calculation rule sets - see the `1000` migration header for why weighting/
// drop-lowest/rounding live in versioned, immutable, evaluator-interpreted
// JSON rather than per-scheme code branches.
// ---------------------------------------------------------------------------

export type RoundingMode = 'half-up' | 'half-even' | 'floor' | 'ceil';
export const ROUNDING_MODES: readonly RoundingMode[] = ['half-up', 'half-even', 'floor', 'ceil'];

export interface CalculationRuleCategory {
  /** Matched against `gradebook.category.name` (case-insensitive) - see the `1000` migration header for why this is reusable across sections by name, not by category id. */
  readonly name: string;
  readonly weight: number;
  readonly dropLowest: number;
}

/** The JSON structure `gradebook.calculation_rule_set_version.rules` holds, and the ONLY input the evaluator (`application/evaluator.ts`) reasons about. */
export interface CalculationRules {
  readonly rounding: { readonly decimals: number; readonly mode: RoundingMode };
  readonly categories: readonly CalculationRuleCategory[];
}

/** Mirrors `gradebook.calculation_rule_set`. */
export interface CalculationRuleSet {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly isDefault: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `gradebook.calculation_rule_set_version` - IMMUTABLE, same posture as `GradeScaleVersion`. */
export interface CalculationRuleSetVersion {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly calculationRuleSetId: string;
  readonly version: number;
  readonly rules: CalculationRules;
  readonly effectiveFrom: string;
  readonly createdAt: Date;
}

// ---------------------------------------------------------------------------
// Categories, assignments, scores
// ---------------------------------------------------------------------------

/** Mirrors `gradebook.category` - structural, mutable, per-section. See the `1000` migration header for why this is decoupled from `CalculationRuleSetVersion`. */
export interface GradeCategory {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly sectionId: string;
  readonly name: string;
  readonly weight: number;
  readonly dropLowest: number;
  readonly sequence: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `gradebook.assignment`. */
export interface Assignment {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly sectionId: string;
  readonly categoryId: string;
  readonly gradingPeriodId: string;
  readonly title: string;
  readonly description: string | null;
  readonly pointsPossible: number;
  readonly dueOn: string | null;
  readonly published: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ScoreStatus = 'graded' | 'missing' | 'exempt' | 'late' | 'incomplete';
export const SCORE_STATUSES: readonly ScoreStatus[] = ['graded', 'missing', 'exempt', 'late', 'incomplete'];

/** Mirrors `gradebook.score` - the current state of one person's score on one assignment. */
export interface Score {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly assignmentId: string;
  readonly personId: PersonId;
  readonly points: number | null;
  readonly status: ScoreStatus;
  readonly gradeScaleVersionId: string | null;
  readonly comment: string | null;
  readonly gradedByUserId: UserId | null;
  readonly gradedAt: Date;
}

/** Mirrors `gradebook.submission` - the idempotency ledger `enterScores` writes to once per NEW (non-replayed) call. */
export interface ScoreSubmission {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly idempotencyKey: string;
  readonly assignmentId: string;
  readonly submittedByUserId: UserId | null;
  readonly scoreCount: number;
  readonly createdAt: Date;
}

// ---------------------------------------------------------------------------
// Grading period locking
// ---------------------------------------------------------------------------

/** Mirrors `gradebook.grading_period_lock`. */
export interface GradingPeriodLock {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly gradingPeriodId: string;
  readonly locked: boolean;
  readonly lockedByUserId: UserId | null;
  readonly lockedAt: Date | null;
  readonly unlockedByUserId: UserId | null;
  readonly unlockedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

export type CorrectionStatus = 'pending' | 'approved' | 'rejected';
export const CORRECTION_STATUSES: readonly CorrectionStatus[] = ['pending', 'approved', 'rejected'];

/** Mirrors `gradebook.correction` - append-only history, same idea as `attendance.correction`. */
export interface GradeCorrection {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly scoreId: string;
  readonly fromPoints: number | null;
  readonly toPoints: number | null;
  readonly fromStatus: ScoreStatus;
  readonly toStatus: ScoreStatus;
  readonly reason: string | null;
  readonly requestedByUserId: UserId | null;
  readonly status: CorrectionStatus;
  readonly decidedByUserId: UserId | null;
  readonly decidedAt: Date | null;
  readonly createdAt: Date;
}

// ---------------------------------------------------------------------------
// Standards-based grading
// ---------------------------------------------------------------------------

export type ProficiencyLevel = 'beginning' | 'developing' | 'proficient' | 'advanced';
export const PROFICIENCY_LEVELS: readonly ProficiencyLevel[] = ['beginning', 'developing', 'proficient', 'advanced'];

/** Numeric equivalent used for averaging - not stored, derived by the application layer only. */
export const PROFICIENCY_LEVEL_VALUE: Record<ProficiencyLevel, number> = {
  beginning: 1,
  developing: 2,
  proficient: 3,
  advanced: 4,
};

/** Mirrors `gradebook.learning_outcome`. */
export interface LearningOutcome {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly subjectId: string | null;
  readonly code: string;
  readonly description: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `gradebook.outcome_result` - the current proficiency level for one (person, outcome), optionally tied to one assignment. */
export interface OutcomeResult {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly sectionId: string;
  readonly personId: PersonId;
  readonly outcomeId: string;
  readonly assignmentId: string | null;
  readonly proficiencyLevel: ProficiencyLevel;
  readonly comment: string | null;
  readonly scoredByUserId: UserId | null;
  readonly scoredAt: Date;
}

// ---------------------------------------------------------------------------
// Computed views
// ---------------------------------------------------------------------------

/** One assignment's contribution to a category's percentage, as computed by the evaluator - what a teacher challenged on a grade needs to see. */
export interface AssignmentContribution {
  readonly assignmentId: string;
  readonly assignmentTitle: string;
  readonly pointsEarned: number | null;
  readonly pointsPossible: number;
  readonly status: ScoreStatus;
  /** `true` when this assignment was excluded from the category total by drop-lowest-N. */
  readonly dropped: boolean;
}

/** One category's contribution to the overall percentage - see `calculateSectionGrades`'s own doc comment ("return the breakdown, not just the number"). */
export interface CategoryBreakdown {
  readonly categoryId: string;
  readonly categoryName: string;
  /** The weight actually applied (0 when the calculation rule set has no matching category entry, and this category is excluded from the total). */
  readonly weight: number;
  readonly earnedPoints: number;
  readonly possiblePoints: number;
  /** `null` when this category had no gradeable (non-exempt) assignments in the period. */
  readonly percentage: number | null;
  readonly contributions: readonly AssignmentContribution[];
}

/** One student's computed grade for a section/grading period - what `calculateSectionGrades` and `getStudentGrades` return. */
export interface StudentSectionGrade {
  readonly personId: PersonId;
  readonly sectionId: string;
  readonly gradingPeriodId: string;
  /** `null` when no category contributed anything (nothing graded yet). */
  readonly percentage: number | null;
  readonly letter: string | null;
  readonly gpaPoints: number | null;
  readonly gradeScaleVersionId: string | null;
  readonly calculationRuleSetVersionId: string | null;
  readonly breakdown: readonly CategoryBreakdown[];
}
