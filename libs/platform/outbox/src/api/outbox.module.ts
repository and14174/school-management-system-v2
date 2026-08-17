import { Global, Inject, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { OUTBOX_CONTRACT } from '../contract.js';
import { OutboxService } from '../application/outbox.service.js';
import { OutboxDispatcher } from '../application/outbox.dispatcher.js';

/**
 * `@Global()` so any module can inject `OUTBOX_CONTRACT` without importing this
 * one - publishing an event is meant to be as unremarkable as writing a row.
 *
 * Subscribers are provided by `apps/api` under `OUTBOX_SUBSCRIBERS`, so this
 * module never depends on the domain modules that consume its events.
 */
@Global()
@Module({
  providers: [OutboxService, { provide: OUTBOX_CONTRACT, useExisting: OutboxService }, OutboxDispatcher],
  exports: [OUTBOX_CONTRACT, OutboxDispatcher],
})
export class OutboxModule implements OnApplicationBootstrap {
  // Explicit @Inject(), not implicit type-based DI. Under tsx/esbuild's
  // decorator-metadata emission the implicit form resolves to `undefined` at
  // runtime, so `onApplicationBootstrap` threw "Cannot read properties of
  // undefined (reading 'start')" and took the whole API down at boot. It went
  // unnoticed because nothing imported this module into the real app graph
  // until attendance did - the unit tests construct OutboxDispatcher directly.
  // Every other module in this codebase uses the explicit form for the same
  // reason; this one was the exception.
  constructor(@Inject(OutboxDispatcher) private readonly dispatcher: OutboxDispatcher) {}

  onApplicationBootstrap(): void {
    this.dispatcher.start();
  }
}
