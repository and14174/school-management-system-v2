import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import {
  ForbiddenError,
  isSystemContext,
  unwrap,
  type AcademicYearId,
  type CampusId,
  type DateOnly,
  type PersonId,
} from '@sms/kernel';
import { requireContext } from '@sms/db';
import { ACCESS_CONTRACT, RequirePermission, type AccessContract } from '@sms/access';
import { ENROLLMENT_CONTRACT, type EnrollmentContract } from '../contract.js';
import type { EnrollmentStatus } from '../domain/types.js';
import { EnrolStudentDto, TransferCampusDto, TransitionStatusDto } from './dto/enrollment.dto.js';

/**
 * `@RequirePermission('enrollment.enrollment:read')` only answers the CASL
 * question - "may this user read school enrolments AT ALL" - a type-level
 * check with no particular enrolment to test conditions against (see
 * `@sms/access`'s `ability.types.ts`: a bare-string subject check ignores
 * every rule's conditions). That is not enough on its own: a campus-scoped
 * grant (e.g. a Registrar assigned to one campus) needs to know WHICH
 * enrolment/campus a request is about. `applyEnrollmentConstraint` below is
 * the second, REQUIRED half - the data-filtering layer `@sms/access`'s
 * `resolveScopeConstraints` exists for - applied to BOTH the list endpoint
 * and the single-record read, exactly like `@sms/academic`'s
 * `SectionsController` does for sections (see that file's own comment): a
 * `@RequirePermission` guard alone cannot see which record a single-record
 * GET named, so skipping this on `getEnrollment`/`getStatusHistory` would
 * let a campus-scoped caller read any OTHER campus's enrolment by id.
 */
@ApiTags('enrollment')
@Controller('enrollment')
export class EnrollmentsController {
  constructor(
    @Inject(ENROLLMENT_CONTRACT) private readonly enrollment: EnrollmentContract,
    @Inject(ACCESS_CONTRACT) private readonly access: AccessContract,
  ) {}

  @RequirePermission('enrollment.enrollment:read')
  @Get('enrollments')
  async listEnrollments(
    @Query('academicYearId') academicYearId?: string,
    @Query('campusId') campusId?: string,
    @Query('gradeLevelId') gradeLevelId?: string,
    @Query('status') status?: string,
    @Query('query') query?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const page = await this.enrollment.listEnrollments({
      ...(academicYearId ? { academicYearId: academicYearId as AcademicYearId } : {}),
      ...(campusId ? { campusId: campusId as CampusId } : {}),
      ...(gradeLevelId ? { gradeLevelId } : {}),
      ...(status ? { status: status as EnrollmentStatus } : {}),
      ...(query ? { query } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
      ...(cursor ? { cursor } : {}),
    });

    // See this file's own top-of-file comment: the guard above cannot see
    // which rows a LIST request will return, so without this a campus-
    // scoped registrar's request came back with every campus's enrolments.
    //
    // Filtering happens in memory after the query, keyed off the
    // UNFILTERED page's cursor - correct but not scalable (same
    // acknowledged imperfection as @sms/academic's SectionsController.
    // applySectionConstraint: push the constraint into the SQL WHERE once
    // enrolment counts justify it). It must never be dropped in the
    // meantime.
    const items = await this.applyEnrollmentConstraint(page.items);
    return { items, nextCursor: page.nextCursor };
  }

  @RequirePermission('enrollment.enrollment:read')
  @Get('enrollments/:id')
  async getEnrollment(@Param('id', ParseUUIDPipe) id: string) {
    const record = unwrap(await this.enrollment.getEnrollment(id));
    const [permitted] = await this.applyEnrollmentConstraint([record]);
    if (!permitted) {
      throw new ForbiddenError(`You do not have access to enrollment ${id}.`);
    }
    return permitted;
  }

  @RequirePermission('enrollment.enrollment:read')
  @Get('enrollments/:id/history')
  async getStatusHistory(@Param('id', ParseUUIDPipe) id: string) {
    const record = unwrap(await this.enrollment.getEnrollment(id));
    const [permitted] = await this.applyEnrollmentConstraint([record]);
    if (!permitted) {
      throw new ForbiddenError(`You do not have access to enrollment ${id}.`);
    }
    return this.enrollment.getStatusHistory(id);
  }

  @RequirePermission('enrollment.enrollment:write')
  @Post('enrollments')
  async enrolStudent(@Body(new ZodValidationPipe(EnrolStudentDto)) body: EnrolStudentDto) {
    return unwrap(
      await this.enrollment.enrolStudent({
        personId: body.personId as PersonId,
        academicYearId: body.academicYearId as AcademicYearId,
        campusId: body.campusId as CampusId,
        gradeLevelId: body.gradeLevelId,
        ...(body.enrolledOn !== undefined ? { enrolledOn: body.enrolledOn as DateOnly } : {}),
        ...(body.studentNumber !== undefined ? { studentNumber: body.studentNumber } : {}),
      }),
    );
  }

  @RequirePermission('enrollment.enrollment:write')
  @Post('enrollments/:id/transition')
  async transitionStatus(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(TransitionStatusDto)) body: TransitionStatusDto) {
    return unwrap(
      await this.enrollment.transitionStatus({
        enrollmentId: id,
        toStatus: body.toStatus as EnrollmentStatus,
        effectiveOn: body.effectiveOn as DateOnly,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      }),
    );
  }

  @RequirePermission('enrollment.enrollment:write')
  @Post('enrollments/:id/transfer-campus')
  async transferCampus(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(TransferCampusDto)) body: TransferCampusDto) {
    return unwrap(
      await this.enrollment.transferCampus({
        enrollmentId: id,
        toCampusId: body.toCampusId as CampusId,
        effectiveOn: body.effectiveOn as DateOnly,
      }),
    );
  }

  /**
   * Narrows a set of enrolments to those the caller's
   * `enrollment.enrollment:read` grant actually covers - the data-filtering
   * half that `@RequirePermission` cannot do (see this file's top-of-file
   * comment). `section`/`own`/`dependants` say nothing about which SCHOOL
   * enrolments to show (this is not `academic.section_enrollment`), so all
   * three fail closed to nothing rather than guessing.
   */
  private async applyEnrollmentConstraint<T extends { campusId: CampusId }>(items: readonly T[]): Promise<T[]> {
    const ctx = requireContext();
    if (isSystemContext(ctx) || !ctx.userId) {
      throw new ForbiddenError('No authenticated tenant context is resolved for this request.');
    }

    const constraints = await this.access.resolveScopeConstraints(ctx.userId, ctx.tenantId);
    const constraint = constraints['enrollment.enrollment:read'];

    if (!constraint || constraint.kind === 'none') {
      return [];
    }
    if (constraint.kind === 'tenant') {
      return [...items];
    }
    if (constraint.kind === 'campus') {
      return items.filter((item) => constraint.campusIds.includes(item.campusId));
    }
    return [];
  }
}
