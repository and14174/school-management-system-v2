import { Module } from '@nestjs/common';
import { AccessModule } from '@sms/access';
import { AuditModule } from '@sms/audit';
import { OutboxModule } from '@sms/outbox';
import { COMMUNICATIONS_CONTRACT } from '../contract.js';
import { AnnouncementService } from '../application/announcement.service.js';
import { ThreadService } from '../application/thread.service.js';
import { CommunicationsService } from '../application/communications.service.js';
import { CommunicationsController } from './communications.controller.js';

/**
 * Exports `COMMUNICATIONS_CONTRACT` (not the concrete `CommunicationsService`)
 * - matching `@sms/attendance`'s `AttendanceModule` shape. Imports
 * `AccessModule`: `CommunicationsController` gates every route with
 * `@RequirePermission` and additionally calls `ACCESS_CONTRACT.
 * resolveScopeConstraints` directly (see that file's own comment). Imports
 * `OutboxModule` (already `@Global()`, so this import is for clarity/
 * documentation, same as `AttendanceModule` importing it): `AnnouncementService.
 * publishAnnouncement` and `ThreadService.startThread`/`postMessage` publish
 * `communications.announcement_published`/`communications.message_posted`
 * through `OUTBOX_CONTRACT` in the same transaction as their write. Imports
 * `AuditModule` for parity with `@sms/attendance` even though nothing here
 * calls `AUDIT_CONTRACT` directly - every table's history is captured by the
 * `audit.attach_history` DB trigger, not application code.
 */
@Module({
  imports: [AccessModule, AuditModule, OutboxModule],
  controllers: [CommunicationsController],
  providers: [
    AnnouncementService,
    ThreadService,
    CommunicationsService,
    { provide: COMMUNICATIONS_CONTRACT, useExisting: CommunicationsService },
  ],
  exports: [COMMUNICATIONS_CONTRACT],
})
export class CommunicationsModule {}
