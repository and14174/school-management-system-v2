import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  newId,
  type CampusId,
  type DateOnly,
  type DomainError,
  type NotFoundError as NotFoundErrorType,
  type PersonId,
  type Result,
  type TenantId,
  err,
  ok,
} from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import { OUTBOX_CONTRACT, type OutboxContract } from '@sms/outbox';
import type { GetAttendanceSummaryInput, GetSessionRosterInput, ListUnmarkedSessionsInput, MarkSessionInput, MarkSessionResult } from '../contract.js';
import type {
  AttendanceCategory,
  AttendanceSummary,
  RosterEntry,
  SectionMeetingContext,
  SessionRoster,
  UnmarkedSession,
} from '../domain/types.js';
import { toRecord, toSubmission } from '../infrastructure/mappers.js';
import { codeTable, recordTable, submissionTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * A mark may be edited freely (this service upserts in place) for a
 * configurable window after it was first marked; past it, the ONLY way to
 * change `codeId` is an APPROVED `attendance.correction` (see
 * `AttendanceCorrectionService.decideCorrection`, and the `0900` migration
 * header). Enforced HERE, in the service - not a database constraint, since
 * "now minus marked_at" is not expressible as a CHECK - but the approval
 * path is the sole other route that ever changes a locked record's code, so
 * the invariant still holds regardless of which code path attempts a write.
 */
export const ATTENDANCE_LOCK_WINDOW_HOURS = 24;
const LOCK_WINDOW_MS = ATTENDANCE_LOCK_WINDOW_HOURS * 60 * 60 * 1000;

/** ISO 8601 day-of-week: 1 (Monday) - 7 (Sunday). Duplicated from `@sms/academic`'s `SectionMeetingService` (internal, unreachable past its public contract) - same self-contained helper. */
function isoDayOfWeek(date: DateOnly): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const jsDay = new Date(year, month - 1, day).getDay();
  return jsDay === 0 ? 7 : jsDay;
}

/**
 * Row shapes for the raw cross-schema SQL below (`academic.section_meeting`/
 * `section`/`period`, `people.person`) - this package can reach `@sms/academic`'s
 * and `@sms/people`'s PUBLIC contracts, never their internal schema modules,
 * and a raw cross-schema read is the established escape hatch (see
 * `@sms/academic`'s `SectionEnrollmentService.listStudentsInSection`'s own
 * comment, and `@sms/enrollment`'s equivalent). `type` aliases, not
 * `interface`s - `db.execute<T>`'s generic constraint needs `T`'s implicit
 * index signature, which only a fresh object type literal gets (same
 * reasoning as academic's own `RosterRow`).
 */
type MeetingContextRow = {
  readonly section_id: string;
  readonly period_id: string;
  readonly period_name: string;
  readonly campus_id: string;
};

type RosterRow = {
  readonly person_id: string;
  readonly given_name: string;
  readonly family_name: string;
};

type UnmarkedSessionRow = {
  readonly section_meeting_id: string;
  readonly section_id: string;
  readonly section_code: string;
  readonly section_name: string;
  readonly campus_id: string;
  readonly period_id: string;
  readonly period_name: string;
};

type SummaryRow = {
  readonly category: string;
  readonly counts_as_present: boolean;
  readonly n: string;
};

/**
 * Bulk session marking, the roster it marks against, the unmarked-sessions
 * report, and the per-person attendance summary. See this file's own
 * comment on `ATTENDANCE_LOCK_WINDOW_HOURS` for the free-edit-then-
 * correction-only design, and `markSession`'s own comment for the
 * idempotent-submission + same-transaction-outbox design.
 *
 * Deliberately does NOT gate any of these on `academic.section_meeting`'s
 * own `[valid_from, valid_to]` effective-dating window - see this class's
 * `getMeetingContext` comment for why.
 */
@Injectable()
export class AttendanceRecordService {
  constructor(@Inject(OUTBOX_CONTRACT) private readonly outbox: OutboxContract) {}

