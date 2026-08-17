import { format, parse, parseISO } from 'date-fns';
import type { BadgeProps } from '@sms/ui';
import type { AttendanceCategory } from '../../../lib/api';

/** Today as a `YYYY-MM-DD` local-calendar-date string - what the API's `DateOnly` params expect. */
export function todayIso(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

/** `date` is a `YYYY-MM-DD` `DateOnly` string - `parseISO` (unlike `new Date(...)`) reads it as a local calendar date, not UTC midnight, so it never displays a day early west of UTC. */
export function formatDateOnly(date: string): string {
  return format(parseISO(date), 'EEEE, MMM d, yyyy');
}

/** `value` is a wall-clock `HH:MM:SS` (Postgres `time`, no date/timezone) - parsed against an arbitrary reference date purely to format it. */
export function formatTimeOfDay(value: string): string {
  return format(parse(value, 'HH:mm:ss', new Date()), 'h:mm a');
}

export const ATTENDANCE_CATEGORY_LABELS: Record<AttendanceCategory, string> = {
  present: 'Present',
  absent: 'Absent',
  late: 'Late',
  excused: 'Excused',
};

export const ATTENDANCE_CATEGORY_BADGE_VARIANT: Record<AttendanceCategory, NonNullable<BadgeProps['variant']>> = {
  present: 'success',
  absent: 'danger',
  late: 'warning',
  excused: 'info',
};
