import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  NotFoundError,
  formatDateOnly,
  newId,
  todayDateOnly,
  type AcademicYearId,
  type DateOnly,
  type DomainError,
  type PersonId,
  type Result,
  type TenantId,
  err,
  ok,
} from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { AssignSubstituteInput, DateRange, SetSectionMeetingInput } from '../contract.js';
import type { DayOfWeek, ScheduleConflict, SectionMeeting, Substitution, TeacherWorkload, TimeOfDay, TimetableEntry } from '../domain/types.js';
import { toSectionMeeting } from '../infrastructure/mappers.js';
import { periodTable, roomTable, sectionEnrollmentTable, sectionMeetingTable, sectionTable, sectionTeacherTable, substitutionTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

// -----------------------------------------------------------------------------
// Calendar-date expansion helpers. `academic.section_meeting` stores a
// recurring slot (period + ISO day-of-week + effective date range), not
// concrete dates - the timetable views this service exposes have to expand
// that recurrence into actual calendar dates over the requested window, the
// same way a school's own printed timetable would.
// -----------------------------------------------------------------------------

const FAR_FUTURE = '9999-12-31' as DateOnly;

function toJsDate(date: DateOnly): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, day);
}

function addDays(date: DateOnly, days: number): DateOnly {
  const d = toJsDate(date);
  d.setDate(d.getDate() + days);
  return formatDateOnly(d);
}

/** ISO 8601 day-of-week: 1 (Monday) - 7 (Sunday), converted from JS's 0 (Sunday) - 6 (Saturday). */
function isoDayOfWeek(date: DateOnly): DayOfWeek {
  const jsDay = toJsDate(date).getDay();
  return (jsDay === 0 ? 7 : jsDay) as DayOfWeek;
}

/** Every calendar date in `[from, to]` (both inclusive) whose ISO day-of-week is `dayOfWeek`. */
function datesForDayOfWeek(from: DateOnly, to: DateOnly, dayOfWeek: DayOfWeek): DateOnly[] {
  const dates: DateOnly[] = [];
  let cursor = from;
  while (cursor <= to) {
    if (isoDayOfWeek(cursor) === dayOfWeek) {
      dates.push(cursor);
      cursor = addDays(cursor, 7);
    } else {
      cursor = addDays(cursor, 1);
    }
  }
  return dates;
}

function maxDate(...dates: DateOnly[]): DateOnly {
  return dates.reduce((a, b) => (a > b ? a : b));
}

function minDate(...dates: DateOnly[]): DateOnly {
  return dates.reduce((a, b) => (a < b ? a : b));
}

/** Row shape shared by the teacher/student/room timetable joins below. */
interface MeetingJoinRow {
  readonly meetingId: string;
  readonly sectionId: string;
  readonly sectionCode: string;
  readonly sectionName: string;
  readonly periodId: string;
  readonly periodName: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly dayOfWeek: number;
  readonly roomId: string | null;
  readonly roomCode: string | null;
  readonly meetingValidFrom: string;
  readonly meetingValidTo: string | null;
  /** The extra effective-dated window to intersect against (the teacher assignment, or the student enrollment) - `null` bounds for `getRoomTimetable`, which has none. */
  readonly extraValidFrom: string | null;
  readonly extraValidTo: string | null;
}

