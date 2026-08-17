import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { unwrap, type AcademicYearId, type CampusId, type DateOnly, type PersonId } from '@sms/kernel';
import { RequirePermission } from '@sms/access';
import { ADMISSIONS_CONTRACT, type AdmissionsContract } from '../contract.js';
import type { ApplicationStage, DecisionOutcome } from '../domain/types.js';
import { MoveStageDto, RecordDecisionDto, SubmitApplicationDto } from './dto/admissions.dto.js';

/**
 * Unlike `@sms/enrollment`'s `EnrollmentsController`/`@sms/attendance`'s
 * `AttendanceController`, this controller does NOT apply a second,
 * data-filtering scope-narrowing layer on top of `@RequirePermission`. Those
 * controllers need one because a `campus`/`section`-scoped role can hold
 * their permissions (a Registrar assigned to one campus, a teacher for their
 * own sections) - `@RequirePermission` alone cannot see WHICH record a list/
 * single-record request is about, so it must be filtered again per-record
 * (see `decisions.md`'s "A list endpoint cannot be secured by a per-row
 * check it never performs").
 *
 * `admissions.application:read`/`:write`/`:decide` are held ONLY by
 * `registrar` and `school_administrator`, and BOTH grants are tenant-scoped
 * in the seeded catalogue (see `@sms/access`'s `seed.ts`) - there is no
 * campus/section/own/dependants-scoped holder of any of the three today. A
 * tenant-scoped grant already means "every record in this tenant", which
 * `@RequirePermission` plus this module's own RLS tenant-isolation policy
 * (see the `1500` migration) already fully enforces. Omitting per-record
 * narrowing here is therefore deliberate, not an oversight - it would need
 * to be added the moment a narrower scope is ever granted for one of these
 * three permissions.
 */
@ApiTags('admissions')
@Controller('admissions')
export class AdmissionsController {
  constructor(@Inject(ADMISSIONS_CONTRACT) private readonly admissions: AdmissionsContract) {}

  @RequirePermission('admissions.application:read')
  @Get('applications')
  async listApplications(
    @Query('stage') stage?: string,
    @Query('campusId') campusId?: string,
    @Query('academicYearId') academicYearId?: string,
    @Query('query') query?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.admissions.listApplications({
      ...(stage ? { stage: stage as ApplicationStage } : {}),
      ...(campusId ? { campusId: campusId as CampusId } : {}),
      ...(academicYearId ? { academicYearId: academicYearId as AcademicYearId } : {}),
      ...(query ? { query } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
      ...(cursor ? { cursor } : {}),
    });
  }

  @RequirePermission('admissions.application:read')
  @Get('applications/:id')
  async getApplication(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.admissions.getApplication(id));
  }

  @RequirePermission('admissions.application:read')
  @Get('applications/:id/stage-history')
  async getStageHistory(@Param('id', ParseUUIDPipe) id: string) {
    unwrap(await this.admissions.getApplication(id));
    return this.admissions.getStageHistory(id);
  }

  @RequirePermission('admissions.application:read')
  @Get('applications/:id/decisions')
  async getDecisionHistory(@Param('id', ParseUUIDPipe) id: string) {
    unwrap(await this.admissions.getApplication(id));
    return this.admissions.getDecisionHistory(id);
  }

  @RequirePermission('admissions.application:write')
  @Post('applications')
  async submitApplication(@Body(new ZodValidationPipe(SubmitApplicationDto)) body: SubmitApplicationDto) {
    return unwrap(
      await this.admissions.submitApplication({
        ...(body.personId !== undefined ? { personId: body.personId as PersonId } : {}),
        applicantGivenName: body.applicantGivenName,
        applicantFamilyName: body.applicantFamilyName,
        ...(body.applicantDateOfBirth !== undefined ? { applicantDateOfBirth: body.applicantDateOfBirth as DateOnly | null } : {}),
        ...(body.applicantGender !== undefined ? { applicantGender: body.applicantGender } : {}),
        ...(body.guardianName !== undefined ? { guardianName: body.guardianName } : {}),
        ...(body.guardianEmail !== undefined ? { guardianEmail: body.guardianEmail } : {}),
        ...(body.guardianPhone !== undefined ? { guardianPhone: body.guardianPhone } : {}),
        desiredAcademicYearId: body.desiredAcademicYearId as AcademicYearId,
        desiredCampusId: body.desiredCampusId as CampusId,
        desiredGradeLevelId: body.desiredGradeLevelId,
        ...(body.source !== undefined ? { source: body.source } : {}),
      }),
    );
  }

  @RequirePermission('admissions.application:write')
  @Post('applications/:id/stage')
  async moveStage(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(MoveStageDto)) body: MoveStageDto) {
    return unwrap(
      await this.admissions.moveStage({
        applicationId: id,
        toStage: body.toStage as ApplicationStage,
        ...(body.note !== undefined ? { note: body.note } : {}),
        ...(body.occurredOn !== undefined ? { occurredOn: body.occurredOn as DateOnly } : {}),
      }),
    );
  }

  @RequirePermission('admissions.application:decide')
  @Post('applications/:id/decisions')
  async recordDecision(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(RecordDecisionDto)) body: RecordDecisionDto) {
    return unwrap(
      await this.admissions.recordDecision({
        applicationId: id,
        outcome: body.outcome as DecisionOutcome,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        ...(body.decidedOn !== undefined ? { decidedOn: body.decidedOn as DateOnly } : {}),
      }),
    );
  }
}
