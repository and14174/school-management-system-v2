import type { DateOnly, DomainError, NotFoundError, PersonId, Result } from '@sms/kernel';
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
  StudentSectionGrade,
} from './domain/types.js';

export * from './domain/types.js';

// ---------------------------------------------------------------------------
// Grade scales
// ---------------------------------------------------------------------------

export interface CreateGradeScaleInput {
  readonly name: string;
  readonly kind: GradeScaleKind;
  readonly isDefault?: boolean;
}

export interface PublishScaleVersionInput {
  readonly gradeScaleId: string;
  readonly bands: readonly GradeBand[];
  /** Defaults to today. */
  readonly effectiveFrom?: DateOnly;
}

// ---------------------------------------------------------------------------
// Calculation rule sets
// ---------------------------------------------------------------------------

export interface CreateCalculationRuleSetInput {
  readonly name: string;
  readonly isDefault?: boolean;
}

export interface PublishRuleSetVersionInput {
  readonly calculationRuleSetId: string;
  readonly rules: CalculationRules;
  /** Defaults to today. */
  readonly effectiveFrom?: DateOnly;
}

// ---------------------------------------------------------------------------
// Categories / assignments
// ---------------------------------------------------------------------------

export interface CreateCategoryInput {
  readonly sectionId: string;
  readonly name: string;
  readonly weight?: number;
  readonly dropLowest?: number;
  readonly sequence?: number;
}
export type UpdateCategoryInput = Partial<Omit<CreateCategoryInput, 'sectionId'>>;

export interface CreateAssignmentInput {
  readonly sectionId: string;
  readonly categoryId: string;
  readonly gradingPeriodId: string;
  readonly title: string;
  readonly description?: string | null;
  readonly pointsPossible: number;
  readonly dueOn?: DateOnly | null;
}
export type UpdateAssignmentInput = Partial<Omit<CreateAssignmentInput, 'sectionId'>>;

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

export interface EnterScoreInput {
  readonly personId: PersonId;
  readonly points?: number | null;
  readonly status: ScoreStatus;
  readonly comment?: string | null;
}

export interface EnterScoresInput {
  readonly assignmentId: string;
  /** Client-supplied. A replay of the same key is a no-op - see `ScoreService.enterScores`. */
  readonly idempotencyKey: string;
  readonly scores: readonly EnterScoreInput[];
}

export interface EnterScoresResult {
  readonly scores: readonly Score[];
  readonly submission: ScoreSubmission;
  /** `true` when `idempotencyKey` had already been submitted - the returned `scores`/`submission` are the ORIGINAL result, and nothing was written this call. */
  readonly replayed: boolean;
}

// ---------------------------------------------------------------------------
// Computed views
// ---------------------------------------------------------------------------

export interface CalculateSectionGradesInput {
  readonly sectionId: string;
  readonly gradingPeriodId: string;
  /** Resolves the effective grade scale/calculation rule set version as of this date. Defaults to today. */
  readonly asOf?: DateOnly;
}

export interface GetStudentGradesInput {
  readonly personId: PersonId;
  readonly gradingPeriodId: string;
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

export interface RequestCorrectionInput {
  readonly scoreId: string;
  readonly toPoints?: number | null;
  readonly toStatus: ScoreStatus;
  readonly reason?: string | null;
}

export interface DecideCorrectionInput {
  readonly correctionId: string;
  readonly approve: boolean;
  readonly reason?: string | null;
}

export interface ListCorrectionsInput {
  readonly status?: CorrectionStatus;
}

// ---------------------------------------------------------------------------
// Standards-based grading
// ---------------------------------------------------------------------------

export interface CreateLearningOutcomeInput {
  readonly code: string;
  readonly description: string;
  readonly subjectId?: string | null;
}

export interface RecordOutcomeResultInput {
  readonly sectionId: string;
  readonly personId: PersonId;
  readonly outcomeId: string;
  readonly assignmentId?: string | null;
  readonly proficiencyLevel: ProficiencyLevel;
  readonly comment?: string | null;
}

export interface ListOutcomeResultsInput {
  readonly sectionId?: string;
  readonly personId?: PersonId;
  readonly outcomeId?: string;
}

// ---------------------------------------------------------------------------
// Context lookups - resolve a resource id to the section it belongs to, so
// `apps/api`'s `GradebookController` can authorize a request against a
// SPECIFIC section (see `resolveScopeConstraints`) before acting on it -
// same pattern as `@sms/attendance`'s `getMeetingContext`.
// ---------------------------------------------------------------------------

export interface AssignmentSectionContext {
  readonly sectionId: string;
  readonly gradingPeriodId: string;
  readonly published: boolean;
}

export interface ScoreSectionContext {
  readonly sectionId: string;
  readonly assignmentId: string;
  readonly personId: PersonId;
}

/**
 * The public port this module exposes to the rest of the system
 * (`apps/api`'s `GradebookController`) - matching `@sms/attendance`'s
 * `AttendanceContract` pattern: every other module should depend on this
 * interface, not on the concrete `GradebookService` behind it.
 *
 * Every method resolves the ambient ordinary tenant context
 * (`currentTenantContext()`) - `GradebookService` (the implementation behind
 * this interface) is the REST-facing facade; the individual services it
 * composes take `tenantId` explicitly so they also work from `seed.ts` and
 * from tests with no ambient context at all.
 */
export interface GradebookContract {
  // --- Grade scales ---------------------------------------------------
  createGradeScale(input: CreateGradeScaleInput): Promise<Result<GradeScale, DomainError>>;
  listGradeScales(): Promise<GradeScale[]>;
  /** Creates a NEW immutable `GradeScaleVersion` - editing a scale never touches an existing version or the scores that point at it. See the `1000` migration header. */
  publishScaleVersion(input: PublishScaleVersionInput): Promise<Result<GradeScaleVersion, DomainError>>;
  listScaleVersions(gradeScaleId: string): Promise<GradeScaleVersion[]>;

