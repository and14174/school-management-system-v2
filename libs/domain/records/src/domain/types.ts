import type { AcademicYearId, DateOnly, PersonId, TenantId, UserId } from '@sms/kernel';

// ---------------------------------------------------------------------------
// Report cards
// ---------------------------------------------------------------------------

export type ReportCardRunStatus = 'draft' | 'issued';
export const REPORT_CARD_RUN_STATUSES: readonly ReportCardRunStatus[] = ['draft', 'issued'];

/** Mirrors `records.report_card_run` - one batch issue. `sectionId: null` means "the whole school". */
export interface ReportCardRun {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly gradingPeriodId: string;
  readonly sectionId: string | null;
  readonly idempotencyKey: string;
  readonly status: ReportCardRunStatus;
  readonly issuedAt: Date | null;
  readonly issuedByUserId: UserId | null;
  readonly documentCount: number;
  readonly bulkOperationId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One course's row on a report card - see `ReportCardSnapshot`. */
export interface ReportCardCourseRow {
  readonly sectionId: string;
  readonly courseId: string;
  readonly courseCode: string;
  readonly courseName: string;
  readonly credits: number | null;
  readonly percentage: number | null;
  readonly letter: string | null;
  readonly gpaPoints: number | null;
  readonly gradeScaleVersionId: string | null;
}

/** Attendance over the grading period, if `@sms/records` was wired to an `AttendanceSummaryProvider` - see `application/attendance-summary-provider.ts`. `null` when unavailable, never a fabricated zero. */
export interface ReportCardAttendanceSummary {
  readonly totalCount: number;
  readonly presentCount: number;
  /** 0-100, rounded to one decimal place. `0` when `totalCount` is `0`, never `NaN`. */
  readonly presentRate: number;
}

/**
 * The FULL computed report - what `previewReportCard` returns and what
 * `issueReportCards` freezes into `records.report_card.snapshot` and hands to
 * `@sms/documents`' `DocumentsContract.generate` as `data`. See the `1200`
 * migration header: an issued report card is a snapshot, not a live view -
 * this is the exact shape that gets frozen.
 */
export interface ReportCardSnapshot {
  readonly personId: PersonId;
  readonly studentName: string;
  readonly gradingPeriodId: string;
  readonly gradingPeriodName: string;
  readonly termId: string;
  readonly termName: string;
  readonly academicYearId: AcademicYearId | null;
  readonly academicYearName: string | null;
  readonly courses: readonly ReportCardCourseRow[];
  /** Weighted by credits from the rows above - see `application/gpa.ts`. `null` when nothing is gradeable yet. */
  readonly gpa: number | null;
  readonly attendanceSummary: ReportCardAttendanceSummary | null;
  readonly comments: string | null;
  /** ISO instant - when this snapshot was computed. */
  readonly generatedAt: string;
}

/** Mirrors `records.report_card` - one issued report card for one student in one run. */
export interface ReportCard {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly reportCardRunId: string;
  readonly personId: PersonId;
  readonly enrollmentId: string | null;
  readonly documentId: string;
  readonly snapshot: ReportCardSnapshot;
  readonly gpa: number | null;
  readonly createdAt: Date;
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

/**
 * Mirrors `records.transcript_entry` - the permanent, append-only academic
 * record. `percentage`/`letter`/`gpaPoints` are resolved and copied in ONCE
 * at finalise time - see the `1200` migration header. Never mutate this
 * shape in place; a correction is a future finalisation of a NEW row, not an
 * edit of an existing one (this module has no correction workflow of its
 * own - see the module report).
 */
export interface TranscriptEntry {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly academicYearId: AcademicYearId;
  readonly termId: string;
  readonly courseId: string;
  readonly sectionId: string;
  readonly courseCode: string;
  readonly courseName: string;
  readonly creditsAttempted: number;
  readonly creditsEarned: number;
  readonly percentage: number | null;
  readonly letter: string | null;
  readonly gpaPoints: number | null;
  readonly gradeScaleVersionId: string | null;
  readonly finalisedAt: Date;
}

/** What `getTranscript` returns - the full academic history plus cumulative totals. */
export interface Transcript {
  readonly personId: PersonId;
  readonly entries: readonly TranscriptEntry[];
  /** Weighted by `creditsAttempted`, computed from stored `gpaPoints` only - never by re-resolving letters. `null` when no entry carries a `gpaPoints`. */
  readonly cumulativeGpa: number | null;
  readonly cumulativeCreditsAttempted: number;
  readonly cumulativeCreditsEarned: number;
}

// ---------------------------------------------------------------------------
// Credit rule sets (rules as data)
// ---------------------------------------------------------------------------

/** Mirrors `records.credit_rule_set`. */
export interface CreditRuleSet {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly isDefault: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One grade level's override of the default requirement - keyed by `academic.grade_level.id` in `CreditRules.gradeLevelOverrides`. */
export interface CreditRuleOverride {
  readonly requiredCredits: number;
  readonly minGpa?: number | null;
}

/** The JSON structure `records.credit_rule_set_version.rules` holds - the ONLY input `checkPromotionEligibility` reasons about. */
export interface CreditRules {
  readonly defaultRequiredCredits: number;
  readonly minGpa: number | null;
  readonly gradeLevelOverrides?: Readonly<Record<string, CreditRuleOverride>>;
}

/** Mirrors `records.credit_rule_set_version` - IMMUTABLE, same posture as `gradebook.CalculationRuleSetVersion`. */
export interface CreditRuleSetVersion {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly creditRuleSetId: string;
  readonly version: number;
  readonly rules: CreditRules;
  readonly effectiveFrom: DateOnly;
  readonly createdAt: Date;
}

/** What `checkPromotionEligibility` returns. */
export interface PromotionEligibility {
  readonly personId: PersonId;
  readonly academicYearId: AcademicYearId;
  readonly eligible: boolean;
  readonly creditsEarned: number;
  readonly creditsRequired: number;
  readonly gpa: number | null;
  readonly minGpaRequired: number | null;
  readonly reasons: readonly string[];
  readonly ruleSetVersionId: string | null;
}

export type GpaScope = 'term' | 'year' | 'cumulative';
export const GPA_SCOPES: readonly GpaScope[] = ['term', 'year', 'cumulative'];
