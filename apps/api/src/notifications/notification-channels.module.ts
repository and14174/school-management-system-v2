import { Global, Module } from '@nestjs/common';
import { PeopleModule } from '@sms/people';
import {
  MapNotificationChannelRegistry,
  NOTIFICATION_CHANNEL_REGISTRY,
  RECIPIENT_RESOLVER,
  type NotificationChannelRegistry,
} from '@sms/notifications';
import { NodemailerEmailChannel } from './email.channel.js';
import { ConsoleSmsChannel } from './console-sms.channel.js';
import { GuardianRecipientResolverService } from './guardian-recipient-resolver.js';

/**
 * `@Global()`: this is what actually lets `@sms/notifications`'
 * `NotificationsService` (living inside `NotificationsModule`'s own DI
 * container) see the `NOTIFICATION_CHANNEL_REGISTRY`/`RECIPIENT_RESOLVER`
 * overrides - exactly the reasoning `DocumentTemplatesModule`/
 * `ImportTargetsModule` document for their own tokens (same file shape, same
 * precedent): `@sms/notifications` deliberately does not register either
 * token itself, so a `@Global()` module's exports are the one mechanism
 * that reaches into `NotificationsModule`'s container without it ever
 * importing this one (`@nx/enforce-module-boundaries` forbids `type:
 * platform -> type:domain` outright, and `NodemailerEmailChannel` needs a
 * concrete provider SDK this module - `type:platform` - must never import).
 * `apps/api`'s `AppModule` still has to import this module once for Nest to
 * instantiate it.
 *
 * Two real channels registered - `email` (nodemailer -> Mailpit) and `sms`
 * (`SMS_PROVIDER=console`, writes to stdout) - plus the real
 * `RECIPIENT_RESOLVER`, walking `people.relationship` for a student's
 * guardians. `push` has no adapter yet; a delivery attempted on it fails
 * with "no channel adapter registered", never silently drops.
 */
@Global()
@Module({
  imports: [PeopleModule],
  providers: [
    NodemailerEmailChannel,
    ConsoleSmsChannel,
    GuardianRecipientResolverService,
    {
      provide: NOTIFICATION_CHANNEL_REGISTRY,
      useFactory: (email: NodemailerEmailChannel, sms: ConsoleSmsChannel): NotificationChannelRegistry =>
        new MapNotificationChannelRegistry([email, sms]),
      inject: [NodemailerEmailChannel, ConsoleSmsChannel],
    },
    { provide: RECIPIENT_RESOLVER, useExisting: GuardianRecipientResolverService },
  ],
  exports: [NOTIFICATION_CHANNEL_REGISTRY, RECIPIENT_RESOLVER],
})
export class NotificationChannelsModule {}
