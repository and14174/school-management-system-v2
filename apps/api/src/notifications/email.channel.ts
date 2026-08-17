import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';
import type { NotificationChannel, SendInput, SendOutput } from '@sms/notifications';
import type { AppEnv } from '../config/env.schema.js';

/**
 * The real `email` channel adapter - nodemailer against `SMTP_URL`
 * (Mailpit locally, see `.env.example`). `@sms/notifications` never imports
 * `nodemailer` itself for its own logic (only as a devDependency, to ship
 * the port's TypeScript types); this is the one place a provider SDK is
 * wired to the `NOTIFICATION_CHANNEL_REGISTRY` port - `apps/api` is the
 * layer allowed to make that choice per tenant/country (see that port's own
 * comment).
 */
@Injectable()
export class NodemailerEmailChannel implements NotificationChannel, OnModuleDestroy {
  readonly channel = 'email' as const;
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(@Inject(ConfigService) configService: ConfigService<AppEnv, true>) {
    this.transporter = nodemailer.createTransport(configService.get('SMTP_URL', { infer: true }));
    this.from = configService.get('MAIL_FROM', { infer: true });
  }

  async send(input: SendInput): Promise<SendOutput> {
    const info = await this.transporter.sendMail({
      from: this.from,
      to: input.to,
      subject: input.subject,
      text: input.body,
    });
    return { providerMessageId: info.messageId };
  }

  async onModuleDestroy(): Promise<void> {
    this.transporter.close();
  }
}