/** Expands one joined row into every concrete `TimetableEntry` occurrence within `range`, intersected with the meeting's own validity and (if present) the extra effective-dated window. */
function expandRow(row: MeetingJoinRow, range: DateRange): TimetableEntry[] {
  const starts = [row.meetingValidFrom as DateOnly, range.from];
  const ends = [(row.meetingValidTo as DateOnly | null) ?? FAR_FUTURE, range.to];
  if (row.extraValidFrom) {
    starts.push(row.extraValidFrom as DateOnly);
    ends.push((row.extraValidTo as DateOnly | null) ?? FAR_FUTURE);
  }
  const effStart = maxDate(...starts);
  const effEnd = minDate(...ends);
  if (effStart > effEnd) {
    return [];
  }

  const dayOfWeek = row.dayOfWeek as DayOfWeek;
  return datesForDayOfWeek(effStart, effEnd, dayOfWeek).map((date) => ({
    date,
    dayOfWeek,
    sectionMeetingId: row.meetingId,
    sectionId: row.sectionId,
    sectionCode: row.sectionCode,
    sectionName: row.sectionName,
    periodId: row.periodId,
    periodName: row.periodName,
    startsAt: row.startsAt as TimeOfDay,
    endsAt: row.endsAt as TimeOfDay,
    roomId: row.roomId,
    roomCode: row.roomCode,
    isSubstituted: false,
    isSubstituting: false,
    substitutePersonId: null,
    substituteReason: null,
  }));
}

/** Postgres row shapes for the raw-SQL reports below (`getTeacherWorkload`/`detectConflicts` join across `academic`+`people`, and self-join `section_meeting` - past what the typed query builder reasonably expresses). */
type WorkloadRow = {
  readonly person_id: string;
  readonly given_name: string;
  readonly family_name: string;
  readonly periods_per_week: string;
  readonly section_count: string;
};

type ConflictRow = {
  readonly period_id: string;
  readonly day_of_week: number;
  readonly meeting_a: string;
  readonly section_a: string;
  readonly meeting_b: string;
  readonly section_b: string;
  readonly room_id: string | null;
  readonly person_id: string | null;
};

