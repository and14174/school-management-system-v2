import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { ConflictError, NotFoundError, newId, type DomainError, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { DecideCorrectionInput, ListCorrectionsInput, RequestCorrectionInput } from '../contract.js';
import type { AttendanceCorrection } from '../domain/types.js';
import { toCorrection } from '../infrastructure/mappers.js';
import { correctionTable, recordTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * Requesting and deciding `attendance.correction` rows - the ONLY other path
 * (besides a free edit inside `ATTENDANCE_LOCK_WINDOW_HOURS`, see
 * `AttendanceRecordService`) that may change a locked `attendance.record`'s
 * `codeId`. Append-only in the database (`trg_forbid_correction_update`/
 * `_delete` - see the `0900` migration); this service only ever INSERTs a
 * request and, once, UPDATEs its decision fields.
 */
@Injectable()
export class AttendanceCorrectionService {
  /** `fromCodeId` is RESOLVED from the record's current code, never accepted as caller input - so a correction can never be requested against the wrong starting code. */
  async requestCorrection(tenantId: TenantId, input: RequestCorrectionInput): Promise<Result<AttendanceCorrection, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const created = await withTenantTx(ctx, async (db) => {
        const recordRows = await db
          .select()
          .from(recordTable)
          .where(and(eq(recordTable.tenantId, tenantId), eq(recordTable.id, input.recordId)))
          .limit(1);
        const record = recordRows[0];
        if (!record) {
          throw new NotFoundError(`Attendance record ${input.recordId} not found.`);
        }

        const rows = await db
          .insert(correctionTable)
          .values({
            id: newId(),
            tenantId,
            recordId: input.recordId,
            fromCodeId: record.codeId,
            toCodeId: input.toCodeId,
            reason: input.reason ?? null,
            requestedByUserId: ctx.actorUserId ?? ctx.userId ?? null,
            status: 'pending',
          })
          .returning();
        const row = rows[0];
        if (!row) {
          throw new NotFoundError('Insert returned no row.');
        }
        return row;
      });
      return ok(toCorrection(created));
    } catch (error) {
      return err(toDomainError(error, `Could not request a correction for attendance record ${input.recordId}.`) as DomainError);
    }
  }

  /**
   * Decides a PENDING correction. Approving applies `toCodeId` to the
   * underlying `attendance.record` in the SAME transaction as the decision -
   * the only way to change a record locked past the free-edit window (see
   * `AttendanceRecordService`'s own comment). A correction that is not
   * currently `pending` cannot be decided again (`ConflictError`) - a
   * decision is made once.
   */
  async decideCorrection(tenantId: TenantId, input: DecideCorrectionInput): Promise<Result<AttendanceCorrection, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const decided = await withTenantTx(ctx, async (db) => {
        const correctionRows = await db
          .select()
          .from(correctionTable)
          .where(and(eq(correctionTable.tenantId, tenantId), eq(correctionTable.id, input.correctionId)))
          .limit(1);
        const correction = correctionRows[0];
        if (!correction) {
          throw new NotFoundError(`Correction ${input.correctionId} not found.`);
        }
        if (correction.status !== 'pending') {
          throw new ConflictError(`Correction ${input.correctionId} has already been decided (status: ${correction.status}).`);
        }

        const decidedAt = new Date();
        const updatedRows = await db
          .update(correctionTable)
          .set({
            status: input.approve ? 'approved' : 'rejected',
            decidedByUserId: ctx.actorUserId ?? ctx.userId ?? null,
            decidedAt,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
          })
          .where(eq(correctionTable.id, correction.id))
          .returning();
        const updated = updatedRows[0];
        if (!updated) {
          throw new NotFoundError('Update returned no row.');
        }

        if (input.approve) {
          // The one and only place `codeId` changes on a LOCKED record -
          // markSession itself refuses past the free-edit window.
          const recordRows = await db
            .update(recordTable)
            .set({ codeId: correction.toCodeId })
            .where(and(eq(recordTable.tenantId, tenantId), eq(recordTable.id, correction.recordId)))
            .returning();
          if (recordRows.length === 0) {
            throw new NotFoundError(`Attendance record ${correction.recordId} not found.`);
          }
        }

        return updated;
      });
      return ok(toCorrection(decided));
    } catch (error) {
      return err(toDomainError(error, `Could not decide correction ${input.correctionId}.`) as DomainError);
    }
  }

  async listCorrections(tenantId: TenantId, input: ListCorrectionsInput): Promise<AttendanceCorrection[]> {
    const ctx = scopedContext(tenantId);
    const conditions = [eq(correctionTable.tenantId, tenantId)];
    if (input.status) {
      conditions.push(eq(correctionTable.status, input.status));
    }
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(correctionTable)
        .where(and(...conditions))
        .orderBy(desc(correctionTable.createdAt)),
    );
    return rows.map(toCorrection);
  }
}
