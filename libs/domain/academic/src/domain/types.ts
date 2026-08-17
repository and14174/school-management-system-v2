import type { AcademicYearId, CampusId, DateOnly, PersonId, TenantId } from '@sms/kernel';

export type SectionTeacherRole = 'lead' | 'assistant';
export const SECTION_TEACHER_ROLES: readonly SectionTeacherRole[] = ['lead', 'assistant'];

export type SectionEnrollmentStatus = 'active' | 'transferred' | 'withdrawn' | 'completed';
export const SECTION_ENROLLMENT_STATUSES: readonly SectionEnrollmentStatus[] = [
  'active',
  'transferred',
  'withdrawn',
  'completed',
];

/** Mirrors `academic.term`. Writes are gated by `tenancy.assert_year_writable` - see the `0600` migration. */
export interface Term {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly academicYearId: AcademicYearId;
  readonly name: string;
  readonly startsOn: DateOnly;
  readonly endsOn: DateOnly;
  readonly sequence: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `academic.grading_period`. */
export interface GradingPeriod {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly termId: string;
  readonly name: string;
  readonly startsOn: DateOnly;
  readonly endsOn: DateOnly;
  readonly sequence: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `academic.grade_level`. */
export interface GradeLevel {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly code: string;
  readonly name: string;
  readonly sequence: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `academic.department`. */
export interface Department {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly code: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `academic.subject`. */
export interface Subject {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly departmentId: string;
  readonly code: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `academic.course`. */
export interface Course {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly subjectId: string;
  readonly gradeLevelId: string;
  readonly code: string;
  readonly name: string;
  readonly credits: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `academic.room`. */
export interface Room {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly campusId: CampusId;
  readonly code: string;
  readonly name: string;
  readonly capacity: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Mirrors `academic.section`. Structure only - no meeting times/bell
 * schedule (timetabling is a later milestone). Writes are gated by
 * `tenancy.assert_year_writable`, resolved via `termId -> term.academicYearId`.
 */
export interface Section {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly courseId: string;
  readonly termId: string;
  readonly campusId: CampusId;
  readonly roomId: string | null;
  readonly code: string;
  readonly name: string;
  readonly capacity: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Mirrors `academic.section_teacher`. Effective-dated (`validFrom`/`validTo`
 * both inclusive, matching `@sms/kernel`'s `Interval`) - teachers change
 * mid-year. This is the fact `SectionScopeResolverService` (this module's
 * implementation of `@sms/access`'s `SECTION_SCOPE_RESOLVER` port) reads.
 */
export interface SectionTeacher {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly sectionId: string;
  readonly personId: PersonId;
  readonly role: SectionTeacherRole;
  readonly validFrom: DateOnly;
  readonly validTo: DateOnly | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Mirrors `academic.section_enrollment`. Effective-dated - students move
 * sections mid-year, and last term's gradebook must not change when they do.
 */
export interface SectionEnrollment {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly sectionId: string;
  readonly personId: PersonId;
  readonly validFrom: DateOnly;
  readonly validTo: DateOnly | null;
  readonly status: SectionEnrollmentStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One student's current enrollment in a section, enriched with the name fields `listStudentsInSection` callers actually need. */
export interface SectionStudent {
  readonly enrollmentId: string;
  readonly personId: PersonId;
  readonly givenName: string;
  readonly familyName: string;
  readonly validFrom: DateOnly;
  readonly validTo: DateOnly | null;
  readonly status: SectionEnrollmentStatus;
}

// =============================================================================
// Scheduling / timetabling - see the `0610` migration header for the design
// rationale (conflict detection in the database, effective-dated meetings,
// room capacity as a warning not a hard failure).
// =============================================================================

/** ISO 8601 day-of-week: 1 = Monday ... 7 = Sunday. */
export type DayOfWeek = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** A wall-clock time of day, `HH:MM:SS` (no date, no timezone - matches Postgres `time`). */
export type TimeOfDay = string;

/** Mirrors `academic.bell_schedule`. */
export interface BellSchedule {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly campusId: CampusId;
  readonly academicYearId: AcademicYearId;
  readonly name: string;
  readonly isDefault: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `academic.period`. */
export interface Period {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly bellScheduleId: string;
  readonly name: string;
  readonly sequence: number;
  readonly startsAt: TimeOfDay;
  readonly endsAt: TimeOfDay;
  readonly isInstructional: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Mirrors `academic.section_meeting`: when a section actually meets.
 * Effective-dated (`validFrom`/`validTo`, both inclusive) - timetables
 * change mid-year. Room conflicts are rejected by a database exclusion
 * constraint; teacher conflicts by a trigger (see the `0610` migration) -
 * neither is only an application-level promise.
 */
export interface SectionMeeting {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly sectionId: string;
  readonly periodId: string;
  readonly dayOfWeek: DayOfWeek;
  readonly roomId: string | null;
  readonly validFrom: DateOnly;
  readonly validTo: DateOnly | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `academic.substitution`: one meeting, one date, covered by someone other than the usually-assigned teacher. */
export interface Substitution {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly sectionMeetingId: string;
  readonly date: DateOnly;
  readonly absentPersonId: PersonId;
  readonly substitutePersonId: PersonId;
  readonly reason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * One concrete occurrence of a section meeting on a specific calendar date -
 * what `getTimetableForTeacher`/`getTimetableForStudent`/`getRoomTimetable`
 * expand `section_meeting`'s (period, day_of_week, effective range) into
 * over a requested `[from, to]` window. `isSubstitute`/`substitutePersonId`/
 * `substituteReason` are populated when `academic.substitution` covers this
 * exact (sectionMeetingId, date).
 */
export interface TimetableEntry {
  readonly date: DateOnly;
  readonly dayOfWeek: DayOfWeek;
  readonly sectionMeetingId: string;
  readonly sectionId: string;
  readonly sectionCode: string;
  readonly sectionName: string;
  readonly periodId: string;
  readonly periodName: string;
  readonly startsAt: TimeOfDay;
  readonly endsAt: TimeOfDay;
  readonly roomId: string | null;
  readonly roomCode: string | null;
  /** `true` for the teacher entry when THIS date was covered by a substitute (i.e. `personId` was the absent teacher and did not actually teach it). */
  readonly isSubstituted: boolean;
  /** `true` for the teacher entry when `personId` covered this date AS a substitute, not as the usually-assigned teacher. */
  readonly isSubstituting: boolean;
  readonly substitutePersonId: PersonId | null;
  readonly substituteReason: string | null;
}

/** One teacher's weekly instructional load - what `getTeacherWorkload` reports, for spotting an overloaded timetable. */
export interface TeacherWorkload {
  readonly personId: PersonId;
  readonly givenName: string;
  readonly familyName: string;
  readonly periodsPerWeek: number;
  readonly sectionCount: number;
}

/** One detected room or teacher double-booking - what `detectConflicts` reports for data that predates the `0610` constraints (a bulk import, a direct SQL write). */
export interface ScheduleConflict {
  readonly kind: 'room' | 'teacher';
  readonly periodId: string;
  readonly dayOfWeek: DayOfWeek;
  readonly sectionMeetingIdA: string;
  readonly sectionIdA: string;
  readonly sectionMeetingIdB: string;
  readonly sectionIdB: string;
  /** Set for `kind: 'room'`. */
  readonly roomId: string | null;
  /** Set for `kind: 'teacher'`. */
  readonly personId: PersonId | null;
}
