import type { AcademicYearId, CampusId, DateOnly, DomainError, NotFoundError, PersonId, Result } from '@sms/kernel';
import type { Enrollment, EnrollmentPage, EnrollmentStatus, RolloverResult, StatusEvent } from './domain/types.js';

export * from './domain/types.js';

export interface EnrolStudentInput {
  readonly personId: PersonId;
  readonly academicYearId: AcademicYearId;
  readonly campusId: CampusId;
  readonly gradeLevelId: string;
  /** Defaults to today. */
  readonly enrolledOn?: DateOnly;
  readonly studentNumber?: string | null;
}

export interface TransitionStatusInput {
  readonly enrollmentId: string;
  readonly toStatus: EnrollmentStatus;
  readonly effectiveOn: DateOnly;
  readonly reason?: string | null;
}

export interface ListEnrollmentsInput {
  readonly academicYearId?: AcademicYearId;
  readonly campusId?: CampusId;
  readonly gradeLevelId?: string;
  readonly status?: EnrollmentStatus;
  /** Free-text match against the enrolled person's name or student number. */
  readonly query?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface TransferCampusInput {
  readonly enrollmentId: string;
  readonly toCampusId: CampusId;
  readonly effectiveOn: DateOnly;
}

export interface RollOverYearInput {
  readonly fromAcademicYearId: AcademicYearId;
  readonly toAcademicYearId: AcademicYearId;
  /** `fromGradeLevelId -> toGradeLevelId`. A grade level with no entry is skipped (recorded as `skipped_no_mapping` in the outcome), never guessed at. */
  readonly promotionMap: Readonly<Record<string, string>>;
  /** When `true`, computes and returns exactly what a real run would do/return, but writes nothing at all - see `RolloverService`. */
  readonly dryRun?: boolean;
}

/**
 * The public port this module exposes to the rest of the system
 * (`apps/api`'s `EnrollmentsController`/`RolloverController`) - matching
 * `@sms/academic`'s `AcademicContract` pattern: every other module should
 * depend on this interface, not on the concrete `EnrollmentService` behind
 * it.
 *
 * Every method resolves the ambient ordinary tenant context
 * (`currentTenantContext()`) - `EnrollmentService` (the implementation
 * behind this interface) is the REST-facing facade; the individual services
 * it composes (`EnrollmentRecordService`/`RolloverService`) take `tenantId`
 * explicitly so they also work from `seed.ts` and from tests with no ambient
 * context at all.
 */
export interface EnrollmentContract {
  /** Creates a new `enrolled` enrolment for `personId` in `academicYearId` and writes its opening `StatusEvent` (`fromStatus: null`) in the same transaction. */
  enrolStudent(input: EnrolStudentInput): Promise<Result<Enrollment, DomainError>>;

  /**
   * Validates `enrollmentId`'s current status legally transitions to
   * `toStatus` (see `isLegalStatusTransition`), then appends a `StatusEvent`
   * and updates the enrolment's denormalised `status` in the SAME
   * transaction - the history is never overwritten, only ever appended to.
   */
  transitionStatus(input: TransitionStatusInput): Promise<Result<Enrollment, DomainError>>;

  getEnrollment(id: string): Promise<Result<Enrollment, NotFoundError>>;
  listEnrollments(input?: ListEnrollmentsInput): Promise<EnrollmentPage>;
  /** Every `StatusEvent` for `enrollmentId`, oldest first - the full, unedited history. */
  getStatusHistory(enrollmentId: string): Promise<StatusEvent[]>;

  transferCampus(input: TransferCampusInput): Promise<Result<Enrollment, DomainError>>;

  /**
   * Creates next-year enrolments for every currently-`enrolled` student in
   * `fromAcademicYearId`, promoting each to the grade level `promotionMap`
   * names for their current one. See `RollOverYearInput.dryRun`'s own
   * comment, and `RolloverService` for the full contract this method
   * upholds (same code path for preview and commit, `AuditContract.
   * withBulkOperation`, refuses a non-writable target year).
   */
  rollOverYear(input: RollOverYearInput): Promise<Result<RolloverResult, DomainError>>;
}

/**
 * DI token for `EnrollmentContract` - see `TENANCY_CONTRACT` in `@sms/tenancy`
 * for why a concrete Symbol token is used instead of relying on implicit
 * type-based DI.
 */
export const ENROLLMENT_CONTRACT = Symbol('ENROLLMENT_CONTRACT');
