import { Global, Module } from '@nestjs/common';
import { OUTBOX_SUBSCRIBERS, type OutboxSubscriber } from '@sms/outbox';
import { AttendanceAbsenceSubscriber, NotificationsModule } from '@sms/notifications';

/**
 * `@Global()`: this is what actually lets `@sms/outbox`'s `OutboxDispatcher`
 * (living inside `OutboxModule`'s own DI container) see the
 * `OUTBOX_SUBSCRIBERS` override - exactly the reasoning
 * `DocumentTemplatesModule`/`ImportTargetsModule`/`NotificationChannelsModule`
 * document for their own tokens (same file shape, same precedent):
 * `@sms/outbox` deliberately does not register this token itself (see
 * `OutboxDispatcher`'s own `@Optional()` constructor comment), so this is the
 * one mechanism that reaches into `OutboxModule`'s container. `apps/api`'s
 * `AppModule` still has to import this module once for Nest to instantiate
 * it.
 *
 * `AttendanceAbsenceSubscriber` itself is defined in `@sms/notifications`
 * (it only needs `NOTIFICATIONS_CONTRACT`, never `@sms/attendance` - see its
 * own comment) and exported by `NotificationsModule`; this is only the
 * "register it as a subscriber" wiring step. Further subscribers (billing
 * due-date reminders, admissions decisions, ...) register the same way: add
 * them to the array below.
 */
@Global()
@Module({
  imports: [NotificationsModule],
  providers: [
    {
      provide: OUTBOX_SUBSCRIBERS,
      useFactory: (attendanceAbsence: AttendanceAbsenceSubscriber): OutboxSubscriber[] => [attendanceAbsence],
      inject: [AttendanceAbsenceSubscriber],
    },
  ],
  exports: [OUTBOX_SUBSCRIBERS],
})
export class AttendanceAbsenceSubscriberModule {}
