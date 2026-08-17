import { Module } from '@nestjs/common';
import { AccessModule } from '@sms/access';
import { AuditModule } from '@sms/audit';
import { OutboxModule } from '@sms/outbox';
import { ATTENDANCE_CONTRACT } from '../contract.js';
import { AttendanceCodeService } from '../application/code.service.js';
import { AttendanceCorrectionService } from '../application/correction.service.js';
import { AttendanceRecordService } from '../application/attendance-record.service.js';
import { AttendanceService } from '../application/attendance.service.js';
import { AttendanceController } from './attendance.controller.js';

/**
 * Exports `ATTENDANCE_CONTRACT` (not the concrete `AttendanceService`) -
 * matching `@sms/enrollment`'s `EnrollmentModule` shape. Imports
 * `AccessModule`: `AttendanceController` gates every route with
 * `@RequirePermission` and additionally calls `ACCESS_CONTRACT.
 * resolveScopeConstraints` directly (see that file's own comment). Imports
 * `OutboxModule` (already `@Global()`, so this import is for clarity/
 * documentation, same as `EnrollmentModule` importing `AuditModule`):
 * `AttendanceRecordService.markSession` publishes `attendance.marked_absent`
 * through `OUTBOX_CONTRACT` in the same transaction as the mark. Imports
 * `AuditModule` per this module's dependency list even though nothing here
 * calls `AUDIT_CONTRACT` directly today (every table's history is captured
 * automatically by the `audit.attach_history` DB trigger, not application
 * code) - kept for parity with `@sms/enrollment` and in case a future bulk-
 * marking / bulk-correction feature needs `withBulkOperation`.
 */
@Module({
  imports: [AccessModule, AuditModule, OutboxModule],
  controllers: [AttendanceController],
  providers: [
    AttendanceCodeService,
    AttendanceRecordService,
    AttendanceCorrectionService,
    AttendanceService,
    { provide: ATTENDANCE_CONTRACT, useExisting: AttendanceService },
  ],
  exports: [ATTENDANCE_CONTRACT],
})
export class AttendanceModule {}
