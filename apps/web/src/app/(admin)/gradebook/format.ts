import { format, parseISO } from 'date-fns';
import type { BadgeProps } from '@sms/ui';
import type { ScoreStatus, SectionStudent } from '../../../lib/api';

/** `dueOn`/`startsOn`/`endsOn` are `YYYY-MM-DD` `DateOnly` strings - `parseISO` (unlike `new Date(...)`) reads them as a local calendar date, not UTC midnight, so they never display a day early west of UTC. */
export function formatDateOnly(value: string): string {
  return format(parseISO(value), 'MMM d, yyyy');
}

export function formatShortDateOnly(value: string): string {
  return format(parseISO(value), 'MMM d');
}

export function studentDisplayName(student: Pick<SectionStudent, 'givenName' | 'familyName'>): string {
  return `${student.givenName} ${student.familyName}`;
}

export function studentInitials(student: Pick<SectionStudent, 'givenName' | 'familyName'>): string {
  const first = student.givenName.trim()[0] ?? '';
  const last = student.familyName.trim()[0] ?? '';
  return (first + last).toUpperCase() || '?';
}

export function sortStudents<T extends { givenName: string; familyName: string }>(students: T[]): T[] {
  return [...students].sort((a, b) => `${a.familyName} ${a.givenName}`.localeCompare(`${b.familyName} ${b.givenName}`));
}

/** Short, fixed-width labels for the per-cell status control - long enough to read, short enough to fit a dense column. */
export const SCORE_STATUS_LABELS: Record<ScoreStatus, string> = {
  graded: 'Graded',
  missing: 'Missing',
  exempt: 'Exempt',
  late: 'Late',
  incomplete: 'Incomplete',
};

export const SCORE_STATUS_ABBR: Record<Exclude<ScoreStatus, 'graded'>, string> = {
  missing: 'MSG',
  exempt: 'EXM',
  late: 'LATE',
  incomplete: 'INC',
};

export const SCORE_STATUS_BADGE_VARIANT: Record<ScoreStatus, NonNullable<BadgeProps['variant']>> = {
  graded: 'neutral',
  missing: 'danger',
  exempt: 'neutral',
  late: 'warning',
  incomplete: 'info',
};

/** Tailwind classes for a non-graded status cell's tinted background - deliberately none of the four share a hue with the "unsaved edit" indicator (primary) or with each other, so a glance at a column tells missing/exempt/late/incomplete apart without reading the abbreviation. */
export const SCORE_STATUS_CELL_CLASS: Record<Exclude<ScoreStatus, 'graded'>, string> = {
  missing: 'bg-danger-soft',
  exempt: 'bg-surface-sunken',
  late: 'bg-warning-soft',
  incomplete: 'bg-info-soft',
};

/** Maps a resolved letter grade to a semantic tone for its badge - purely a display convenience, never sent to or trusted from the server. */
export function letterBadgeVariant(letter: string | null): NonNullable<BadgeProps['variant']> {
  if (!letter) return 'neutral';
  const first = letter.trim()[0]?.toUpperCase();
  switch (first) {
    case 'A':
      return 'success';
    case 'B':
      return 'info';
    case 'C':
      return 'warning';
    case 'D':
    case 'F':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function formatPercentage(value: number | null): string {
  if (value === null) return '—';
  return `${Math.round(value * 10) / 10}%`;
}

export function formatPoints(value: number | null): string {
  if (value === null) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
