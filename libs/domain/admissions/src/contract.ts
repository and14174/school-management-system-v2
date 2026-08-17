import type { AcademicYearId, CampusId, DateOnly, DomainError, NotFoundError, PersonId, Result } from '@sms/kernel';
import type {
  Application,
  ApplicationDecision,
  ApplicationPage,
  ApplicationStage,
  ApplicationStageEvent,
  ConversionOutcome,
  DecisionOutcome,
} from './domain/types.js';

export * from './domain/types.js';

export interface SubmitApplicationInput {
  /** OPTIONAL - set only when the family is already known (a sibling applying, a re-application). See this module's `1500` migration header, point 1. */
  readonly personId?: PersonId;
  readonly applicantGivenName: string;
  readonly applicantFamilyName: string;
  readonly applicantDateOfBirth?: DateOnly | null;
  readonly applicantGender?: string | null;
  readonly guardianName?: string | null;
  readonly guardianEmail?: string | null;
  readonly guardianPhone?: string | null;
  readonly desiredAcademicYearId: AcademicYearId;
  readonly desiredCampusId: CampusId;
  readonly desiredGradeLevelId: string;
  readonly source?: string | null;
}

export interface MoveStageInput {
  readonly applicationId: string;
  readonly toStage: ApplicationStage;
  readonly note?: string | null;
  /** Defaults to today. */
  readonly occurredOn?: DateOnly;
}

export interface RecordDecisionInput {
  readonly applicationId: string;
  readonly outcome: DecisionOutcome;
  readonly reason?: string | null;
  /** Defaults to today. */
  readonly decidedOn?: DateOnly;
}

export interface RecordDecisionResult {
  readonly application: Application;
  readonly decision: ApplicationDecision;
  /** Populated only when `outcome === 'accepted'` - see `ConversionOutcome`'s own comment. */
  readonly conversion: ConversionOutcome | null;
}

export interface ListApplicationsInput {
  readonly stage?: ApplicationStage;
  readonly campusId?: CampusId;
  readonly academicYearId?: AcademicYearId;
  /** Free-text match against the applicant's name. */
  readonly query?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * The public port this module exposes to the rest of the system
 * (`apps/api`'s `AdmissionsController`) - matching `@sms/enrollment`'s
 * `EnrollmentContract` pattern: every other module should depend on this
 * interface, not on the concrete `AdmissionsService` behind it.
 *
 * Every method resolves the ambient ordinary tenant context
 * (`currentTenantContext()`) - `AdmissionsService` (the implementation behind
 * this interface) is the REST-facing facade; the individual services it
 * composes (`ApplicationRecordService`/`DecisionService`) take `tenantId`
 * explicitly so they also work from `seed.ts` and from tests with no ambient
 * context at all.
 */
export interface AdmissionsContract {
  /** Creates a new `enquiry`-stage application and writes its opening `ApplicationStageEvent` (`fromStage: null`) in the same transaction. Publishes `admissions.application_submitted` through `OutboxContract.publish` in that same transaction. */
  submitApplication(input: SubmitApplicationInput): Promise<Result<Application, DomainError>>;

  /**
   * Clerical pipeline progression only (`enquiry -> applied -> assessment`) -
   * `admissions.application:write`-gated. Validates the move is legal (see
   * `isLegalStageMove`), then appends an `ApplicationStageEvent` and updates
   * the application's denormalised `currentStage` in the SAME transaction -
   * the history is never overwritten, only ever appended to.
   */
  moveStage(input: MoveStageInput): Promise<Result<Application, DomainError>>;

  /**
   * Consequential outcomes (`offered`/`accepted`/`rejected`/`withdrawn`) -
   * `admissions.application:decide`-gated. Validates the decision is legal
   * (see `isLegalDecision`), then appends an `ApplicationDecision` and
   * updates `currentStage` in the SAME transaction. Publishes
   * `admissions.decision_recorded` through `OutboxContract.publish` in that
   * same transaction.
   *
   * When `outcome === 'accepted'`, ALSO hands the applicant to
   * `@sms/enrollment` (creating a `people.person` first if none is linked
   * yet) - idempotently: accepting the same application twice produces
   * exactly one `people.person` and one enrolment. See `DecisionService.
   * ensureConverted` and this module's `1500` migration header, point 3.
   */
  recordDecision(input: RecordDecisionInput): Promise<Result<RecordDecisionResult, DomainError>>;

  getApplication(id: string): Promise<Result<Application, NotFoundError>>;
  listApplications(input?: ListApplicationsInput): Promise<ApplicationPage>;
  /** Every `ApplicationStageEvent` for `applicationId`, oldest first - the full, unedited clerical trail. */
  getStageHistory(applicationId: string): Promise<ApplicationStageEvent[]>;
  /** Every `ApplicationDecision` for `applicationId`, oldest first - the full, unedited decision trail. */
  getDecisionHistory(applicationId: string): Promise<ApplicationDecision[]>;
}

/**
 * DI token for `AdmissionsContract` - see `TENANCY_CONTRACT` in `@sms/tenancy`
 * for why a concrete Symbol token is used instead of relying on implicit
 * type-based DI.
 */
export const ADMISSIONS_CONTRACT = Symbol('ADMISSIONS_CONTRACT');
