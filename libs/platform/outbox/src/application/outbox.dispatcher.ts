import { Inject, Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import { OUTBOX_CONTRACT, OUTBOX_SUBSCRIBERS, type OutboxContract, type OutboxSubscriber } from '../contract.js';

const BATCH_SIZE = 100;
const IDLE_POLL_MS = 2000;

/**
 * Drains `outbox.message` and hands each event to every subscriber for its topic.
 *
 * Delivery is at-least-once, not exactly-once. A subscriber can be handed the
 * same event twice - if the process dies after the handler ran but before the
 * row was marked published, the next pass sees it again. Making that
 * unobservable is the SUBSCRIBER's job (send with an idempotency key, upsert a
 * projection by primary key, and so on); the alternative, marking published
 * before handling, silently drops events instead, which is worse.
 *
 * An event with no subscriber is marked published rather than retried forever:
 * "nobody is listening yet" is a normal state for a young system, not a failure.
 */
@Injectable()
export class OutboxDispatcher implements OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    @Inject(OUTBOX_CONTRACT) private readonly outbox: OutboxContract,
    @Optional() @Inject(OUTBOX_SUBSCRIBERS) private readonly subscribers: OutboxSubscriber[] = [],
  ) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), IDLE_POLL_MS);
    // Node should not be held open purely by the dispatcher's poll timer.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass. Exposed so tests can drive it deterministically instead of waiting on the timer. */
  async tick(): Promise<{ handled: number; failed: number }> {
    if (this.running) return { handled: 0, failed: 0 };
    this.running = true;
    let handled = 0;
    let failed = 0;

    try {
      const batch = await this.outbox.claimPending(BATCH_SIZE);

      for (const message of batch) {
        const forTopic = this.subscribers.filter((s) => s.topic === message.topic);
        try {
          for (const subscriber of forTopic) {
            await subscriber.handle(message);
          }
          await this.outbox.markPublished(message.id);
          handled += 1;
        } catch (error) {
          await this.outbox.markFailed(message.id, error instanceof Error ? error.message : String(error));
          failed += 1;
        }
      }
    } finally {
      this.running = false;
    }

    return { handled, failed };
  }
}
