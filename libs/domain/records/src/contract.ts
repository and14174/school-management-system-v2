import type { AcademicYearId, DateOnly, DomainError, NotFoundError, PersonId, Result } from '@sms/kernel';
import type {
  CreditRules,
  CreditRuleSet,
  CreditRuleSetVersion,
  GpaScope,
  PromotionEligibility,
  ReportCard,
  ReportCardRun,
  ReportCardSnapshot,
  Transcript,
  TranscriptEntry,
} from './domain/types.js';

export * from './domain/types.js';
export { ATTENDANCE_SUMMARY_PROVIDER, DEFAULT_ATTENDANCE_SUMMARY_PROVIDER, type AttendanceSummaryProvider } from './application/attendance-summary-provider.js';

// ---------------------------------------------------------------------------
// Report cards
// ---------------------------------------------------------------------------

export interface PreviewReportCardInput {
  readonly personId: PersonId;
  readonly gradingPeriodId: string;
}

export interface IssueReportCardsInput {
  readonly gradingPeriodId: string;
  /** Narrows which students get a report card this run to one section's roster - `undefined`/omitted means the whole school. Each resulting report card still covers every section that student takes - see the `1200` migration header. */
  readonly sectionId?: string;
  /** Client-supplied. A replay of the same key is a no-op - see `ReportCardService.issueReportCards`. */
  readonly idempotencyKey: string;
}

export interface IssueReportCardsResult {
  readonly run: ReportCardRun;
  readonly reportCards: readonly ReportCard[];
  /** `true` when `idempotencyKey` had already been submitted - the returned `run`/`reportCards` are the ORIGINAL result, and nothing was written this call. */
  readonly replayed: boolean;
}

export interface ListReportCardsInput {
  readonly personId?: PersonId;
  readonly runId?: string;
}

/** Resolves a report card id to the data a controller needs to authorize a request against it - same idiom as `@sms/gradebook`'s `getAssignmentContext`. */
export interface ReportCardContext {
  readonly personId: PersonId;
  readonly sectionId: string | null;
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

export interface FinaliseTranscriptEntriesInput {
  readonly personId: PersonId;
  readonly termId: string;
}

export interface CalculateGpaInput {
  readonly personId: PersonId;
  readonly scope: GpaScope;
  /** Required when `scope: 'term'`. */
  readonly termId?: string;
  /** Required when `scope: 'year'`. */
  readonly academicYearId?: AcademicYearId;
}

export interface CheckPromotionEligibilityInput {
  readonly personId: PersonId;
  readonly academicYearId: AcademicYearId;
}

// ---------------------------------------------------------------------------
// Credit rule sets
// ---------------------------------------------------------------------------

export interface CreateCreditRuleSetInput {
  readonly name: string;
  readonly isDefault?: boolean;
}

export interface PublishCreditRuleSetVersionInput {
  readonly creditRuleSetId: string;
  readonly rules: CreditRules;
  /** Defaults to today. */
  readonly effectiveFrom?: DateOnly;
}

/**
 * The public port this module exposes to the rest of the system
 * (`apps/api`'s `RecordsController`) - matching `@sms/gradebook`'s
 * `GradebookContract` pattern: every other module should depend on this
 * interface, not on the concrete `RecordsService` behind it.
 *
 * Every method resolves the ambient ordinary tenant context
 * (`currentTenantContext()`) - `RecordsService` (the implementation behind
 * this interface) is the REST-facing facade; the individual services it
 * composes take `tenantId` explicitly so they also work from `seed.ts` and
 * from tests with no ambient context at all.
 */
export interface RecordsContract {
  // --- Report cards -----------------------------------------------------

  /** The computed snapshot a report card WOULD contain, without issuing or writing anything - the exact same computation `issueReportCards` freezes. */
  previewReportCard(input: PreviewReportCardInput): Promise<Result<ReportCardSnapshot, DomainError>>;

  /**
   * Runs inside `AuditContract.withBulkOperation`: generates one document per
   * student via `@sms/documents`' `DocumentsContract.generate`, writes one
   * `records.report_card` row per student, and publishes
   * `records.report_card_issued` through the outbox - all on the SAME
   * transaction, all stamped with the SAME `bulk_operation_id`. Idempotent on
   * `idempotencyKey` - a replay returns the ORIGINAL result and writes
   * nothing further, generates no document, and publishes no event.
   */
  issueReportCards(input: IssueReportCardsInput): Promise<Result<IssueReportCardsResult, DomainError>>;

  getReportCard(id: string): Promise<Result<ReportCard, NotFoundError>>;
  /** Exactly one of `personId`/`runId` should be supplied. Newest first. */
  listReportCards(input: ListReportCardsInput): Promise<ReportCard[]>;
  getReportCardContext(id: string): Promise<ReportCardContext | null>;

  // --- Transcripts --------------------------------------------------------

  /**
   * Writes the immutable `records.transcript_entry` rows for `termId`'s
   * computed grades - one per section `personId` completed that term -
   * carrying each grade's `grade_scale_version_id` through unchanged.
   * Idempotent per `(personId, sectionId)`: re-finalising a section already
   * finalised is a no-op, never a duplicate row or a silent overwrite.
   */
  finaliseTranscriptEntries(input: FinaliseTranscriptEntriesInput): Promise<Result<readonly TranscriptEntry[], DomainError>>;

  /** The full academic history, with cumulative GPA and credits - computed ONLY from stored `gpaPoints`/credits, never by re-resolving letters against a scale. See the `1200` migration header. */
  getTranscript(personId: PersonId): Promise<Transcript>;

  /** Weighted by credits, computed from stored `gpaPoints` only. `null` when the scope has no qualifying entries. */
  calculateGpa(input: CalculateGpaInput): Promise<number | null>;

  checkPromotionEligibility(input: CheckPromotionEligibilityInput): Promise<Result<PromotionEligibility, DomainError>>;

  // --- Credit rule sets (rules as data) ----------------------------------

  createCreditRuleSet(input: CreateCreditRuleSetInput): Promise<Result<CreditRuleSet, DomainError>>;
  listCreditRuleSets(): Promise<CreditRuleSet[]>;
  /** Creates a NEW immutable `CreditRuleSetVersion` - editing a rule set never touches an existing version or any decision already made against it. */
  publishCreditRuleSetVersion(input: PublishCreditRuleSetVersionInput): Promise<Result<CreditRuleSetVersion, DomainError>>;
  listCreditRuleSetVersions(creditRuleSetId: string): Promise<CreditRuleSetVersion[]>;
}

/**
 * DI token for `RecordsContract` - see `TENANCY_CONTRACT` in `@sms/tenancy`
 * for why a concrete Symbol token is used instead of relying on implicit
 * type-based DI.
 */
export const RECORDS_CONTRACT = Symbol('RECORDS_CONTRACT');
