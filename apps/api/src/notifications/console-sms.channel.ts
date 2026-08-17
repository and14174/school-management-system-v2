import { Injectable, Logger } from '@nestjs/common';
import { newId } from '@sms/kernel';
import type { NotificationChannel, SendInput, SendOutput } from '@sms/notifications';

/**
 * The `sms` channel adapter for `SMS_PROVIDER=console` (see `.env.example`):
 * writes to stdout instead of calling a real provider, exactly what
 * `.env.example`'s own comment on `SMS_PROVIDER` describes. A real provider
 * (Twilio, etc.) would be a second `NotificationChannel` implementation
 * registered under the same `'sms'` key, swapped in per tenant/country by
 * `NotificationChannelsModule` - never by this module changing.
 */
@Injectable()
export class ConsoleSmsChannel implements NotificationChannel {
  readonly channel = 'sms' as const;
  private readonly logger = new Logger('ConsoleSmsChannel');

  async send(input: SendInput): Promise<SendOutput> {
    this.logger.log(`SMS -> ${input.to}: ${input.body}`);
    return { providerMessageId: `console-sms-${newId()}` };
  }
}
