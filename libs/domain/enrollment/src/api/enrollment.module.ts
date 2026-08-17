import { Module } from '@nestjs/common';
import { AccessModule } from '@sms/access';
import { AuditModule } from '@sms/audit';
import { ENROLLMENT_CONTRACT } from '../contract.js';
import { EnrollmentRecordService } from '../application/enrollment-record.service.js';
import { EnrollmentService } from '../application/enrollment.service.js';
import { RolloverService } from '../application/rollover.service.js';
import { EnrollmentsController } from './enrollments.controller.js';
import { RolloverController } from './rollover.controller.js';

/**
 * Exports `ENROLLMENT_CONTRACT` (not the concrete `EnrollmentService`) -
 * matching `@sms/people`'s `PeopleModule` shape. Imports `AccessModule`:
 * both controllers gate their routes with `@RequirePermission`, and
 * `EnrollmentsController` additionally calls `ACCESS_CONTRACT.
 * resolveScopeConstraints` directly (see that file's own comment).  Imports
 * `AuditModule`: `RolloverService` runs a real rollover inside
 * `AuditContract.withBulkOperation`.
 */
@Module({
  imports: [AccessModule, AuditModule],
  controllers: [EnrollmentsController, RolloverController],
  providers: [
    EnrollmentRecordService,
    RolloverService,
    EnrollmentService,
    { provide: ENROLLMENT_CONTRACT, useExisting: EnrollmentService },
  ],
  exports: [ENROLLMENT_CONTRACT],
})
export class EnrollmentModule {}
