import type { AcademicYearId, CampusId, DateOnly, PersonId, TenantId, UserId } from '@sms/kernel';

export type EnrollmentStatus = 'applied' | 'enrolled' | 'withdrawn' | 'graduated' | 'transferred_out';
export const ENROLLMENT_STATUSES: readonly EnrollmentStatus[] = [
  'applied',
  'enrolled',
  'withdrawn',
  'graduated',
  'transferred_out',
];

/** Terminal-ish statuses that record an exit: `enrollment.exited_on`/`exit_reason` are set on transition INTO one of these, cleared on transition into anything else (e.g. re-enrolment after a withdrawal). */
const EXIT_STATUSES: ReadonlySet<EnrollmentStatus> = new Set(['withdrawn', 'graduated', 'transferred_out']);
export function isExitStatus(status: EnrollmentStatus): boolean {
  return EXIT_STATUSES.has(status);
}

/**
 * The legal status graph. `graduated` and `transferred_out` are terminal (no
 * outgoing edges) - "cannot transition out of graduated" from the module
 * brief. A status never legally transitions to itself (re-enrolling someone
 * already `enrolled` is rejected) because no `LEGAL_STATUS_TRANSITIONS[x]`
 * set below contains `x`.
 */
const LEGAL_STATUS_TRANSITIONS: Record<EnrollmentStatus, ReadonlySet<EnrollmentStatus>> = {
  applied: new Set<EnrollmentStatus>(['enrolled', 'withdrawn']),
  enrolled: new Set<EnrollmentStatus>(['withdrawn', 'graduated', 'transferred_out']),
  withdrawn: new Set<EnrollmentStatus>(['enrolled']),
  graduated: new Set<EnrollmentStatus>([]),
  transferred_out: new Set<EnrollmentStatus>([]),
};

/** Whether `from -> to` is a legal enrolment status transition - see `LEGAL_STATUS_TRANSITIONS`' own comment. */
export function isLegalStatusTransition(from: EnrollmentStatus, to: EnrollmentStatus): boolean {
  return LEGAL_STATUS_TRANSITIONS[from].has(to);
}

/**
 * Mirrors `enrollment.enrollment`. One row per (person, academic_year):
 * which campus, grade level and school year a person belongs to. `status` is
 * denormalised from the newest `StatusEvent` for this enrolment - never
 * written on its own, always inside the same transaction that appends the
 * event (see `EnrollmentRecordService.transitionStatus`).
 */
export interface Enrollment {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly academicYearId: AcademicYearId;
  readonly campusId: CampusId;
  readonly gradeLevelId: string;
  readonly studentNumber: string | null;
  readonly status: EnrollmentStatus;
  readonly enrolledOn: DateOnly;
  readonly exitedOn: DateOnly | null;
  readonly exitReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `enrollment.status_event` - the immutable history `Enrollment.status` is only ever a cache of. Append-only in the database (see the `0700` migration); `fromStatus: null` marks the very first event for an enrolment. */
export interface StatusEvent {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly enrollmentId: string;
  readonly fromStatus: EnrollmentStatus | null;
  readonly toStatus: EnrollmentStatus;
  readonly effectiveOn: DateOnly;
  readonly reason: string | null;
  readonly actorUserId: UserId | null;
  readonly createdAt: Date;
}

export type RolloverRunStatus = 'running' | 'completed' | 'failed';

/** Mirrors `enrollment.rollover_run`. Only ever written for a REAL `rollOverYear` run - a `dryRun` writes nothing (see `RolloverService`). */
export interface RolloverRun {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly fromAcademicYearId: AcademicYearId;
  readonly toAcademicYearId: AcademicYearId;
  readonly bulkOperationId: string | null;
  readonly status: RolloverRunStatus;
  readonly counts: Record<string, unknown>;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}

export type RolloverOutcomeResult = 'promoted' | 'skipped_no_mapping' | 'skipped_already_enrolled';

/** What happened (or, for a `dryRun`, would happen) to one currently-enrolled student during a rollover. */
export interface RolloverOutcome {
  readonly personId: PersonId;
  readonly fromEnrollmentId: string;
  readonly toEnrollmentId: string | null;
  readonly fromGradeLevelId: string;
  readonly toGradeLevelId: string | null;
  readonly result: RolloverOutcomeResult;
}

export interface RolloverCounts {
  readonly consideredCount: number;
  readonly promotedCount: number;
  readonly skippedCount: number;
}

/**
 * What `rollOverYear` returns, for BOTH a `dryRun` preview and a real run -
 * the two are computed by the exact same code path (see `RolloverService`),
 * so this shape never differs by more than `dryRun`/`bulkOperationId`/
 * `rolloverRunId` themselves.
 */
export interface RolloverResult {
  readonly counts: RolloverCounts;
  readonly outcomes: readonly RolloverOutcome[];
  readonly bulkOperationId: string | null;
  readonly rolloverRunId: string | null;
  readonly dryRun: boolean;
}

export interface EnrollmentPage {
  readonly items: readonly Enrollment[];
  readonly nextCursor: string | null;
}
