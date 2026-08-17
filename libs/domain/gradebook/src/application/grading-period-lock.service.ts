import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { newId, type DomainError, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { GradingPeriodLock } from '../domain/types.js';
import { toGradingPeriodLock } from '../infrastructure/mappers.js';
import { gradingPeriodLockTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * Locks/unlocks a grading period - see the `1000` migration header:
 * `gradebook.grading_period_lock.locked` is what `trg_check_score_lock`
 * enforces against on every `gradebook.score` write. This service only ever
 * upserts that flag; the actual enforcement lives in the database, not here.
 */
@Injectable()
export class GradingPeriodLockService {
  async lockGradingPeriod(tenantId: TenantId, gradingPeriodId: string, userId?: string): Promise<Result<GradingPeriodLock, DomainError>> {
    return this.setLocked(tenantId, gradingPeriodId, true, userId);
  }

  async unlockGradingPeriod(tenantId: TenantId, gradingPeriodId: string, userId?: string): Promise<Result<GradingPeriodLock, DomainError>> {
    return this.setLocked(tenantId, gradingPeriodId, false, userId);
  }

  private async setLocked(tenantId: TenantId, gradingPeriodId: string, locked: boolean, userId?: string): Promise<Result<GradingPeriodLock, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const row = await withTenantTx(ctx, async (db) => {
        const existing = await db
          .select()
          .from(gradingPeriodLockTable)
          .where(and(eq(gradingPeriodLockTable.tenantId, tenantId), eq(gradingPeriodLockTable.gradingPeriodId, gradingPeriodId)))
          .limit(1);

        const now = new Date();
        if (existing[0]) {
          const rows = await db
            .update(gradingPeriodLockTable)
            .set(
              locked
                ? { locked: true, lockedByUserId: userId ?? null, lockedAt: now }
                : { locked: false, unlockedByUserId: userId ?? null, unlockedAt: now },
            )
            .where(eq(gradingPeriodLockTable.id, existing[0].id))
            .returning();
          return rows[0]!;
        }

        const rows = await db
          .insert(gradingPeriodLockTable)
          .values({
            id: newId(),
            tenantId,
            gradingPeriodId,
            locked,
            ...(locked ? { lockedByUserId: userId ?? null, lockedAt: now } : { unlockedByUserId: userId ?? null, unlockedAt: now }),
          })
          .returning();
        return rows[0]!;
      });
      return ok(toGradingPeriodLock(row));
    } catch (error) {
      return err(toDomainError(error, `Could not ${locked ? 'lock' : 'unlock'} grading period ${gradingPeriodId}.`) as DomainError);
    }
  }

  async getGradingPeriodLock(tenantId: TenantId, gradingPeriodId: string): Promise<GradingPeriodLock | null> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(gradingPeriodLockTable)
        .where(and(eq(gradingPeriodLockTable.tenantId, tenantId), eq(gradingPeriodLockTable.gradingPeriodId, gradingPeriodId)))
        .limit(1),
    );
    const row = rows[0];
    return row ? toGradingPeriodLock(row) : null;
  }
}
