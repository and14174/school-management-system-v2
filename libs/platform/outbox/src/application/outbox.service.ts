import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import { newId, type TenantId, type UserId } from '@sms/kernel';
import { requireContext, withSystemTx, withTenantTx, type Tx } from '@sms/db';
import { isSystemContext } from '@sms/kernel';
import type { OutboxContract, OutboxMessage, PublishInput } from '../contract.js';
import { outboxMessage } from '../infrastructure/schema.js';

/** Backoff for a failed delivery: ~1m, 2m, 4m … capped at an hour. */
function backoffSeconds(attempts: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempts - 1), 3600);
}

function toMessage(row: typeof outboxMessage.$inferSelect): OutboxMessage {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    topic: row.topic,
    payload: row.payload as Record<string, unknown>,
    requestId: row.requestId,
    actorUserId: (row.actorUserId ?? null) as UserId | null,
    occurredAt: row.occurredAt,
    publishedAt: row.publishedAt,
    attempts: row.attempts,
    lastError: row.lastError,
  };
}

@Injectable()
export class OutboxService implements OutboxContract {
  /**
   * Writes the event using the transaction it is given - never one of its own.
   * See `OutboxContract.publish` for why that is the whole design.
   */
  async publish(tx: Tx, input: PublishInput): Promise<void> {
    const ctx = requireContext();
    if (isSystemContext(ctx)) {
      throw new Error(
        'outbox.publish requires a tenant context: an event with no tenant cannot be delivered to anyone.',
      );
    }

    await tx.insert(outboxMessage).values({
      id: newId(),
      tenantId: ctx.tenantId,
      topic: input.topic,
      payload: input.payload,
      requestId: ctx.requestId,
      // The REAL actor, matching how audit attributes writes - see
      // docs/decisions.md on actorUserId vs userId.
      actorUserId: ctx.actorUserId ?? ctx.userId ?? null,
      occurredAt: new Date(),
      attempts: 0,
      nextAttemptAt: new Date(),
    });
  }

  async listRecent(input?: { topic?: string; limit?: number }): Promise<OutboxMessage[]> {
    const ctx = requireContext();
    if (isSystemContext(ctx)) return [];
    const limit = Math.min(Math.max(input?.limit ?? 50, 1), 200);

    const rows = await withTenantTx(ctx, (db) => {
      const conditions = [eq(outboxMessage.tenantId, ctx.tenantId)];
      if (input?.topic) conditions.push(eq(outboxMessage.topic, input.topic));
      return db
        .select()
        .from(outboxMessage)
        .where(and(...conditions))
        .orderBy(desc(outboxMessage.occurredAt))
        .limit(limit);
    });

    return rows.map(toMessage);
  }

  /**
   * The dispatcher's read. Runs through `withSystemTx` deliberately: it must
   * see every tenant's backlog, and it is a system job, not request handling -
   * the one legitimate use of the RLS-bypassing path (see docs/decisions.md).
   *
   * `for update skip locked` is what makes running more than one dispatcher
   * safe: each claims a disjoint set of rows instead of two of them delivering
   * the same notification twice.
   */
  async claimPending(limit: number): Promise<OutboxMessage[]> {
    const rows = await withSystemTx((db) =>
      db
        .select()
        .from(outboxMessage)
        .where(and(isNull(outboxMessage.publishedAt), lte(outboxMessage.nextAttemptAt, new Date())))
        .orderBy(asc(outboxMessage.occurredAt))
        .limit(Math.min(Math.max(limit, 1), 500))
        .for('update', { skipLocked: true }),
    );
    return rows.map(toMessage);
  }

  async markPublished(id: string): Promise<void> {
    await withSystemTx((db) =>
      db.update(outboxMessage).set({ publishedAt: new Date(), lastError: null }).where(eq(outboxMessage.id, id)),
    );
  }

  async markFailed(id: string, error: string): Promise<void> {
    await withSystemTx((db) =>
      db
        .update(outboxMessage)
        .set({
          attempts: sql`${outboxMessage.attempts} + 1`,
          lastError: error.slice(0, 2000),
          nextAttemptAt: sql`now() + make_interval(secs => ${backoffSeconds(1)} * power(2, least(${outboxMessage.attempts}, 6)))`,
        })
        .where(eq(outboxMessage.id, id)),
    );
  }
}