@Injectable()
export class SectionMeetingService {
  /**
   * Bulk-inserts `meetings` for `sectionId` in one transaction. Conflicts are
   * enforced by the database, not here (see the `0610` migration): a room
   * double-booking is rejected by `section_meeting_room_no_overlap` (an
   * exclusion constraint), a teacher double-booking by
   * `trg_check_teacher_conflict` - either failure rolls the whole batch back.
   */
  async setSectionMeetings(tenantId: TenantId, sectionId: string, meetings: SetSectionMeetingInput[]): Promise<Result<SectionMeeting[], DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const created = await withTenantTx(ctx, async (db) => {
        const rows: (typeof sectionMeetingTable.$inferSelect)[] = [];
        for (const meeting of meetings) {
          const inserted = await db
            .insert(sectionMeetingTable)
            .values({
              id: newId(),
              tenantId,
              sectionId,
              periodId: meeting.periodId,
              dayOfWeek: meeting.dayOfWeek,
              roomId: meeting.roomId ?? null,
              validFrom: meeting.validFrom ?? todayDateOnly(),
              validTo: meeting.validTo ?? null,
            })
            .returning();
          const row = inserted[0];
          if (!row) {
            throw new NotFoundError('Insert returned no row.');
          }
          rows.push(row);
        }
        return rows;
      });
      return ok(created.map(toSectionMeeting));
    } catch (error) {
      return err(toDomainError(error, `Could not set meetings for section ${sectionId}.`) as DomainError);
    }
  }

  async listMeetingsForSection(tenantId: TenantId, sectionId: string, asOf?: DateOnly): Promise<SectionMeeting[]> {
    const ctx = scopedContext(tenantId);
    const resolveDate = asOf ?? todayDateOnly();
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(sectionMeetingTable)
        .where(
          and(
            eq(sectionMeetingTable.tenantId, tenantId),
            eq(sectionMeetingTable.sectionId, sectionId),
            lte(sectionMeetingTable.validFrom, resolveDate),
            or(isNull(sectionMeetingTable.validTo), gte(sectionMeetingTable.validTo, resolveDate)),
          ),
        )
        .orderBy(asc(sectionMeetingTable.dayOfWeek), asc(sectionMeetingTable.validFrom)),
    );
    return rows.map(toSectionMeeting);
  }

  /** `personId`'s teaching timetable: their own assigned sections' meetings, plus any date they covered as a substitute for someone else's; minus none - a substituted-out date is kept but flagged (`isSubstituted`), not silently dropped. */
  async getTimetableForTeacher(tenantId: TenantId, personId: PersonId, range: DateRange): Promise<TimetableEntry[]> {
    const ctx = scopedContext(tenantId);

    const ownRows = await withTenantTx(ctx, (db) =>
      db
        .select({
          meetingId: sectionMeetingTable.id,
          sectionId: sectionMeetingTable.sectionId,
          sectionCode: sectionTable.code,
          sectionName: sectionTable.name,
          periodId: periodTable.id,
          periodName: periodTable.name,
          startsAt: periodTable.startsAt,
          endsAt: periodTable.endsAt,
          dayOfWeek: sectionMeetingTable.dayOfWeek,
          roomId: sectionMeetingTable.roomId,
          roomCode: roomTable.code,
          meetingValidFrom: sectionMeetingTable.validFrom,
          meetingValidTo: sectionMeetingTable.validTo,
          extraValidFrom: sectionTeacherTable.validFrom,
          extraValidTo: sectionTeacherTable.validTo,
        })
        .from(sectionTeacherTable)
        .innerJoin(
          sectionMeetingTable,
          and(eq(sectionMeetingTable.tenantId, sectionTeacherTable.tenantId), eq(sectionMeetingTable.sectionId, sectionTeacherTable.sectionId)),
        )
        .innerJoin(periodTable, eq(periodTable.id, sectionMeetingTable.periodId))
        .innerJoin(sectionTable, eq(sectionTable.id, sectionMeetingTable.sectionId))
        .leftJoin(roomTable, eq(roomTable.id, sectionMeetingTable.roomId))
        .where(
          and(
            eq(sectionTeacherTable.tenantId, tenantId),
            eq(sectionTeacherTable.personId, personId),
            lte(sectionTeacherTable.validFrom, range.to),
            or(isNull(sectionTeacherTable.validTo), gte(sectionTeacherTable.validTo, range.from)),
            lte(sectionMeetingTable.validFrom, range.to),
            or(isNull(sectionMeetingTable.validTo), gte(sectionMeetingTable.validTo, range.from)),
          ),
        ),
    );

    let entries = (ownRows as MeetingJoinRow[]).flatMap((row) => expandRow(row, range));
    entries = await this.attachSubstitutions(tenantId, entries);

    // Dates this teacher covered as a SUBSTITUTE for someone else's section -
    // not part of their own assignment, so not covered by the query above.
    const substituteEntries = await this.substituteEntriesFor(tenantId, personId, range);
    entries = [...entries, ...substituteEntries];

    entries.sort((a, b) => (a.date === b.date ? a.startsAt.localeCompare(b.startsAt) : a.date.localeCompare(b.date)));
    return entries;
  }

  /** `personId`'s (a student's) class timetable, via their current section enrollments over `range`. */
  async getTimetableForStudent(tenantId: TenantId, personId: PersonId, range: DateRange): Promise<TimetableEntry[]> {
    const ctx = scopedContext(tenantId);

    const rows = await withTenantTx(ctx, (db) =>
      db
        .select({
          meetingId: sectionMeetingTable.id,
          sectionId: sectionMeetingTable.sectionId,
          sectionCode: sectionTable.code,
          sectionName: sectionTable.name,
          periodId: periodTable.id,
          periodName: periodTable.name,
          startsAt: periodTable.startsAt,
          endsAt: periodTable.endsAt,
          dayOfWeek: sectionMeetingTable.dayOfWeek,
          roomId: sectionMeetingTable.roomId,
          roomCode: roomTable.code,
          meetingValidFrom: sectionMeetingTable.validFrom,
          meetingValidTo: sectionMeetingTable.validTo,
          extraValidFrom: sectionEnrollmentTable.validFrom,
          extraValidTo: sectionEnrollmentTable.validTo,
        })
        .from(sectionEnrollmentTable)
        .innerJoin(
          sectionMeetingTable,
          and(eq(sectionMeetingTable.tenantId, sectionEnrollmentTable.tenantId), eq(sectionMeetingTable.sectionId, sectionEnrollmentTable.sectionId)),
        )
        .innerJoin(periodTable, eq(periodTable.id, sectionMeetingTable.periodId))
        .innerJoin(sectionTable, eq(sectionTable.id, sectionMeetingTable.sectionId))
        .leftJoin(roomTable, eq(roomTable.id, sectionMeetingTable.roomId))
        .where(
          and(
            eq(sectionEnrollmentTable.tenantId, tenantId),
            eq(sectionEnrollmentTable.personId, personId),
            lte(sectionEnrollmentTable.validFrom, range.to),
            or(isNull(sectionEnrollmentTable.validTo), gte(sectionEnrollmentTable.validTo, range.from)),
            lte(sectionMeetingTable.validFrom, range.to),
            or(isNull(sectionMeetingTable.validTo), gte(sectionMeetingTable.validTo, range.from)),
          ),
        ),
    );

    let entries = (rows as MeetingJoinRow[]).flatMap((row) => expandRow(row, range));
    entries = await this.attachSubstitutions(tenantId, entries);
    entries.sort((a, b) => (a.date === b.date ? a.startsAt.localeCompare(b.startsAt) : a.date.localeCompare(b.date)));
    return entries;
  }

  /** Every meeting scheduled in `roomId` over `range` - a facilities/room-availability view. */
  async getRoomTimetable(tenantId: TenantId, roomId: string, range: DateRange): Promise<TimetableEntry[]> {
    const ctx = scopedContext(tenantId);

    const rows = await withTenantTx(ctx, (db) =>
      db
        .select({
          meetingId: sectionMeetingTable.id,
          sectionId: sectionMeetingTable.sectionId,
          sectionCode: sectionTable.code,
          sectionName: sectionTable.name,
          periodId: periodTable.id,
          periodName: periodTable.name,
          startsAt: periodTable.startsAt,
          endsAt: periodTable.endsAt,
          dayOfWeek: sectionMeetingTable.dayOfWeek,
          roomId: sectionMeetingTable.roomId,
          roomCode: roomTable.code,
          meetingValidFrom: sectionMeetingTable.validFrom,
          meetingValidTo: sectionMeetingTable.validTo,
        })
        .from(sectionMeetingTable)
        .innerJoin(periodTable, eq(periodTable.id, sectionMeetingTable.periodId))
        .innerJoin(sectionTable, eq(sectionTable.id, sectionMeetingTable.sectionId))
        .leftJoin(roomTable, eq(roomTable.id, sectionMeetingTable.roomId))
        .where(
          and(
            eq(sectionMeetingTable.tenantId, tenantId),
            eq(sectionMeetingTable.roomId, roomId),
            lte(sectionMeetingTable.validFrom, range.to),
            or(isNull(sectionMeetingTable.validTo), gte(sectionMeetingTable.validTo, range.from)),
          ),
        ),
    );

    const withExtra: MeetingJoinRow[] = rows.map((row) => ({ ...row, extraValidFrom: null, extraValidTo: null }));
    let entries = withExtra.flatMap((row) => expandRow(row, range));
    entries = await this.attachSubstitutions(tenantId, entries);
    entries.sort((a, b) => (a.date === b.date ? a.startsAt.localeCompare(b.startsAt) : a.date.localeCompare(b.date)));
    return entries;
  }

  /** Marks entries whose `(sectionMeetingId, date)` has a recorded substitution. Shared by all three timetable views above. */
  private async attachSubstitutions(tenantId: TenantId, entries: TimetableEntry[]): Promise<TimetableEntry[]> {
    if (entries.length === 0) {
      return entries;
    }
    const ctx = scopedContext(tenantId);
    const meetingIds = [...new Set(entries.map((entry) => entry.sectionMeetingId))];

    const subRows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(substitutionTable)
        .where(and(eq(substitutionTable.tenantId, tenantId), inArray(substitutionTable.sectionMeetingId, meetingIds))),
    );

    if (subRows.length === 0) {
      return entries;
    }
    const byKey = new Map(subRows.map((row) => [`${row.sectionMeetingId}|${row.date}`, row]));

    return entries.map((entry) => {
      const sub = byKey.get(`${entry.sectionMeetingId}|${entry.date}`);
      if (!sub) {
        return entry;
      }
      return {
        ...entry,
        isSubstituted: true,
        substitutePersonId: sub.substitutePersonId as PersonId,
        substituteReason: sub.reason,
      };
    });
  }

  /** Occurrences where `personId` covered someone else's meeting as a substitute - not part of their own `section_teacher` assignment, so `getTimetableForTeacher`'s main query never finds them. */
  private async substituteEntriesFor(tenantId: TenantId, personId: PersonId, range: DateRange): Promise<TimetableEntry[]> {
    const ctx = scopedContext(tenantId);

    const rows = await withTenantTx(ctx, (db) =>
      db
        .select({
          sub: substitutionTable,
          meetingId: sectionMeetingTable.id,
          sectionId: sectionMeetingTable.sectionId,
          sectionCode: sectionTable.code,
          sectionName: sectionTable.name,
          periodId: periodTable.id,
          periodName: periodTable.name,
          startsAt: periodTable.startsAt,
          endsAt: periodTable.endsAt,
          roomId: sectionMeetingTable.roomId,
          roomCode: roomTable.code,
        })
        .from(substitutionTable)
        .innerJoin(sectionMeetingTable, eq(sectionMeetingTable.id, substitutionTable.sectionMeetingId))
        .innerJoin(periodTable, eq(periodTable.id, sectionMeetingTable.periodId))
        .innerJoin(sectionTable, eq(sectionTable.id, sectionMeetingTable.sectionId))
        .leftJoin(roomTable, eq(roomTable.id, sectionMeetingTable.roomId))
        .where(
          and(
            eq(substitutionTable.tenantId, tenantId),
            eq(substitutionTable.substitutePersonId, personId),
            gte(substitutionTable.date, range.from),
            lte(substitutionTable.date, range.to),
          ),
        ),
    );

    return rows.map((row) => ({
      date: row.sub.date as DateOnly,
      dayOfWeek: isoDayOfWeek(row.sub.date as DateOnly),
      sectionMeetingId: row.meetingId,
      sectionId: row.sectionId,
      sectionCode: row.sectionCode,
      sectionName: row.sectionName,
      periodId: row.periodId,
      periodName: row.periodName,
      startsAt: row.startsAt as TimeOfDay,
      endsAt: row.endsAt as TimeOfDay,
      roomId: row.roomId,
      roomCode: row.roomCode,
      isSubstituted: false,
      isSubstituting: true,
      substitutePersonId: personId,
      substituteReason: row.sub.reason,
    }));
  }

  /**
   * Records a substitute for one meeting occurrence. The absent teacher is
   * RESOLVED, not accepted as input: the section's `lead` teacher currently
   * assigned as of `date` (falling back to any assigned teacher) - so a
   * caller can never misattribute the absence to the wrong person by typing
   * the wrong id.
   */
  async assignSubstitute(tenantId: TenantId, input: AssignSubstituteInput): Promise<Result<Substitution, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const created = await withTenantTx(ctx, async (db) => {
        const meetingRows = await db
          .select()
          .from(sectionMeetingTable)
          .where(and(eq(sectionMeetingTable.tenantId, tenantId), eq(sectionMeetingTable.id, input.sectionMeetingId)))
          .limit(1);
        const meeting = meetingRows[0];
        if (!meeting) {
          throw new NotFoundError(`Section meeting ${input.sectionMeetingId} not found.`);
        }

        const teacherRows = await db
          .select()
          .from(sectionTeacherTable)
          .where(
            and(
              eq(sectionTeacherTable.tenantId, tenantId),
              eq(sectionTeacherTable.sectionId, meeting.sectionId),
              lte(sectionTeacherTable.validFrom, input.date),
              or(isNull(sectionTeacherTable.validTo), gte(sectionTeacherTable.validTo, input.date)),
            ),
          );
        // Prefer the `lead` teacher; fall back to any teacher assigned on this date.
        const absentTeacher = teacherRows.find((row) => row.role === 'lead') ?? teacherRows[0];
        if (!absentTeacher) {
          throw new NotFoundError(`No teacher is assigned to section ${meeting.sectionId} on ${input.date} to substitute for.`);
        }

        const inserted = await db
          .insert(substitutionTable)
          .values({
            id: newId(),
            tenantId,
            sectionMeetingId: input.sectionMeetingId,
            date: input.date,
            absentPersonId: absentTeacher.personId,
            substitutePersonId: input.substitutePersonId,
            reason: input.reason ?? null,
          })
          .returning();
        const row = inserted[0];
        if (!row) {
          throw new NotFoundError('Insert returned no row.');
        }
        return row;
      });
      return ok({
        id: created.id,
        tenantId: created.tenantId as TenantId,
        sectionMeetingId: created.sectionMeetingId,
        date: created.date as DateOnly,
        absentPersonId: created.absentPersonId as PersonId,
        substitutePersonId: created.substitutePersonId as PersonId,
        reason: created.reason,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      });
    } catch (error) {
      return err(toDomainError(error, 'Could not assign substitute.') as DomainError);
    }
  }

  /**
   * Periods-per-week and section count per teacher, across every section
   * meeting effective in `academicYearId`. Raw SQL: joins `people.person`
   * (a cross-schema read this package cannot reach through a typed table -
   * same established precedent as `SectionEnrollmentService.
   * listStudentsInSection`).
   *
   * Evaluated "as of" a reference date CLAMPED to the academic year's own
   * `[starts_on, ends_on]`, not bare `today` - an admin reviewing a
   * COMPLETED year's workload (or, in the same shape of problem, running
   * this report before the year has started) would otherwise always get
   * back nothing, because every one of that year's meetings has necessarily
   * already ended (or not yet started) relative to `today`. Clamping means
   * "workload as it stood by the end of the year" for a past year and
   * "workload as it stands right now" for the current one - the one query
   * serves both without the caller needing to know which case they're in.
   */
  async getTeacherWorkload(tenantId: TenantId, academicYearId: AcademicYearId): Promise<TeacherWorkload[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.execute<WorkloadRow>(sql`
        with year as (
          select least(greatest(current_date, starts_on), ends_on) as reference_date
          from tenancy.academic_year
          where id = ${academicYearId}
        )
        select
          st.person_id,
          p.given_name,
          p.family_name,
          count(distinct sm.id) as periods_per_week,
          count(distinct st.section_id) as section_count
        from academic.section_teacher st
        cross join year
        join academic.section sec on sec.id = st.section_id and sec.tenant_id = st.tenant_id
        join academic.term t on t.id = sec.term_id
        join academic.section_meeting sm
          on sm.tenant_id = st.tenant_id and sm.section_id = st.section_id
         and sm.valid_from <= year.reference_date
         and (sm.valid_to is null or sm.valid_to >= year.reference_date)
        join people.person p on p.id = st.person_id
        where st.tenant_id = ${tenantId}
          and st.valid_from <= year.reference_date
          and (st.valid_to is null or st.valid_to >= year.reference_date)
          and t.academic_year_id = ${academicYearId}
        group by st.person_id, p.given_name, p.family_name
        order by periods_per_week desc, p.family_name, p.given_name
      `),
    );

    return (rows as unknown as WorkloadRow[]).map((row) => ({
      personId: row.person_id as PersonId,
      givenName: row.given_name,
      familyName: row.family_name,
      periodsPerWeek: Number(row.periods_per_week),
      sectionCount: Number(row.section_count),
    }));
  }

  /**
   * Existing room/teacher double-bookings within `academicYearId` - for an
   * admin to find data that predates the `0610` constraints (a bulk import
   * or direct SQL write that bypassed triggers). New writes through this
   * service cannot create these; this is a report, not a live check. Raw
   * self-join SQL, same reasoning as `getTeacherWorkload` above.
   */
  async detectConflicts(tenantId: TenantId, academicYearId: AcademicYearId): Promise<ScheduleConflict[]> {
    const ctx = scopedContext(tenantId);

    const roomRows = await withTenantTx(ctx, (db) =>
      db.execute<ConflictRow>(sql`
        select a.period_id, a.day_of_week, a.id as meeting_a, a.section_id as section_a,
               b.id as meeting_b, b.section_id as section_b, a.room_id, null::uuid as person_id
        from academic.section_meeting a
        join academic.section_meeting b
          on b.tenant_id = a.tenant_id
         and b.id > a.id
         and b.room_id = a.room_id
         and b.period_id = a.period_id
         and b.day_of_week = a.day_of_week
         and daterange(b.valid_from, coalesce(b.valid_to, 'infinity'::date), '[]')
             && daterange(a.valid_from, coalesce(a.valid_to, 'infinity'::date), '[]')
        join academic.section sec_a on sec_a.id = a.section_id
        join academic.term term_a on term_a.id = sec_a.term_id
        where a.tenant_id = ${tenantId}
          and a.room_id is not null
          and term_a.academic_year_id = ${academicYearId}
      `),
    );

    const teacherRows = await withTenantTx(ctx, (db) =>
      db.execute<ConflictRow>(sql`
        select a.period_id, a.day_of_week, a.id as meeting_a, a.section_id as section_a,
               b.id as meeting_b, b.section_id as section_b, null::uuid as room_id, sta.person_id
        from academic.section_meeting a
        join academic.section_teacher sta
          on sta.tenant_id = a.tenant_id and sta.section_id = a.section_id
         and daterange(sta.valid_from, coalesce(sta.valid_to, 'infinity'::date), '[]')
             && daterange(a.valid_from, coalesce(a.valid_to, 'infinity'::date), '[]')
        join academic.section_meeting b
          on b.tenant_id = a.tenant_id
         and b.id <> a.id
         and b.section_id <> a.section_id
         and b.period_id = a.period_id
         and b.day_of_week = a.day_of_week
         and daterange(b.valid_from, coalesce(b.valid_to, 'infinity'::date), '[]')
             && daterange(a.valid_from, coalesce(a.valid_to, 'infinity'::date), '[]')
        join academic.section_teacher stb
          on stb.tenant_id = b.tenant_id and stb.section_id = b.section_id and stb.person_id = sta.person_id
         and daterange(stb.valid_from, coalesce(stb.valid_to, 'infinity'::date), '[]')
             && daterange(a.valid_from, coalesce(a.valid_to, 'infinity'::date), '[]')
        join academic.section sec_a on sec_a.id = a.section_id
        join academic.term term_a on term_a.id = sec_a.term_id
        where a.tenant_id = ${tenantId}
          and a.id < b.id
          and term_a.academic_year_id = ${academicYearId}
      `),
    );

    const toConflict = (kind: 'room' | 'teacher') => (row: ConflictRow): ScheduleConflict => ({
      kind,
      periodId: row.period_id,
      dayOfWeek: row.day_of_week as DayOfWeek,
      sectionMeetingIdA: row.meeting_a,
      sectionIdA: row.section_a,
      sectionMeetingIdB: row.meeting_b,
      sectionIdB: row.section_b,
      roomId: row.room_id,
      personId: row.person_id as PersonId | null,
    });

    return [
      ...(roomRows as unknown as ConflictRow[]).map(toConflict('room')),
      ...(teacherRows as unknown as ConflictRow[]).map(toConflict('teacher')),
    ];
  }
}
