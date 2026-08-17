import type { CampusId, DateOnly, PersonId, TenantId, UserId } from '@sms/kernel';

/**
 * The fixed system vocabulary a code's `category` must be one of - what
 * `attendance.marked_absent`'s trigger condition (category === 'absent') and
 * `getAttendanceSummary`'s per-category counts reason about. The LABEL a
 * school actually shows ("Late - bus", "Off-site sports") is free text on
 * `AttendanceCode.label` - see the `0900` migration header for why this is
 * config, not an enum.
 */
export type AttendanceCategory = 'present' | 'absent' | 'late' | 'excused';
export const ATTENDANCE_CATEGORIES: readonly AttendanceCategory[] = ['present', 'absent', 'late', 'excused'];

/** Mirrors `attendance.code`. Tenant-owned; see the `0900` migration header. */
export interface AttendanceCode {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly code: string;
  readonly label: string;
  readonly category: AttendanceCategory;
  readonly countsAsPresent: boolean;
  readonly isDefault: boolean;
  readonly requiresReason: boolean;
  readonly sequence: number;
  readonly active: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Mirrors `attendance.record`: the CURRENT state of one person's attendance
 * for one date (and, for period attendance, one section meeting).
 * `sectionId`/`sectionMeetingId` are both null for daily (no-section)
 * attendance. Editable in place only inside the free-edit lock window (see
 * `AttendanceRecordService`'s own comment); past it, only an APPROVED
 * `AttendanceCorrection` may change `codeId`.
 */
export interface AttendanceRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly sectionId: string | null;
  readonly sectionMeetingId: string | null;
  readonly date: DateOnly;
  readonly codeId: string;
  readonly minutesLate: number | null;
  readonly note: string | null;
  readonly markedByUserId: UserId | null;
  readonly markedAt: Date;
}

export type CorrectionStatus = 'pending' | 'approved' | 'rejected';
export const CORRECTION_STATUSES: readonly CorrectionStatus[] = ['pending', 'approved', 'rejected'];

/**
 * Mirrors `attendance.correction`: an append-only request to change a
 * locked `AttendanceRecord` from one code to another - same idea as
 * `enrollment.status_event`, see the `0900` migration header. `status`/
 * `decidedByUserId`/`decidedAt`/`reason` are the only fields ever updated
 * (the decision); everything else about the original request is immutable,
 * enforced in the database (`trg_forbid_correction_update`/`_delete`).
 */
export interface AttendanceCorrection {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly recordId: string;
  readonly fromCodeId: string;
  readonly toCodeId: string;
  readonly reason: string | null;
  readonly requestedByUserId: UserId | null;
  readonly status: CorrectionStatus;
  readonly decidedByUserId: UserId | null;
  readonly decidedAt: Date | null;
  readonly createdAt: Date;
}

/** Mirrors `attendance.submission`: the idempotency ledger `markSession` writes to once per NEW (non-replayed) call - see `AttendanceRecordService.markSession`. */
export interface AttendanceSubmission {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly idempotencyKey: string;
  readonly sectionMeetingId: string;
  readonly date: DateOnly;
  readonly submittedByUserId: UserId | null;
  readonly recordCount: number;
  readonly createdAt: Date;
}

/** One student on a session roster, pre-filled with any mark already recorded for this exact (person, sectionMeetingId, date). */
export interface RosterEntry {
  readonly personId: PersonId;
  readonly givenName: string;
  readonly familyName: string;
  readonly existingRecordId: string | null;
  readonly codeId: string | null;
  readonly minutesLate: number | null;
  readonly note: string | null;
}

/** What a `sectionMeetingId` resolves to - section, period and (for scope-constraint checks) campus. Used both by `getSessionRoster`/`markSession` internally and by `apps/api`'s `AttendanceController` to authorize a request against a specific meeting before acting on it (see that file's own comment). */
export interface SectionMeetingContext {
  readonly sectionId: string;
  readonly periodId: string;
  readonly periodName: string;
  readonly campusId: CampusId;
}

/** What `getSessionRoster` returns - the marking screen's own data source. */
export interface SessionRoster {
  readonly sectionMeetingId: string;
  readonly sectionId: string;
  readonly date: DateOnly;
  readonly periodId: string;
  readonly periodName: string;
  readonly entries: readonly RosterEntry[];
}

/** One class that has not yet had attendance submitted for `date` - what `listUnmarkedSessions` reports. */
export interface UnmarkedSession {
  readonly sectionMeetingId: string;
  readonly sectionId: string;
  readonly sectionCode: string;
  readonly sectionName: string;
  readonly campusId: CampusId;
  readonly periodId: string;
  readonly periodName: string;
  readonly date: DateOnly;
}

/** What `getAttendanceSummary` reports: counts by category and a derived attendance percentage over `[from, to]`. */
export interface AttendanceSummary {
  readonly personId: PersonId;
  readonly from: DateOnly;
  readonly to: DateOnly;
  readonly totalCount: number;
  /** `sum(code.counts_as_present)` - not just the `present` category, since a school may mark e.g. `late` as still counting toward presence. */
  readonly presentCount: number;
  readonly countsByCategory: Record<AttendanceCategory, number>;
  /** `0` when `totalCount` is `0` (nothing marked yet in the range) - never `NaN`. Rounded to one decimal place. */
  readonly attendancePercentage: number;
}
