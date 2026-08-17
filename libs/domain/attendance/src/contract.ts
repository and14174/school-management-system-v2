import type { CampusId, DateOnly, DomainError, NotFoundError, PersonId, Result } from '@sms/kernel';
import type {
  AttendanceCategory,
  AttendanceCode,
  AttendanceCorrection,
  AttendanceRecord,
  AttendanceSubmission,
  AttendanceSummary,
  CorrectionStatus,
  SectionMeetingContext,
  SessionRoster,
  UnmarkedSession,
} from './domain/types.js';

export * from './domain/types.js';

export interface CreateCodeInput {
  readonly code: string;
  readonly label: string;
  readonly category: AttendanceCategory;
  readonly countsAsPresent?: boolean;
  readonly isDefault?: boolean;
  readonly requiresReason?: boolean;
  readonly sequence?: number;
}
export type UpdateCodeInput = Partial<Omit<CreateCodeInput, 'code'>> & { readonly active?: boolean };

export interface MarkInput {
  readonly personId: PersonId;
  readonly codeId: string;
  readonly minutesLate?: number | null;
  readonly note?: string | null;
}

export interface MarkSessionInput {
  readonly sectionMeetingId: string;
  readonly date: DateOnly;
  /** Client-supplied. A replay of the same key is a no-op - see `AttendanceRecordService.markSession`. */
  readonly idempotencyKey: string;
  readonly marks: readonly MarkInput[];
}

export interface MarkSessionResult {
  readonly records: readonly AttendanceRecord[];
  readonly submission: AttendanceSubmission;
  /** `true` when `idempotencyKey` had already been submitted - the returned `records`/`submission` are the ORIGINAL result, and nothing was written this call. */
  readonly replayed: boolean;
}

export interface GetSessionRosterInput {
  readonly sectionMeetingId: string;
  readonly date: DateOnly;
}

export interface RequestCorrectionInput {
  readonly recordId: string;
  readonly toCodeId: string;
  readonly reason?: string | null;
}

export interface DecideCorrectionInput {
  readonly correctionId: string;
  readonly approve: boolean;
  /** Optional decision rationale - overwrites `AttendanceCorrection.reason` (the original request's reason is still recoverable from `audit.record_history`, since this table is audited - see the `0900` migration). */
  readonly reason?: string | null;
}

export interface ListCorrectionsInput {
  readonly status?: CorrectionStatus;
}

export interface GetAttendanceSummaryInput {
  readonly personId: PersonId;
  readonly from: DateOnly;
  readonly to: DateOnly;
}

export interface ListUnmarkedSessionsInput {
  readonly date: DateOnly;
  readonly campusId?: CampusId;
}

/**
 * The public port this module exposes to the rest of the system
 * (`apps/api`'s `AttendanceController`) - matching `@sms/enrollment`'s
 * `EnrollmentContract` pattern: every other module should depend on this
 * interface, not on the concrete `AttendanceService` behind it.
 *
 * Every method resolves the ambient ordinary tenant context
 * (`currentTenantContext()`) - `AttendanceService` (the implementation
 * behind this interface) is the REST-facing facade; the individual services
 * it composes take `tenantId` explicitly so they also work from `seed.ts`
 * and from tests with no ambient context at all.
 */
export interface AttendanceContract {
  createCode(input: CreateCodeInput): Promise<Result<AttendanceCode, DomainError>>;
  updateCode(id: string, input: UpdateCodeInput): Promise<Result<AttendanceCode, DomainError>>;
  listCodes(): Promise<AttendanceCode[]>;

  /**
   * The teacher's bulk submit. One transaction: upsert every record in
   * `marks`, write the `attendance.submission` row, and publish one
   * `attendance.marked_absent` event per mark whose resolved code's
   * `category` is `'absent'` - all through the SAME transaction (see
   * `@sms/outbox`'s `OutboxContract.publish` doc comment: it is handed the
   * caller's transaction for exactly this reason). A replayed
   * `idempotencyKey` returns the ORIGINAL result and writes nothing further.
   */
  markSession(input: MarkSessionInput): Promise<Result<MarkSessionResult, DomainError>>;

  /** The roster to mark: every currently-enrolled student in the meeting's section, pre-filled with any existing mark for `date`. What the marking screen loads. */
  getSessionRoster(input: GetSessionRosterInput): Promise<Result<SessionRoster, NotFoundError>>;

  /** Resolves `sectionMeetingId` to its section/period/campus - `null` if not found. Used by `apps/api`'s `AttendanceController` to authorize a request against a specific meeting (section/campus scope) before acting on it. */
  getMeetingContext(sectionMeetingId: string, date: DateOnly): Promise<SectionMeetingContext | null>;

  /** Requests a correction for a record locked past the free-edit window. `fromCodeId` is resolved from the record's current code, not accepted as input, so it can never be misattributed. */
  requestCorrection(input: RequestCorrectionInput): Promise<Result<AttendanceCorrection, DomainError>>;
  /** Approving applies `toCodeId` to the underlying record in the SAME transaction as the decision - the only way to change a locked record (see the `0900` migration header). Rejecting decides without touching the record. */
  decideCorrection(input: DecideCorrectionInput): Promise<Result<AttendanceCorrection, DomainError>>;
  listCorrections(input?: ListCorrectionsInput): Promise<AttendanceCorrection[]>;

  /** Counts by category and a derived attendance percentage for `personId` over `[from, to]`. */
  getAttendanceSummary(input: GetAttendanceSummaryInput): Promise<AttendanceSummary>;

  /** Sections meeting on `date` (by day-of-week) with no `attendance.submission` yet - the single most-used administrative view in a real school. */
  listUnmarkedSessions(input: ListUnmarkedSessionsInput): Promise<UnmarkedSession[]>;
}

/**
 * DI token for `AttendanceContract` - see `TENANCY_CONTRACT` in `@sms/tenancy`
 * for why a concrete Symbol token is used instead of relying on implicit
 * type-based DI.
 */
export const ATTENDANCE_CONTRACT = Symbol('ATTENDANCE_CONTRACT');
