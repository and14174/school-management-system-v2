import { Module } from '@nestjs/common';
import { AccessModule } from '@sms/access';
import { AuditModule } from '@sms/audit';
import { NOTIFICATIONS_CONTRACT } from '../contract.js';
import { NotificationsService } from '../application/notifications.service.js';
import { AttendanceAbsenceSubscriber } from '../application/attendance-absence.subscriber.js';
import { NotificationsController } from './notifications.controller.js';

/**
 * Exports `NOTIFICATIONS_CONTRACT` (not the concrete `NotificationsService`)
 * - matching `@sms/documents`' `DocumentsModule` shape. Imports `AuditModule`
 * for `AUDIT_CONTRACT` (`NotificationsService.listDeliveries`'s access-log
 * write) and `AccessModule` for `RequirePermission`/`ACCESS_CONTRACT`, used
 * by `NotificationsController`.
 *
 * Deliberately does NOT provide `NOTIFICATION_CHANNEL_REGISTRY` or
 * `RECIPIENT_RESOLVER` - same reasoning as `@sms/documents`' `DocumentsModule`
 * not providing `DOCUMENT_TEMPLATE_REGISTRY` (see that file's own comment):
 * leaving them unbound here is what lets `apps/api`'s `@Global()`
 * `NotificationChannelsModule` override actually reach `NotificationsService`,
 * which lives inside THIS module's own DI container.
 *
 * Also exports `AttendanceAbsenceSubscriber` - `apps/api` registers it under
 * `OUTBOX_SUBSCRIBERS` (see `AttendanceAbsenceSubscriberModule`), the same
 * two-step "define here, wire in apps/api" split every other inversion in
 * this module uses.
 */
@Module({
  imports: [AuditModule, AccessModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    { provide: NOTIFICATIONS_CONTRACT, useExisting: NotificationsService },
    AttendanceAbsenceSubscriber,
  ],
  exports: [NOTIFICATIONS_CONTRACT, AttendanceAbsenceSubscriber],
})
export class NotificationsModule {}
