import { format, parse } from 'date-fns';
import type { BadgeProps } from '@sms/ui';
import type { EnrollmentStatus } from '../../../lib/api';

/** Today as a `YYYY-MM-DD` local-calendar-date string - what every `DateOnly` query param expects. Same helper as attendance/format.ts's `todayIso`, duplicated rather than imported across route boundaries (see that file). */
export function todayIso(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

/** `value` is a wall-clock `HH:MM:SS` (Postgres `time`) - parsed against an arbitrary reference date purely to format it. */
export function formatTimeOfDay(value: string): string {
  return format(parse(value, 'HH:mm:ss', new Date()), 'h:mm a');
}

/**
 * `academic.section_meeting` rows in the seed only ever run Monday (1),
 * Wednesday (3) or Friday (5) - see libs/domain/academic/src/seed.ts, which
 * hardcodes exactly those three ISO days for every section. A "0 sections
 * today" reading on any OTHER day is not a real zero - there was never
 * anything scheduled to find - so cards that report on today's sessions use
 * this to phrase that truthfully instead of implying an empty register.
 */
const SECTION_MEETING_DAYS = new Set([1, 3, 5]);

export function isSectionMeetingDay(date: Date = new Date()): boolean {
  // getDay(): 0 = Sunday..6 = Saturday: convert to ISO (1 = Monday..7 = Sunday).
  const iso = date.getDay() === 0 ? 7 : date.getDay();
  return SECTION_MEETING_DAYS.has(iso);
}

type BadgeVariant = NonNullable<BadgeProps['variant']>;

/** Same palette as enrollment/format.ts's ENROLLMENT_STATUS_BADGE_VARIANT - duplicated locally rather than imported across the route boundary (each route folder keeps its own small copy, matching this codebase's existing pattern - see attendance/format.ts and enrollment/format.ts). */
export const ENROLLMENT_STATUS_BADGE_VARIANT: Record<EnrollmentStatus, BadgeVariant> = {
  applied: 'info',
  enrolled: 'success',
  withdrawn: 'neutral',
  transferred_out: 'neutral',
  graduated: 'success',
};

export const ENROLLMENT_STATUS_LABELS: Record<EnrollmentStatus, string> = {
  applied: 'Applied',
  enrolled: 'Enrolled',
  withdrawn: 'Withdrawn',
  transferred_out: 'Transferred out',
  graduated: 'Graduated',
};

export const CONFLICT_KIND_LABELS: Record<'room' | 'teacher', string> = {
  room: 'Room double-booked',
  teacher: 'Teacher double-booked',
};
