import { addDays, endOfWeek, format, startOfWeek, subDays } from 'date-fns';

export interface DateRange {
  from: string;
  to: string;
}

/** Today as a `YYYY-MM-DD` local-calendar-date string - what every `DateOnly` query param expects. Same convention as (admin)/dashboard/format.ts's `todayIso`, duplicated rather than imported across the route-group boundary. */
export function todayIso(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

/** Monday..Sunday of the CURRENT week in the browser's local time - what the child detail page's "timetable for the current week" requests. */
export function currentWeekRange(reference: Date = new Date()): DateRange {
  return {
    from: format(startOfWeek(reference, { weekStartsOn: 1 }), 'yyyy-MM-dd'),
    to: format(endOfWeek(reference, { weekStartsOn: 1 }), 'yyyy-MM-dd'),
  };
}

/**
 * The trailing `days` days ending today (inclusive) - a clearly-bounded,
 * honestly-labelled window for attendance summaries. Not "this term": a
 * parent/student cannot resolve term dates (`GET /academic/terms` 403s for
 * both - see portal-api.ts's own top comment), so there is no real "term to
 * date" range this client could compute even if it wanted to.
 */
export function trailingDaysRange(days: number, reference: Date = new Date()): DateRange {
  return {
    from: format(subDays(reference, days - 1), 'yyyy-MM-dd'),
    to: format(reference, 'yyyy-MM-dd'),
  };
}

/** Every `YYYY-MM-DD` date in `range`, inclusive - used to render one row per calendar day (including days with no classes) rather than only the days an entry happens to exist for. */
export function everyDayOf(range: DateRange): string[] {
  const days: string[] = [];
  let cursor = new Date(`${range.from}T00:00:00`);
  const end = new Date(`${range.to}T00:00:00`);
  while (cursor.getTime() <= end.getTime()) {
    days.push(format(cursor, 'yyyy-MM-dd'));
    cursor = addDays(cursor, 1);
  }
  return days;
}

/** `date` (a `YYYY-MM-DD` string) formatted as e.g. "Mon, 13 Aug". */
export function formatDayLabel(date: string): string {
  return format(new Date(`${date}T00:00:00`), 'EEE, d MMM');
}

/** A wall-clock `HH:MM:SS` (Postgres `time`) formatted as e.g. "9:00 AM". Same convention as (admin)/attendance/format.ts's `formatTimeOfDay`. */
export function formatTimeOfDay(value: string): string {
  const [hoursText, minutesText] = value.split(':');
  const reference = new Date();
  reference.setHours(Number(hoursText ?? 0), Number(minutesText ?? 0), 0, 0);
  return format(reference, 'h:mm a');
}

/** An ISO instant formatted as e.g. "13 Aug 2026, 9:04 AM". */
export function formatDateTime(iso: string): string {
  return format(new Date(iso), 'd MMM yyyy, h:mm a');
}

/** An ISO instant formatted as e.g. "13 Aug 2026". */
export function formatDate(iso: string): string {
  return format(new Date(iso), 'd MMM yyyy');
}
