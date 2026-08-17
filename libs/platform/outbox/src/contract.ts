import type { Tx } from '@sms/db';
import type { TenantId, UserId } from '@sms/kernel';

export const OUTBOX_CONTRACT = Symbol('OUTBOX_CONTRACT');

export interface OutboxMessage {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly topic: string;
  readonly payload: Record<string, unknown>;
  readonly requestId: string | null;
  readonly actorUserId: UserId | null;
  readonly occurredAt: Date;
  readonly publishedAt: Date | null;
  readonly attempts: number;
  readonly lastError: string | null;
}

export interface PublishInput {
  /**
   * Dotted and past tense: the event describes something that HAS happened, not
   * a command. `attendance.marked_absent`, not `attendance.mark_absent`.
   * Consumers subscribe to these strings, so renaming one is a breaking change.
   */
  readonly topic: string;
  readonly payload: Record<string, unknown>;
}

/** A handler for one topic. Registered by `apps/api`; see `OutboxDispatcher`. */
export interface OutboxSubscriber {
  readonly topic: string;
  handle(message: OutboxMessage): Promise<void>;
}

export const OUTBOX_SUBSCRIBERS = Symbol('OUTBOX_SUBSCRIBERS');

export interface OutboxContract {
  /**
   * Appends an event **inside the caller's transaction**.
   *
   * `tx` is required, not optional, and that is the entire point. If this
   * opened its own transaction, the event could commit while the fact rolled
   * back (notifying a parent about an absence that never happened) or the fact
   * could commit while the event was lost (a notification silently owed
   * forever). Passing the caller's `tx` is what makes the fact and the
   * announcement of it atomic.
   *
   * Callers therefore look like:
   *
   *   await withTenantTx(ctx, async (tx) => {
   *     await tx.insert(attendanceRecord).values(...);
   *     await outbox.publish(tx, { topic: 'attendance.marked_absent', payload });
   *   });
   */
  publish(tx: Tx, input: PublishInput): Promise<void>;

  /** Events for a tenant, newest first - for an admin "what happened" view. */
  listRecent(input?: { topic?: string; limit?: number }): Promise<OutboxMessage[]>;

  /** Unpublished messages that are due. System-scoped: the dispatcher sees every tenant. */
  claimPending(limit: number): Promise<OutboxMessage[]>;

  markPublished(id: string): Promise<void>;

  /** Records a failed delivery and schedules the next attempt with exponential backoff. */
  markFailed(id: string, error: string): Promise<void>;
}
