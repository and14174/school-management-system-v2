import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { ConflictError, NotFoundError, newId, type DomainError, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { DecideCorrectionInput, ListCorrectionsInput, RequestCorrectionInput } from '../contract.js';
import type { GradeCorrection } from '../domain/types.js';
import { toCorrection } from '../infrastructure/mappers.js';
import { correctionTable, scoreTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * Requesting and deciding `gradebook.correction` rows - the ONLY path past a
 * LOCKED grading period that may change a `gradebook.score`'s `points`/
 * `status`. Append-only in the database
 * (`trg_forbid_correction_update`/`_delete` - see the `1000` migration);
 * this service only ever INSERTs a request and, once, UPDATEs its decision
 * fields.
 *
 * `decideCorrection` is the ONLY call site in this module that sets
 * `app.gradebook_correction_override` - the transaction-local escape hatch
 * `trg_check_score_lock` honours (see the `1000` migration header). It is
 * set with `set_config(..., true)` (SET LOCAL semantics - see
 * docs/decisions.md) immediately before the UPDATE it authorizes, inside the
 * SAME transaction as the decision, so it can never leak to any other write.
 */
@Injectable()
export class CorrectionService {
  /** `fromPoints`/`fromStatus` are RESOLVED from the score's current state, never accepted as caller input - so a correction can never be requested against the wrong starting value. */
  async requestCorrection(tenantId: TenantId, input: RequestCorrectionInput): Promise<Result<GradeCorrection, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const created = await withTenantTx(ctx, async (db) => {
        const scoreRows = await db.select().from(scoreTable).where(and(eq(scoreTable.tenantId, tenantId), eq(scoreTable.id, input.scoreId))).limit(1);
        const score = scoreRows[0];
        if (!score) {
          throw new NotFoundError(`Score ${input.scoreId} not found.`);
        }

        const rows = await db
          .insert(correctionTable)
          .values({
            id: newId(),
            tenantId,
            scoreId: input.scoreId,
            fromPoints: score.points,
            toPoints: input.toPoints ?? null,
            fromStatus: score.status,
            toStatus: input.toStatus,
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
      return err(toDomainError(error, `Could not request a correction for score ${input.scoreId}.`) as DomainError);
    }
  }

  /**
   * Decides a PENDING correction. Approving applies `toPoints`/`toStatus` to
   * the underlying `gradebook.score` in the SAME transaction as the
   * decision - the only way to change a score whose grading period is
   * locked (see this class's own doc comment). A correction that is not
   * currently `pending` cannot be decided again (`ConflictError`).
   */
  async decideCorrection(tenantId: TenantId, input: DecideCorrectionInput): Promise<Result<GradeCorrection, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const decided = await withTenantTx(ctx, async (db) => {
        const correctionRows = await db.select().from(correctionTable).where(and(eq(correctionTable.tenantId, tenantId), eq(correctionTable.id, input.correctionId))).limit(1);
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
          // The ONE and ONLY place a LOCKED score's points/status change -
          // trg_check_score_lock rejects every other write path outright.
          // SET LOCAL (is_local = true): transaction-scoped, exactly like
          // withTenantTx's own app.tenant_id - see docs/decisions.md.
          await db.execute(sql`select set_config('app.gradebook_correction_override', 'true', true)`);

          const scoreRows = await db
            .update(scoreTable)
            .set({ points: correction.toPoints, status: correction.toStatus })
            .where(and(eq(scoreTable.tenantId, tenantId), eq(scoreTable.id, correction.scoreId)))
            .returning();
          if (scoreRows.length === 0) {
            throw new NotFoundError(`Score ${correction.scoreId} not found.`);
          }
        }

        return updated;
      });
      return ok(toCorrection(decided));
    } catch (error) {
      return err(toDomainError(error, `Could not decide correction ${input.correctionId}.`) as DomainError);
    }
  }

  async listCorrections(tenantId: TenantId, input: ListCorrectionsInput): Promise<GradeCorrection[]> {
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
