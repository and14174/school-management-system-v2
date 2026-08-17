import { Inject, Injectable } from '@nestjs/common';
import type { DomainError, NotFoundError, Result } from '@sms/kernel';
import type {
  EnrollmentContract,
  EnrolStudentInput,
  ListEnrollmentsInput,
  RollOverYearInput,
  TransferCampusInput,
  TransitionStatusInput,
} from '../contract.js';
import type { Enrollment, EnrollmentPage, RolloverResult, StatusEvent } from '../domain/types.js';
import { currentTenantContext } from './current-context.js';
import { EnrollmentRecordService } from './enrollment-record.service.js';
import { RolloverService } from './rollover.service.js';

/**
 * Implements `EnrollmentContract`. Thin composition layer over the
 * individual services - exactly the shape `AcademicService` composes
 * `SectionService`/`TermService`/... in `@sms/academic`. Every method
 * resolves the ambient tenant via `currentTenantContext()`; the services
 * underneath both take `tenantId` explicitly so they also work from
 * `seed.ts` and from tests with no ambient context at all.
 */
@Injectable()
export class EnrollmentService implements EnrollmentContract {
  constructor(
    @Inject(EnrollmentRecordService) private readonly records: EnrollmentRecordService,
    @Inject(RolloverService) private readonly rollover: RolloverService,
  ) {}

  enrolStudent(input: EnrolStudentInput): Promise<Result<Enrollment, DomainError>> {
    return this.records.enrolStudent(currentTenantContext().tenantId, input);
  }

  transitionStatus(input: TransitionStatusInput): Promise<Result<Enrollment, DomainError>> {
    return this.records.transitionStatus(currentTenantContext().tenantId, input);
  }

  getEnrollment(id: string): Promise<Result<Enrollment, NotFoundError>> {
    return this.records.getEnrollment(currentTenantContext().tenantId, id);
  }

  listEnrollments(input?: ListEnrollmentsInput): Promise<EnrollmentPage> {
    return this.records.listEnrollments(currentTenantContext().tenantId, input ?? {});
  }

  getStatusHistory(enrollmentId: string): Promise<StatusEvent[]> {
    return this.records.getStatusHistory(currentTenantContext().tenantId, enrollmentId);
  }

  transferCampus(input: TransferCampusInput): Promise<Result<Enrollment, DomainError>> {
    return this.records.transferCampus(currentTenantContext().tenantId, input);
  }

  rollOverYear(input: RollOverYearInput): Promise<Result<RolloverResult, DomainError>> {
    return this.rollover.rollOverYear(currentTenantContext().tenantId, input);
  }
}