  /**
   * Resolves `sectionMeetingId` to its section/period/campus **as of `date`**.
   *
   * Gated on the meeting's own `[valid_from, valid_to]` and its `day_of_week`:
   * a timetable slot that had not started, has since ended, or does not fall on
   * that weekday is not a class anyone can take a register for. Without this,
   * a stale or guessed `sectionMeetingId` marks attendance for a session that
   * never happened - and the record looks indistinguishable from a real one.
   *
   * (This gating was originally skipped because the seed's meeting windows were
   * hardcoded to a fixed calendar and no longer contained "today", which made
   * the marking screen unusable. That was a data bug; the seed now derives its
   * windows from the academic year, so the correct check can stand.)
   */
  async getMeetingContext(
    tenantId: TenantId,
    sectionMeetingId: string,
    date: DateOnly,
  ): Promise<SectionMeetingContext | null> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.execute<MeetingContextRow>(sql`
        select sm.section_id, sm.period_id, per.name as period_name, sec.campus_id
        from academic.section_meeting sm
        join academic.period per on per.id = sm.period_id
        join academic.section sec on sec.id = sm.section_id
        where sm.tenant_id = ${tenantId}
          and sm.id = ${sectionMeetingId}
          and sm.valid_from <= ${date}
          and (sm.valid_to is null or sm.valid_to >= ${date})
          and sm.day_of_week = extract(isodow from ${date}::date)
        limit 1
      `),
    );
    const row = (rows as unknown as MeetingContextRow[])[0];
    if (!row) {
      return null;
    }
    return { sectionId: row.section_id, periodId: row.period_id, periodName: row.period_name, campusId: row.campus_id as CampusId };
  }

  /** The roster to mark: every currently-enrolled student in the meeting's section, pre-filled with any existing mark for `date`. */
  async getSessionRoster(tenantId: TenantId, input: GetSessionRosterInput): Promise<Result<SessionRoster, NotFoundErrorType>> {
    const ctx = scopedContext(tenantId);
    const meeting = await this.getMeetingContext(tenantId, input.sectionMeetingId, input.date);
    if (!meeting) {
      return err(new NotFoundError(`Section meeting ${input.sectionMeetingId} not found.`));
    }

    const rosterRows = await withTenantTx(ctx, (db) =>
      db.execute<RosterRow>(sql`
        select se.person_id, p.given_name, p.family_name
        from academic.section_enrollment se
        join people.person p on p.id = se.person_id
        where se.tenant_id = ${tenantId}
          and se.section_id = ${meeting.sectionId}
          and se.valid_from <= ${input.date}
          and (se.valid_to is null or se.valid_to >= ${input.date})
        order by p.family_name, p.given_name
      `),
    );

    const existingRows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(recordTable)
        .where(
          and(
            eq(recordTable.tenantId, tenantId),
            eq(recordTable.sectionMeetingId, input.sectionMeetingId),
            eq(recordTable.date, input.date),
          ),
        ),
    );
    const existingByPerson = new Map(existingRows.map((row) => [row.personId, row]));

    const entries: RosterEntry[] = (rosterRows as unknown as RosterRow[]).map((row) => {
      const existing = existingByPerson.get(row.person_id);
      return {
        personId: row.person_id as PersonId,
        givenName: row.given_name,
        familyName: row.family_name,
        existingRecordId: existing?.id ?? null,
        codeId: existing?.codeId ?? null,
        minutesLate: existing?.minutesLate ?? null,
        note: existing?.note ?? null,
      };
    });

    return ok({
      sectionMeetingId: input.sectionMeetingId,
      sectionId: meeting.sectionId,
      date: input.date,
      periodId: meeting.periodId,
      periodName: meeting.periodName,
      entries,
    });
  }

  /**
   * The teacher's bulk submit. One transaction:
   *   1. Insert the `attendance.submission` idempotency row - `ON CONFLICT
   *      DO NOTHING` on `(tenant_id, idempotency_key)`. No row returned means
   *      this exact key was already submitted: fetch and return the ORIGINAL
   *      result, writing nothing further (`replayed: true`).
   *   2. Otherwise upsert every mark (see `ATTENDANCE_LOCK_WINDOW_HOURS`'s own
   *      comment for the free-edit-then-locked rule).
   *   3. Publish one `attendance.marked_absent` event per mark resolving to
   *      the `'absent'` category, through the SAME transaction (`db`) -
   *      never a fire-and-forget call after commit, per `@sms/outbox`'s
   *      `OutboxContract.publish` doc comment.
   *
   * Requires an ambient tenant context (`OutboxContract.publish` reads it via
   * `requireContext()`) - a real HTTP request already runs inside one
   * (`TenantContextInterceptor`); a test or seed script calling this directly
   * must wrap the call in `runWithContext`.
   */
  async markSession(tenantId: TenantId, input: MarkSessionInput): Promise<Result<MarkSessionResult, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const outcome = await withTenantTx(ctx, async (db) => {
        const insertedSubmissionRows = await db
          .insert(submissionTable)
          .values({
            id: newId(),
            tenantId,
            idempotencyKey: input.idempotencyKey,
            sectionMeetingId: input.sectionMeetingId,
            date: input.date,
            submittedByUserId: ctx.actorUserId ?? ctx.userId ?? null,
            recordCount: input.marks.length,
          })
          .onConflictDoNothing()
          .returning();

        if (insertedSubmissionRows.length === 0) {
          const existingSubmissionRows = await db
            .select()
            .from(submissionTable)
            .where(and(eq(submissionTable.tenantId, tenantId), eq(submissionTable.idempotencyKey, input.idempotencyKey)))
            .limit(1);
          const existingSubmission = existingSubmissionRows[0];
          if (!existingSubmission) {
            throw new ConflictError(`Idempotency key "${input.idempotencyKey}" conflicted but no submission row was found.`);
          }

          const personIds = input.marks.map((mark) => mark.personId);
          const existingRecordRows =
            personIds.length === 0
              ? []
              : await db
                  .select()
                  .from(recordTable)
                  .where(
                    and(
                      eq(recordTable.tenantId, tenantId),
                      eq(recordTable.sectionMeetingId, existingSubmission.sectionMeetingId),
                      eq(recordTable.date, existingSubmission.date),
                      inArray(recordTable.personId, personIds),
                    ),
                  );

          return { records: existingRecordRows.map(toRecord), submission: toSubmission(existingSubmission), replayed: true };
        }
        const submission = insertedSubmissionRows[0]!;

        const meetingRows = await db.execute<{ section_id: string }>(sql`
          select section_id from academic.section_meeting where tenant_id = ${tenantId} and id = ${input.sectionMeetingId}
        `);
        const meetingRow = (meetingRows as unknown as Array<{ section_id: string }>)[0];
        if (!meetingRow) {
          throw new NotFoundError(`Section meeting ${input.sectionMeetingId} not found.`);
        }
        const sectionId = meetingRow.section_id;

        const codeIds = [...new Set(input.marks.map((mark) => mark.codeId))];
        const codeRows =
          codeIds.length === 0
            ? []
            : await db.select().from(codeTable).where(and(eq(codeTable.tenantId, tenantId), inArray(codeTable.id, codeIds)));
        const codeById = new Map(codeRows.map((row) => [row.id, row]));

        const nowTs = new Date();
        const resultRecords: (typeof recordTable.$inferSelect)[] = [];

        for (const mark of input.marks) {
          const code = codeById.get(mark.codeId);
          if (!code) {
            throw new NotFoundError(`Attendance code ${mark.codeId} not found.`);
          }
          if (code.requiresReason && !mark.note?.trim()) {
            throw new ValidationError(`Attendance code "${code.code}" requires a note.`);
          }

          const existingRows = await db
            .select()
            .from(recordTable)
            .where(
              and(
                eq(recordTable.tenantId, tenantId),
                eq(recordTable.personId, mark.personId),
                eq(recordTable.date, input.date),
                eq(recordTable.sectionMeetingId, input.sectionMeetingId),
              ),
            )
            .limit(1);
          const existing = existingRows[0];

          if (!existing) {
            const inserted = await db
              .insert(recordTable)
              .values({
                id: newId(),
                tenantId,
                personId: mark.personId,
                sectionId,
                sectionMeetingId: input.sectionMeetingId,
                date: input.date,
                codeId: mark.codeId,
                minutesLate: mark.minutesLate ?? null,
                note: mark.note ?? null,
                markedByUserId: ctx.actorUserId ?? ctx.userId ?? null,
                markedAt: nowTs,
              })
              .returning();
            resultRecords.push(inserted[0]!);
            continue;
          }

          const changed =
            existing.codeId !== mark.codeId ||
            (existing.minutesLate ?? null) !== (mark.minutesLate ?? null) ||
            (existing.note ?? null) !== (mark.note ?? null);

          if (!changed) {
            resultRecords.push(existing);
            continue;
          }

          const withinWindow = nowTs.getTime() - existing.markedAt.getTime() <= LOCK_WINDOW_MS;
          if (!withinWindow) {
            throw new ValidationError(
              `Attendance record ${existing.id} (person ${mark.personId}, ${input.date}) was marked more than ${ATTENDANCE_LOCK_WINDOW_HOURS}h ago and is locked - request a correction instead of re-submitting.`,
            );
          }

          const updated = await db
            .update(recordTable)
            .set({
              codeId: mark.codeId,
              minutesLate: mark.minutesLate ?? null,
              note: mark.note ?? null,
              markedByUserId: ctx.actorUserId ?? ctx.userId ?? null,
              markedAt: nowTs,
            })
            .where(eq(recordTable.id, existing.id))
            .returning();
          resultRecords.push(updated[0]!);
        }

        // See this method's own doc comment: published through `db` (the
        // caller's transaction), never after commit.
        for (const mark of input.marks) {
          const code = codeById.get(mark.codeId)!;
          if (code.category === 'absent') {
            await this.outbox.publish(db, {
              topic: 'attendance.marked_absent',
              payload: {
                personId: mark.personId,
                sectionId,
                sectionMeetingId: input.sectionMeetingId,
                date: input.date,
                codeId: mark.codeId,
              },
            });
          }
        }

        return { records: resultRecords.map(toRecord), submission: toSubmission(submission), replayed: false };
      });

      return ok(outcome);
    } catch (error) {
      return err(
        toDomainError(error, `Could not mark attendance for section meeting ${input.sectionMeetingId} on ${input.date}.`) as DomainError,
      );
    }
  }

  /**
   * Sections that actually meet on `date` - matched on ISO day-of-week AND the
   * meeting's own `[valid_from, valid_to]` window - with no
   * `attendance.submission` row yet.
   *
   * The validity window is not optional. Matching weekday alone offers last
   * term's timetable on this term's dates: the same Wednesday slot from a
   * finished term looks like a class waiting to be marked, and marking it
   * produces a register for a session that never ran.
   */
  async listUnmarkedSessions(tenantId: TenantId, input: ListUnmarkedSessionsInput): Promise<UnmarkedSession[]> {
    const ctx = scopedContext(tenantId);
    const dayOfWeek = isoDayOfWeek(input.date);

    const conditions = [
      sql`sm.tenant_id = ${tenantId}`,
      sql`sm.day_of_week = ${dayOfWeek}`,
      sql`sm.valid_from <= ${input.date}`,
      sql`(sm.valid_to is null or sm.valid_to >= ${input.date})`,
      sql`sub.id is null`,
      ...(input.campusId ? [sql`sec.campus_id = ${input.campusId}`] : []),
    ];

    const rows = await withTenantTx(ctx, (db) =>
      db.execute<UnmarkedSessionRow>(sql`
        select sm.id as section_meeting_id, sm.section_id, sec.code as section_code, sec.name as section_name,
               sec.campus_id, sm.period_id, per.name as period_name
        from academic.section_meeting sm
        join academic.section sec on sec.id = sm.section_id and sec.tenant_id = sm.tenant_id
        join academic.period per on per.id = sm.period_id
        left join attendance.submission sub
          on sub.tenant_id = sm.tenant_id and sub.section_meeting_id = sm.id and sub.date = ${input.date}
        where ${sql.join(conditions, sql` and `)}
        order by sec.code
      `),
    );

    return (rows as unknown as UnmarkedSessionRow[]).map((row) => ({
      sectionMeetingId: row.section_meeting_id,
      sectionId: row.section_id,
      sectionCode: row.section_code,
      sectionName: row.section_name,
      campusId: row.campus_id as CampusId,
      periodId: row.period_id,
      periodName: row.period_name,
      date: input.date,
    }));
  }

  /** Counts by category and a derived attendance percentage for `personId` over `[from, to]` (both inclusive). */
  async getAttendanceSummary(tenantId: TenantId, input: GetAttendanceSummaryInput): Promise<AttendanceSummary> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.execute<SummaryRow>(sql`
        select c.category, c.counts_as_present, count(*) as n
        from attendance.record r
        join attendance.code c on c.id = r.code_id
        where r.tenant_id = ${tenantId}
          and r.person_id = ${input.personId}
          and r.date >= ${input.from}
          and r.date <= ${input.to}
        group by c.category, c.counts_as_present
      `),
    );

    const countsByCategory: Record<AttendanceCategory, number> = { present: 0, absent: 0, late: 0, excused: 0 };
    let totalCount = 0;
    let presentCount = 0;
    for (const row of rows as unknown as SummaryRow[]) {
      const n = Number(row.n);
      totalCount += n;
      countsByCategory[row.category as AttendanceCategory] += n;
      if (row.counts_as_present) {
        presentCount += n;
      }
    }

    const attendancePercentage = totalCount > 0 ? Math.round((presentCount / totalCount) * 1000) / 10 : 0;

    return {
      personId: input.personId,
      from: input.from,
      to: input.to,
      totalCount,
      presentCount,
      countsByCategory,
      attendancePercentage,
    };
  }
}
