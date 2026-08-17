import { Module } from '@nestjs/common';
import { AccessModule } from '@sms/access';
import { OutboxModule } from '@sms/outbox';
import { PeopleModule } from '@sms/people';
import { EnrollmentModule } from '@sms/enrollment';
import { ADMISSIONS_CONTRACT } from '../contract.js';
import { AdmissionsService } from '../application/admissions.service.js';
import { ApplicationRecordService } from '../application/application-record.service.js';
import { DecisionService } from '../application/decision.service.js';
import { AdmissionsController } from './admissions.controller.js';

/**
 * Exports `ADMISSIONS_CONTRACT` (not the concrete `AdmissionsService`) -
 * matching `@sms/enrollment`'s `EnrollmentModule` shape. Imports
 * `AccessModule` (`AdmissionsController` gates every route with
 * `@RequirePermission` - see that file's own comment for why it does NOT
 * additionally call `resolveScopeConstraints`), `OutboxModule`
 * (`admissions.application_submitted`/`admissions.decision_recorded`,
 * published through `OUTBOX_CONTRACT` in the same transaction as the write
 * that earns them), `PeopleModule` (`DecisionService.ensureConverted`
 * creates a `people.person` on acceptance when the family wasn't already
 * known) and `EnrollmentModule` (`DecisionService.ensureConverted` hands the
 * accepted applicant to `ENROLLMENT_CONTRACT.enrolStudent`) - see
 * `DecisionService`'s own comment for why these are reached through their
 * public contracts rather than this module owning any enrolment/person
 * logic itself.
 */
@Module({
  imports: [AccessModule, OutboxModule, PeopleModule, EnrollmentModule],
  controllers: [AdmissionsController],
  providers: [
    ApplicationRecordService,
    DecisionService,
    AdmissionsService,
    { provide: ADMISSIONS_CONTRACT, useExisting: AdmissionsService },
  ],
  exports: [ADMISSIONS_CONTRACT],
})
export class AdmissionsModule {}
