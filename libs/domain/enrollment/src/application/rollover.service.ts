import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { newId, todayDateOnly, type DomainError, type PersonId, type Result, type TenantId, err, ok } from '@sms/kernel';
import { runWithContext, withTenantTx, type Tx } from '@sms/db';
import { AUDIT_CONTRACT, type AuditContract } from '@sms/audit';
import type { RollOverYearInput } from '../contract.js';
import type { RolloverCounts, RolloverOutcome, RolloverResult } from '../domain/types.js';
import { enrollmentTable, rolloverRunTable, statusEventTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * Thrown from inside the `withTenantTx` a `dryRun` opens, purely to force
 * the underlying SQL transaction to ROLLBACK - `db.transaction()` (see
 * `@sms/db`'s `withTenantTx`) rolls back and rethrows whatever the callback
 * throws, exactly like `AuditService.withBulkOperation` relies on to mark a
 * failed run (see its own test). Carrying the computed `payload` on the
 * error itself is what lets `rollOverYear` recover the plan the dry run
 * computed, even though every write it made was just undone.
 */
class RolloverDryRunAbort extends Error {
  constructor(readonly payload: { outcomes: RolloverOutcome[]; counts: RolloverCounts }) {
    super('enrollment rollover dry run (expected rollback, not a real failure)');
  }
}

/**
 * `rollOverYear`'s implementation. See `EnrollmentContract.rollOverYear`'s
 * own doc comment for the contract this upholds; the key property is that
 * `applyRollover` below is the ONE place that decides which students get
 * promoted to which grade level (or skipped) - both `dryRun: true` and a
 * real run call it identically, differing only in whether the transaction
 * that ran it is allowed to commit. A preview computed by different logic
 * than the commit would be a preview that lies.
 */
@Injectable()
export class RolloverService {
  constructor(@Inject(AUDIT_CONTRACT) private readonly audit: AuditContract) {}

  async rollOverYear(tenantId: TenantId, input: RollOverYearInput): Promise<Result<RolloverResult, DomainError>> {
    const ctx = scopedContext(tenantId);

    // Fail fast, before touching any enrolment data - a locked/archived
    // target year is refused up front, for BOTH a dry run and a real run.
    // (The insert path a real run takes is separately gated by the same
    // check via enrollment.enrollment's own trg_assert_year_writable - see
    // the 0700 migration - this is a clean, early error rather than relying
    // on that trigger firing deep inside the loop below.)
    try {
      await withTenantTx(ctx, (db) => db.execute(sql`select tenancy.assert_year_writable(${input.toAcademicYearId})`));
    } catch (error) {
      return err(toDomainError(error, `Academic year ${input.toAcademicYearId} is not writable.`) as DomainError);
    }

    if (input.dryRun) {
      return this.previewRollover(tenantId, ctx, input);
    }
    return this.commitRollover(tenantId, ctx, input);
  }

  /** Runs the exact same write path a real run takes, then forces a rollback so nothing persists - see `RolloverDryRunAbort`'s own comment. */
  private async previewRollover(
    tenantId: TenantId,
    ctx: ReturnType<typeof scopedContext>,
    input: RollOverYearInput,
  ): Promise<Result<RolloverResult, DomainError>> {
    try {
      await withTenantTx(ctx, async (db) => {
        const { outcomes, counts } = await this.applyRollover(db, tenantId, ctx.actorUserId ?? ctx.userId ?? null, input);
        throw new RolloverDryRunAbort({ outcomes, counts });
      });
      /* istanbul ignore next -- withTenantTx above always throws (RolloverDryRunAbort at minimum). */
      throw new Error('unreachable: enrollment rollover dry run did not roll back as expected');
    } catch (error) {
      if (error instanceof RolloverDryRunAbort) {
        return ok({
          counts: error.payload.counts,
          outcomes: error.payload.outcomes,
          bulkOperationId: null,
          rolloverRunId: null,
          dryRun: true,
        });
      }
      return err(toDomainError(error, 'Could not preview academic year rollover.') as DomainError);
    }
  }

  /**
   * Runs inside `AuditContract.withBulkOperation` (via `runWithContext`,
   * since `AuditService` reads its tenant from ambient context, not a
   * parameter - see its own `requireTenantContext()`) so every row this
   * writes is stamped with a `bulk_operation_id`, and records an
   * `enrollment.rollover_run` row linking to it.
   */
  private async commitRollover(
    tenantId: TenantId,
    ctx: ReturnType<typeof scopedContext>,
    input: RollOverYearInput,
  ): Promise<Result<RolloverResult, DomainError>> {
    try {
      const result = await runWithContext(ctx, () =>
        this.audit.withBulkOperation(
          {
            kind: 'enrollment.rollover_year',
            summary: { fromAcademicYearId: input.fromAcademicYearId, toAcademicYearId: input.toAcademicYearId },
          },
          async (db) => {
            const { outcomes, counts } = await this.applyRollover(db, tenantId, ctx.actorUserId ?? ctx.userId ?? null, input);

            // The GUC withBulkOperation set on THIS transaction, before fn ran
            // - the same technique @sms/audit's own audit.spec.ts uses to read
            // it back. Every row applyRollover just wrote was stamped with
            // this same value by audit.record_history().
            const gucRows = await db.execute<{ id: string | null }>(sql`select current_setting('app.bulk_operation_id', true) as id`);
            const bulkOperationId = (gucRows as unknown as Array<{ id: string | null }>)[0]?.id ?? null;

            const rolloverRunId = newId();
            await db.insert(rolloverRunTable).values({
              id: rolloverRunId,
              tenantId,
              fromAcademicYearId: input.fromAcademicYearId,
              toAcademicYearId: input.toAcademicYearId,
              bulkOperationId,
              status: 'completed',
              counts: counts as unknown as Record<string, unknown>,
              completedAt: new Date(),
            });

            return { outcomes, counts, bulkOperationId, rolloverRunId };
          },
        ),
      );

      return ok({ ...result, dryRun: false });
    } catch (error) {
      return err(toDomainError(error, 'Could not roll over academic year.') as DomainError);
    }
  }

  /**
   * The one place that decides, for every currently-`enrolled` student in
   * `fromAcademicYearId`, whether they get a new `toAcademicYearId`
   * enrolment (promoted per `promotionMap`, retaining campus and student
   * number) or are skipped - and if promoted, writes the new
   * `enrollment.enrollment` row plus its opening `status_event` via `db`.
   * Called identically by `previewRollover` (whose transaction always rolls
   * back) and `commitRollover` (whose transaction commits) - see this
   * class's own doc comment.
   */
  private async applyRollover(
    db: Tx,
    tenantId: TenantId,
    actorUserId: string | null,
    input: RollOverYearInput,
  ): Promise<{ outcomes: RolloverOutcome[]; counts: RolloverCounts }> {
    const currentlyEnrolled = await db
      .select()
      .from(enrollmentTable)
      .where(
        and(
          eq(enrollmentTable.tenantId, tenantId),
          eq(enrollmentTable.academicYearId, input.fromAcademicYearId),
          eq(enrollmentTable.status, 'enrolled'),
        ),
      )
      .orderBy(asc(enrollmentTable.personId));

    const enrolledOn = todayDateOnly();
    const outcomes: RolloverOutcome[] = [];

    for (const row of currentlyEnrolled) {
      const toGradeLevelId = input.promotionMap[row.gradeLevelId];

      if (!toGradeLevelId) {
        outcomes.push({
          personId: row.personId as PersonId,
          fromEnrollmentId: row.id,
          toEnrollmentId: null,
          fromGradeLevelId: row.gradeLevelId,
          toGradeLevelId: null,
          result: 'skipped_no_mapping',
        });
        continue;
      }

      const existingRows = await db
        .select({ id: enrollmentTable.id })
        .from(enrollmentTable)
        .where(
          and(
            eq(enrollmentTable.tenantId, tenantId),
            eq(enrollmentTable.personId, row.personId),
            eq(enrollmentTable.academicYearId, input.toAcademicYearId),
          ),
        )
        .limit(1);
      const existing = existingRows[0];
      if (existing) {
        outcomes.push({
          personId: row.personId as PersonId,
          fromEnrollmentId: row.id,
          toEnrollmentId: existing.id,
          fromGradeLevelId: row.gradeLevelId,
          toGradeLevelId,
          result: 'skipped_already_enrolled',
        });
        continue;
      }

      const newEnrollmentId = newId();
      await db.insert(enrollmentTable).values({
        id: newEnrollmentId,
        tenantId,
        personId: row.personId,
        academicYearId: input.toAcademicYearId,
        campusId: row.campusId,
        gradeLevelId: toGradeLevelId,
        studentNumber: row.studentNumber,
        status: 'enrolled',
        enrolledOn,
        exitedOn: null,
        exitReason: null,
      });
      await db.insert(statusEventTable).values({
        id: newId(),
        tenantId,
        enrollmentId: newEnrollmentId,
        fromStatus: null,
        toStatus: 'enrolled',
        effectiveOn: enrolledOn,
        reason: `Rolled over from academic year ${input.fromAcademicYearId}`,
        actorUserId,
      });

      outcomes.push({
        personId: row.personId as PersonId,
        fromEnrollmentId: row.id,
        toEnrollmentId: newEnrollmentId,
        fromGradeLevelId: row.gradeLevelId,
        toGradeLevelId,
        result: 'promoted',
      });
    }

    const counts: RolloverCounts = {
      consideredCount: currentlyEnrolled.length,
      promotedCount: outcomes.filter((outcome) => outcome.result === 'promoted').length,
      skippedCount: outcomes.filter((outcome) => outcome.result !== 'promoted').length,
    };

    return { outcomes, counts };
  }
}