  // --- Calculation rule sets -------------------------------------------
  createCalculationRuleSet(input: CreateCalculationRuleSetInput): Promise<Result<CalculationRuleSet, DomainError>>;
  listCalculationRuleSets(): Promise<CalculationRuleSet[]>;
  publishRuleSetVersion(input: PublishRuleSetVersionInput): Promise<Result<CalculationRuleSetVersion, DomainError>>;
  listRuleSetVersions(calculationRuleSetId: string): Promise<CalculationRuleSetVersion[]>;

  // --- Categories -------------------------------------------------------
  createCategory(input: CreateCategoryInput): Promise<Result<GradeCategory, DomainError>>;
  updateCategory(id: string, input: UpdateCategoryInput): Promise<Result<GradeCategory, DomainError>>;
  listCategories(sectionId: string): Promise<GradeCategory[]>;
  getCategoryContext(id: string): Promise<{ readonly sectionId: string } | null>;

  // --- Assignments --------------------------------------------------------
  createAssignment(input: CreateAssignmentInput): Promise<Result<Assignment, DomainError>>;
  updateAssignment(id: string, input: UpdateAssignmentInput): Promise<Result<Assignment, DomainError>>;
  /** Sets `published = true` and, in the SAME transaction, publishes `gradebook.grade_posted` for every score already entered against this assignment - see the `1000` migration header. */
  publishAssignment(id: string): Promise<Result<Assignment, DomainError>>;
  listAssignments(sectionId: string, gradingPeriodId?: string): Promise<Assignment[]>;
  getAssignment(id: string): Promise<Result<Assignment, NotFoundError>>;
  getAssignmentContext(id: string): Promise<AssignmentSectionContext | null>;

  // --- Scores ---------------------------------------------------------
  /**
   * The teacher's bulk entry. One transaction: upsert every score in
   * `scores`, write the `gradebook.submission` idempotency row, and publish
   * `gradebook.score_entered` (plus `gradebook.grade_posted` when the
   * assignment is already published) through the SAME transaction - see
   * `@sms/outbox`'s `OutboxContract.publish` doc comment. A replayed
   * `idempotencyKey` returns the ORIGINAL result and writes nothing further.
   * Rejected outright (no partial write) if the assignment's grading period
   * is locked - see `lockGradingPeriod`.
   */
  enterScores(input: EnterScoresInput): Promise<Result<EnterScoresResult, DomainError>>;
  listScoresForAssignment(assignmentId: string): Promise<Score[]>;
  getScoreContext(scoreId: string): Promise<ScoreSectionContext | null>;

  // --- Computed views ---------------------------------------------------
  /**
   * Runs the evaluator (`application/evaluator.ts`) over every currently
   * enrolled student in `sectionId`, for every published assignment in
   * `gradingPeriodId`. Returns per-student percentage, letter (resolved via
   * the tenant's default grade scale's version effective `asOf`) and the
   * FULL breakdown - a teacher challenged on a grade must be able to see how
   * it was computed, not just the final number.
   */
  calculateSectionGrades(input: CalculateSectionGradesInput): Promise<StudentSectionGrade[]>;
  /** One entry per section `personId` is currently enrolled in that has assignments in `gradingPeriodId` - a student typically takes several sections (subjects) sharing one grading period, so this is their whole report card for the period, not a single number. Empty if none. */
  getStudentGrades(input: GetStudentGradesInput): Promise<StudentSectionGrade[]>;

  // --- Grading-period locking -------------------------------------------
  /** Locks `gradingPeriodId` - see the `1000` migration header: enforced in the database (`trg_check_score_lock`), not just here. */
  lockGradingPeriod(gradingPeriodId: string): Promise<Result<GradingPeriodLock, DomainError>>;
  unlockGradingPeriod(gradingPeriodId: string): Promise<Result<GradingPeriodLock, DomainError>>;
  getGradingPeriodLock(gradingPeriodId: string): Promise<GradingPeriodLock | null>;

  // --- Corrections --------------------------------------------------------
  /** `fromPoints`/`fromStatus` are RESOLVED from the score's current state, never accepted as caller input - so a correction can never be requested against the wrong starting value. */
  requestCorrection(input: RequestCorrectionInput): Promise<Result<GradeCorrection, DomainError>>;
  /** Approving applies `toPoints`/`toStatus` to the underlying score in the SAME transaction as the decision - the only way to change a score locked by its grading period. Rejecting decides without touching the score. */
  decideCorrection(input: DecideCorrectionInput): Promise<Result<GradeCorrection, DomainError>>;
  listCorrections(input?: ListCorrectionsInput): Promise<GradeCorrection[]>;

  // --- Standards-based grading -------------------------------------------
  createLearningOutcome(input: CreateLearningOutcomeInput): Promise<Result<LearningOutcome, DomainError>>;
  listLearningOutcomes(): Promise<LearningOutcome[]>;
  /** Upserts the current proficiency level for `(personId, outcomeId, assignmentId ?? null)` - same "current state" idiom as `enterScores`. */
  recordOutcomeResult(input: RecordOutcomeResultInput): Promise<Result<OutcomeResult, DomainError>>;
  listOutcomeResults(filter: ListOutcomeResultsInput): Promise<OutcomeResult[]>;
}

/**
 * DI token for `GradebookContract` - see `TENANCY_CONTRACT` in `@sms/tenancy`
 * for why a concrete Symbol token is used instead of relying on implicit
 * type-based DI.
 */
export const GRADEBOOK_CONTRACT = Symbol('GRADEBOOK_CONTRACT');
