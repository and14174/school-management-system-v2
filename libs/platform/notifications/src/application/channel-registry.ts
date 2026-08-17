import type { NotificationChannelName } from '../domain/types.js';

export interface SendInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

export interface SendOutput {
  readonly providerMessageId?: string;
}

/**
 * One channel's adapter. `apps/api` registers the real ones - email
 * (nodemailer -> Mailpit locally) and console-SMS (`SMS_PROVIDER=console`,
 * see `.env.example`) - against real provider SDKs this module (`type:
 * platform`) must never import directly, since provider choice varies per
 * tenant and per country. `send` throwing is how a failed delivery is
 * reported; `NotificationsService.notify` catches it and records the
 * failure on the delivery row rather than losing it.
 */
export interface NotificationChannel {
  readonly channel: NotificationChannelName;
  send(input: SendInput): Promise<SendOutput>;
}

/**
 * The inversion point - exactly the pattern `@sms/documents` uses for
 * `DOCUMENT_TEMPLATE_REGISTRY` and `@sms/access` uses for
 * `SECTION_SCOPE_RESOLVER`: this module defines the port and a safe default
 * that resolves to nothing; `apps/api` is the one layer allowed to depend on
 * concrete provider SDKs (nodemailer) and registers the real adapters there.
 */
export interface NotificationChannelRegistry {
  get(channel: string): NotificationChannel | undefined;
}

export const NOTIFICATION_CHANNEL_REGISTRY = Symbol('NOTIFICATION_CHANNEL_REGISTRY');

/**
 * The safe default: an unregistered channel must never silently resolve to
 * something that pretends to send - `NotificationsService` treats a missing
 * adapter as a failed delivery (see its own comment), never as success.
 */
export const DEFAULT_NOTIFICATION_CHANNEL_REGISTRY: NotificationChannelRegistry = {
  get: () => undefined,
};

/**
 * An in-memory channel, shipped from this module (not `apps/api`) for this
 * module's own test suite and for any other test that needs a fake channel
 * without spinning up Mailpit - same precedent as `@sms/documents` shipping
 * `sampleCertificateTemplate` inside itself (see that file's own comment:
 * "no real domain template exists yet ... for this module's own test
 * suite").
 *
 * `behavior` lets a test simulate a provider failure (return `'throw'`)
 * without a real network dependency - see test 5 in the module report:
 * "a channel that throws records failed with the error".
 */
export class InMemoryNotificationChannel implements NotificationChannel {
  readonly sent: SendInput[] = [];

  constructor(
    readonly channel: NotificationChannelName,
    private readonly behavior?: (input: SendInput) => SendOutput | 'throw',
  ) {}

  async send(input: SendInput): Promise<SendOutput> {
    if (this.behavior) {
      const outcome = this.behavior(input);
      if (outcome === 'throw') {
        throw new Error(`InMemoryNotificationChannel(${this.channel}): simulated delivery failure`);
      }
      this.sent.push(input);
      return outcome;
    }
    this.sent.push(input);
    return { providerMessageId: `mem-${this.channel}-${this.sent.length}` };
  }
}

/** A `NotificationChannelRegistry` backed by a plain `Map` - the shape every real registry (`apps/api`'s included) ends up being. */
export class MapNotificationChannelRegistry implements NotificationChannelRegistry {
  private readonly channels = new Map<string, NotificationChannel>();

  constructor(channels: readonly NotificationChannel[] = []) {
    for (const channel of channels) {
      this.channels.set(channel.channel, channel);
    }
  }

  register(channel: NotificationChannel): void {
    this.channels.set(channel.channel, channel);
  }

  get(channel: string): NotificationChannel | undefined {
    return this.channels.get(channel);
  }
}
