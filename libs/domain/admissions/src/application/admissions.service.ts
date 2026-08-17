import { Inject, Injectable } from '@nestjs/common';
import type { DomainError, NotFoundError, Result } from '@sms/kernel';
import type { AdmissionsContract, ListApplicationsInput, MoveStageInput, RecordDecisionInput, RecordDecisionResult, SubmitApplicationInput } from '../contract.js';
import type { Application, ApplicationDecision, ApplicationPage, ApplicationStageEvent } from '../domain/types.js';
import { currentTenantContext } from './current-context.js';
import { ApplicationRecordService } from './application-record.service.js';
import { DecisionService } from './decision.service.js';

/**
 * Implements `AdmissionsContract`. Thin composition layer over the individual
 * services - exactly the shape `EnrollmentService` composes
 * `EnrollmentRecordService`/`RolloverService` in `@sms/enrollment`. Every
 * method resolves the ambient tenant via `currentTenantContext()`; the
 * services underneath both take `tenantId` explicitly so they also work from
 * `seed.ts` and from tests with no ambient context at all.
 */
@Injectable()
export class AdmissionsService implements AdmissionsContract {
  constructor(
    @Inject(ApplicationRecordService) private readonly records: ApplicationRecordService,
    @Inject(DecisionService) private readonly decisions: DecisionService,
  ) {}

  submitApplication(input: SubmitApplicationInput): Promise<Result<Application, DomainError>> {
    return this.records.submitApplication(currentTenantContext().tenantId, input);
  }

  moveStage(input: MoveStageInput): Promise<Result<Application, DomainError>> {
    return this.records.moveStage(currentTenantContext().tenantId, input);
  }

  recordDecision(input: RecordDecisionInput): Promise<Result<RecordDecisionResult, DomainError>> {
    return this.decisions.recordDecision(currentTenantContext().tenantId, input);
  }

  getApplication(id: string): Promise<Result<Application, NotFoundError>> {
    return this.records.getApplication(currentTenantContext().tenantId, id);
  }

  listApplications(input?: ListApplicationsInput): Promise<ApplicationPage> {
    return this.records.listApplications(currentTenantContext().tenantId, input ?? {});
  }

  getStageHistory(applicationId: string): Promise<ApplicationStageEvent[]> {
    return this.records.getStageHistory(currentTenantContext().tenantId, applicationId);
  }

  getDecisionHistory(applicationId: string): Promise<ApplicationDecision[]> {
    return this.records.getDecisionHistory(currentTenantContext().tenantId, applicationId);
  }
}
