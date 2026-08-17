import { isValid, parseISO, formatISO } from 'date-fns';
import type { Brand } from './ids.js';
import { ValidationError } from './errors.js';

/**
 * A calendar date with no time-of-day or timezone component, always
 * formatted `YYYY-MM-DD`. This is load-bearing: enrolments, role
 * assignments and staff assignments are all effective-dated, and mixing
 * `Date` (an instant) with a plain calendar date is exactly how off-by-one
 * timezone bugs creep into attendance and report cards.
 */
export type DateOnly = Brand<string, 'DateOnly'>;

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Parses and validates a `YYYY-MM-DD` string, throwing `ValidationError` if it isn't one. */
export function parseDateOnly(value: string): DateOnly {
  if (!DATE_ONLY_PATTERN.test(value)) {
    throw new ValidationError(`Expected a YYYY-MM-DD date, got: ${value}`);
  }
  const parsed = parseISO(value);
  if (!isValid(parsed) || formatISO(parsed, { representation: 'date' }) !== value) {
    throw new ValidationError(`Not a real calendar date: ${value}`);
  }
  return value as DateOnly;
}

/** Formats a JS `Date` (read in local time) as a `DateOnly`. */
export function formatDateOnly(date: Date): DateOnly {
  const year = date.getFullYear().toString().padStart(4, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}` as DateOnly;
}

/** Today, in local time, as a `DateOnly`. */
export function todayDateOnly(): DateOnly {
  return formatDateOnly(new Date());
}

/**
 * Compares two `DateOnly` values. Safe to use plain string comparison
 * operators (`<`, `<=`, `>`, `>=`) directly too, since `YYYY-MM-DD` sorts
 * lexicographically the same as chronologically - this helper exists for
 * call sites that want a `-1 | 0 | 1` comparator (e.g. `Array#sort`).
 */
export function compareDateOnly(a: DateOnly, b: DateOnly): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * An effective-dated span. `validFrom` and `validTo` are both inclusive;
 * `validTo: null` means open-ended (still in effect). This is the shape
 * used by `person_role`, `section_enrollment`, `staff_assignment` and every
 * other effective-dated table in the schema.
 */
export interface Interval {
  readonly validFrom: DateOnly;
  readonly validTo: DateOnly | null;
}

/** Sentinel used internally to compare an open-ended `validTo` against a real date. */
const FAR_FUTURE = '9999-12-31' as DateOnly;

function endOf(interval: Interval): DateOnly {
  return interval.validTo ?? FAR_FUTURE;
}

/**
 * Whether two inclusive-inclusive intervals share at least one day.
 *
 * Both endpoints are inclusive, so two intervals that touch on a single
 * shared day (`a` ends 2024-01-10, `b` starts 2024-01-10) DO overlap - that
 * day is claimed by both. An interval ending 2024-01-10 and one starting
 * 2024-01-11 do not overlap; they are adjacent.
 */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.validFrom <= endOf(b) && b.validFrom <= endOf(a);
}

/** Whether `date` falls within `interval` (inclusive on both ends). */
export function intervalContains(interval: Interval, date: DateOnly): boolean {
  return interval.validFrom <= date && date <= endOf(interval);
}

/**
 * Clamps `interval` to lie within `bounds`, returning `null` if they don't
 * overlap at all. Useful for e.g. restricting a staff assignment to the
 * boundaries of an academic year.
 */
export function clampInterval(interval: Interval, bounds: Interval): Interval | null {
  if (!intervalsOverlap(interval, bounds)) {
    return null;
  }

  const validFrom = interval.validFrom > bounds.validFrom ? interval.validFrom : bounds.validFrom;

  const intervalEnd = endOf(interval);
  const boundsEnd = endOf(bounds);
  const clampedEnd = intervalEnd < boundsEnd ? intervalEnd : boundsEnd;

  // FAR_FUTURE can only survive the min() above if *both* sides were open.
  const validTo = clampedEnd === FAR_FUTURE ? null : clampedEnd;

  return { validFrom, validTo };
}
