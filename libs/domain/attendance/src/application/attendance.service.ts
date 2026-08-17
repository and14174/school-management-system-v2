import { Inject, Injectable } from '@nestjs/common';
import type { DateOnly, DomainError, NotFoundError, Result } from '@sms/kernel';
import type {
  AttendanceContract,
  CreateCodeInput,
  DecideCorrectionInput,
  GetAttendanceSummaryInput,
  GetSessionRosterInput,
  ListCorrectionsInput,
  ListUnmarkedSessionsInput,
  MarkSessionInput,
  MarkSessionResult,
  RequestCorrectionInput,
  UpdateCodeInput,
} from '../contract.js';
import type {
  AttendanceCode,
  AttendanceCorrection,
  AttendanceSummary,
  SectionMeetingContext,
  SessionRoster,
  UnmarkedSession,
} from '../domain/types.js';
import { AttendanceCodeService } from './code.service.js';
import { AttendanceCorrectionService } from './correction.service.js';
import { AttendanceRecordService } from './attendance-record.service.js';
import { currentTenantContext } from './current-context.js';

/**
 * Implements `AttendanceContract`. Thin composition layer over the
 * individual services - exactly the shape `EnrollmentService` composes
 * `EnrollmentRecordService`/`RolloverService` in `@sms/enrollment`. Every
 * method resolves the ambient tenant via `currentTenantContext()`; the
 * services underneath all take `tenantId` explicitly so they also work from
 * `seed.ts` and from tests with no ambient context at all.
 */
@Injectable()
export class AttendanceService implements AttendanceContract {
  constructor(
    @Inject(AttendanceCodeService) private readonly codes: AttendanceCodeService,
    @Inject(AttendanceRecordService) private readonly records: AttendanceRecordService,
    @Inject(AttendanceCorrectionService) private readonly corrections: AttendanceCorrectionService,
  ) {}

  createCode(input: CreateCodeInput): Promise<Result<AttendanceCode, DomainError>> {
    return this.codes.createCode(currentTenantContext().tenantId, input);
  }

  updateCode(id: string, input: UpdateCodeInput): Promise<Result<AttendanceCode, DomainError>> {
    return this.codes.updateCode(currentTenantContext().tenantId, id, input);
  }

  listCodes(): Promise<AttendanceCode[]> {
    return this.codes.listCodes(currentTenantContext().tenantId);
  }

  markSession(input: MarkSessionInput): Promise<Result<MarkSessionResult, DomainError>> {
    return this.records.markSession(currentTenantContext().tenantId, input);
  }

  getSessionRoster(input: GetSessionRosterInput): Promise<Result<SessionRoster, NotFoundError>> {
    return this.records.getSessionRoster(currentTenantContext().tenantId, input);
  }

  getMeetingContext(sectionMeetingId: string, date: DateOnly): Promise<SectionMeetingContext | null> {
    return this.records.getMeetingContext(currentTenantContext().tenantId, sectionMeetingId, date);
  }

  requestCorrection(input: RequestCorrectionInput): Promise<Result<AttendanceCorrection, DomainError>> {
    return this.corrections.requestCorrection(currentTenantContext().tenantId, input);
  }

  decideCorrection(input: DecideCorrectionInput): Promise<Result<AttendanceCorrection, DomainError>> {
    return this.corrections.decideCorrection(currentTenantContext().tenantId, input);
  }

  listCorrections(input?: ListCorrectionsInput): Promise<AttendanceCorrection[]> {
    return this.corrections.listCorrections(currentTenantContext().tenantId, input ?? {});
  }

  getAttendanceSummary(input: GetAttendanceSummaryInput): Promise<AttendanceSummary> {
    return this.records.getAttendanceSummary(currentTenantContext().tenantId, input);
  }

  listUnmarkedSessions(input: ListUnmarkedSessionsInput): Promise<UnmarkedSession[]> {
    return this.records.listUnmarkedSessions(currentTenantContext().tenantId, input);
  }
}
