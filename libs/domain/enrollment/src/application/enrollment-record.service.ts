import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, ilike, or, sql } from 'drizzle-orm';
import {
  NotFoundError,
  ValidationError,
  newId,
  todayDateOnly,
  type DomainError,
  type Result,
  type TenantId,
  err,
  ok,
} from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { EnrolStudentInput, ListEnrollmentsInput, TransferCampusInput, TransitionStatusInput } from '../contract.js';
import { isExitStatus, isLegalStatusTransition, type Enrollment, type EnrollmentPage, type EnrollmentStatus, type StatusEvent } from '../domain/types.js';
import { toEnrollment, toStatusEvent } from '../infrastructure/mappers.js';
import { enrollmentTable, statusEventTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/**
 * All per-record enrolment operations: create, status transition, campus
 * transfer, read, list, history. `enrollment.enrollment`/`status_event`
 * writes are additionally gated in the DATABASE by
 * `tenancy.assert_year_writable` (see the `0700` migration's triggers) - not
 * re-checked here, so a locked/archived academic year rejects the write
 * regardless of which code path attempted it.
 */
@Injectable()
export class EnrollmentRecordService {
  /**
   * `enrollment_tenant_person_academic_year_key` (see the `0700` migration)
   * rejects a second enrolment for the same person in the same academic
   * year, surfacing as a `ConflictError` via `toDomainError`.
   */
  async enrolStudent(tenantId: TenantId, input: EnrolStudentInput): Promise<Result<Enrollment, DomainError>> {
    const ctx = scopedContext(tenantId);
    const enrolledOn = input.enrolledOn ?? todayDateOnly();

    try {
      const row = await withTenantTx(ctx, async (db) => {
        const rows = await db
          .insert(enrollmentTable)
          .values({
            id: newId(),
            tenantId,
            personId: input.personId,
            academicYearId: input.academicYearId,
            campusId: input.campusId,
            gradeLevelId: input.gradeLevelId,
            studentNumber: input.studentNumber ?? null,
            status: 'enrolled',
            enrolledOn,
            exitedOn: null,
            exitReason: null,
          })
          .returning();
        const inserted = rows[0];
        if (!inserted) {
          throw new NotFoundError('Insert returned no row.');
        }

        await db.insert(statusEventTable).values({
          id: newId(),
          tenantId,
          enrollmentId: inserted.id,
          fromStatus: null,
          toStatus: 'enrolled',
          effectiveOn: enrolledOn,
          reason: 'Initial enrolment',
          actorUserId: ctx.actorUserId ?? ctx.userId ?? null,
        });

        return inserted;
      });
      return ok(toEnrollment(row));
    } catch (error) {
      return err(toDomainError(error, 'Could not enrol student.') as DomainError);
    }
  }

  /**
   * Validates the transition is legal (see `isLegalStatusTransition`), then
   * appends a `StatusEvent` and updates the enrolment's denormalised
   * `status` in the SAME transaction - the history is never overwritten,
   * only appended to.
   */
  async transitionStatus(tenantId: TenantId, input: TransitionStatusInput): Promise<Result<Enrollment, DomainError>> {
    const ctx = scopedContext(tenantId);

    try {
      return await withTenantTx(ctx, async (db) => {
        const rows = await db
          .select()
          .from(enrollmentTable)
          .where(and(eq(enrollmentTable.tenantId, tenantId), eq(enrollmentTable.id, input.enrollmentId)))
          .limit(1);
        const current = rows[0];
        if (!current) {
          return err(new NotFoundError(`Enrollment ${input.enrollmentId} not found.`));
        }

        const fromStatus = current.status as EnrollmentStatus;
        if (!isLegalStatusTransition(fromStatus, input.toStatus)) {
          return err(
            new ValidationError(`Cannot transition enrollment ${input.enrollmentId} from "${fromStatus}" to "${input.toStatus}".`),
          );
        }

        const exit = isExitStatus(input.toStatus);
        const updatedRows = await db
          .update(enrollmentTable)
          .set({
            status: input.toStatus,
            exitedOn: exit ? input.effectiveOn : null,
            exitReason: exit ? (input.reason ?? null) : null,
          })
          .where(and(eq(enrollmentTable.tenantId, tenantId), eq(enrollmentTable.id, input.enrollmentId)))
          .returning();
        const updated = updatedRows[0];
        if (!updated) {
          return err(new NotFoundError(`Enrollment ${input.enrollmentId} not found.`));
        }

        await db.insert(statusEventTable).values({
          id: newId(),
          tenantId,
          enrollmentId: input.enrollmentId,
          fromStatus,
          toStatus: input.toStatus,
          effectiveOn: input.effectiveOn,
          reason: input.reason ?? null,
          actorUserId: ctx.actorUserId ?? ctx.userId ?? null,
        });

        return ok(toEnrollment(updated));
      });
    } catch (error) {
      return err(toDomainError(error, `Could not transition enrollment ${input.enrollmentId}.`) as DomainError);
    }
  }

  async getEnrollment(tenantId: TenantId, id: string): Promise<Result<Enrollment, NotFoundError>> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(enrollmentTable).where(and(eq(enrollmentTable.tenantId, tenantId), eq(enrollmentTable.id, id))).limit(1),
    );
    const row = rows[0];
    return row ? ok(toEnrollment(row)) : err(new NotFoundError(`Enrollment ${id} not found.`));
  }

  /** Keyset-paginated (cursor = last-seen `id`, ascending - `id`s are UUIDv7 so this is creation order). */
  async listEnrollments(tenantId: TenantId, input: ListEnrollmentsInput): Promise<EnrollmentPage> {
    const ctx = scopedContext(tenantId);
    const limit = input.limit && input.limit > 0 ? Math.min(input.limit, MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT;

    const conditions = [eq(enrollmentTable.tenantId, tenantId)];
    if (input.academicYearId) {
      conditions.push(eq(enrollmentTable.academicYearId, input.academicYearId));
    }
    if (input.campusId) {
      conditions.push(eq(enrollmentTable.campusId, input.campusId));
    }
    if (input.gradeLevelId) {
      conditions.push(eq(enrollmentTable.gradeLevelId, input.gradeLevelId));
    }
    if (input.status) {
      conditions.push(eq(enrollmentTable.status, input.status));
    }
    if (input.cursor) {
      conditions.push(gt(enrollmentTable.id, input.cursor));
    }
    if (input.query) {
      const pattern = `%${input.query.trim()}%`;
      conditions.push(
        or(
          ilike(enrollmentTable.studentNumber, pattern),
          // People's name columns live in a sibling schema this package
          // cannot reach past @sms/people's public contract (a one-record-
          // at-a-time port, unsuited to a filtered list query) - same
          // established raw-cross-schema-SQL precedent as @sms/academic's
          // SectionEnrollmentService.listStudentsInSection.
          sql`exists (
            select 1 from people.person p
            where p.id = ${enrollmentTable.personId}
              and (p.given_name ilike ${pattern} or p.family_name ilike ${pattern})
          )`,
        )!,
      );
    }

    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(enrollmentTable)
        .where(and(...conditions))
        .orderBy(asc(enrollmentTable.id))
        .limit(limit + 1),
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

    return { items: page.map(toEnrollment), nextCursor };
  }

  /** Every `StatusEvent` for `enrollmentId`, oldest first - the full, unedited history (append-only in the database, see the `0700` migration). */
  async getStatusHistory(tenantId: TenantId, enrollmentId: string): Promise<StatusEvent[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(statusEventTable)
        .where(and(eq(statusEventTable.tenantId, tenantId), eq(statusEventTable.enrollmentId, enrollmentId)))
        .orderBy(asc(statusEventTable.createdAt)),
    );
    return rows.map(toStatusEvent);
  }

  /**
   * A plain campus reassignment - status is untouched, so no `StatusEvent`
   * is written (the status history only records STATUS transitions; which
   * campus a student is enrolled at is a plain field on `enrollment.
   * enrollment`, already covered by the generic audit history trigger every
   * table in this module carries).
   */
  async transferCampus(tenantId: TenantId, input: TransferCampusInput): Promise<Result<Enrollment, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(enrollmentTable)
          .set({ campusId: input.toCampusId })
          .where(and(eq(enrollmentTable.tenantId, tenantId), eq(enrollmentTable.id, input.enrollmentId)))
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError(`Enrollment ${input.enrollmentId} not found.`));
      }
      return ok(toEnrollment(row));
    } catch (error) {
      return err(toDomainError(error, `Could not transfer enrollment ${input.enrollmentId} to a new campus.`) as DomainError);
    }
  }
}
