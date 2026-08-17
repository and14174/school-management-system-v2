import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { ForbiddenError, isSystemContext, unwrap, type CampusId, type DateOnly, type PersonId } from '@sms/kernel';
import { requireContext } from '@sms/db';
import { ACCESS_CONTRACT, RequirePermission, type AccessContract, type ScopeConstraint } from '@sms/access';
import { ATTENDANCE_CONTRACT, type AttendanceContract } from '../contract.js';
import type { AttendanceCategory, CorrectionStatus, SectionMeetingContext, UnmarkedSession } from '../domain/types.js';
import {
  AttendanceSummaryQueryDto,
  CreateCodeDto,
  DecideCorrectionDto,
  MarkSessionDto,
  RequestCorrectionDto,
  SessionRosterQueryDto,
  UnmarkedSessionsQueryDto,
  UpdateCodeDto,
} from './dto/attendance.dto.js';

/**
 * `@RequirePermission('attendance.record:read'|'attendance.record:write')`
 * only answers the CASL question - "may this user touch attendance records
 * AT ALL" - a type-level check with no particular section/meeting to test
 * conditions against (see `@sms/access`'s `ability.types.ts`: a bare-string
 * subject check ignores every rule's conditions). A Teacher's grant is
 * scoped `section`; the guard alone cannot know WHICH section a roster/mark
 * request names. `assertSessionAccess` below is the second, REQUIRED half -
 * the data-filtering layer `@sms/access`'s `resolveScopeConstraints` exists
 * for - applied to every read AND write here, exactly like `@sms/academic`'s
 * `SectionsController` (see that file's own comment) and `@sms/enrollment`'s
 * `EnrollmentsController`.
 */
@ApiTags('attendance')
@Controller('attendance')
export class AttendanceController {
  constructor(
    @Inject(ATTENDANCE_CONTRACT) private readonly attendance: AttendanceContract,
    @Inject(ACCESS_CONTRACT) private readonly access: AccessContract,
  ) {}

  // ---------------------------------------------------------------------
  // Codes - tenant-wide configuration, not a per-record scoped resource
  // (see the `0900` migration header), so no scope-constraint narrowing
  // beyond the coarse `@RequirePermission` check applies here - same as
  // e.g. `academic.grade_level`/`department` in `@sms/academic`'s own
  // controllers.
  // ---------------------------------------------------------------------

  @RequirePermission('attendance.record:read')
  @Get('codes')
  listCodes() {
    return this.attendance.listCodes();
  }

  @RequirePermission('attendance.code:manage')
  @Post('codes')
  async createCode(@Body(new ZodValidationPipe(CreateCodeDto)) body: CreateCodeDto) {
    return unwrap(await this.attendance.createCode({ ...body, category: body.category as AttendanceCategory }));
  }

  @RequirePermission('attendance.code:manage')
  @Patch('codes/:id')
  async updateCode(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(UpdateCodeDto)) body: UpdateCodeDto) {
    return unwrap(
      await this.attendance.updateCode(id, {
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.category !== undefined ? { category: body.category as AttendanceCategory } : {}),
        ...(body.countsAsPresent !== undefined ? { countsAsPresent: body.countsAsPresent } : {}),
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
        ...(body.requiresReason !== undefined ? { requiresReason: body.requiresReason } : {}),
        ...(body.sequence !== undefined ? { sequence: body.sequence } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      }),
    );
  }

  // ---------------------------------------------------------------------
  // Session roster & marking - scoped to the meeting's own section.
  // ---------------------------------------------------------------------

  @RequirePermission('attendance.record:read')
  @Get('sessions/:sectionMeetingId/roster')
  async getSessionRoster(
    @Param('sectionMeetingId', ParseUUIDPipe) sectionMeetingId: string,
    @Query(new ZodValidationPipe(SessionRosterQueryDto)) query: SessionRosterQueryDto,
  ) {
    await this.assertSessionAccess(sectionMeetingId, 'attendance.record:read', query.date as DateOnly);
    return unwrap(await this.attendance.getSessionRoster({ sectionMeetingId, date: query.date as DateOnly }));
  }

  @RequirePermission('attendance.record:write')
  @Post('sessions/mark')
  async markSession(@Body(new ZodValidationPipe(MarkSessionDto)) body: MarkSessionDto) {
    await this.assertSessionAccess(body.sectionMeetingId, 'attendance.record:write', body.date as DateOnly);
    return unwrap(
      await this.attendance.markSession({
        sectionMeetingId: body.sectionMeetingId,
        date: body.date as DateOnly,
        idempotencyKey: body.idempotencyKey,
        marks: body.marks.map((mark) => ({
          personId: mark.personId as PersonId,
          codeId: mark.codeId,
          ...(mark.minutesLate !== undefined ? { minutesLate: mark.minutesLate } : {}),
          ...(mark.note !== undefined ? { note: mark.note } : {}),
        })),
      }),
    );
  }

  // ---------------------------------------------------------------------
  // Corrections. `attendance.correction:approve` is never granted to
  // Teacher (a teacher must not approve their own correction) - see
  // @sms/access's seeded roles - so this endpoint pair does not need the
  // same per-section narrowing above: only Registrar/School Administrator
  // (both tenant-scoped) ever hold it.
  // ---------------------------------------------------------------------

  @RequirePermission('attendance.record:write')
  @Post('corrections')
  async requestCorrection(@Body(new ZodValidationPipe(RequestCorrectionDto)) body: RequestCorrectionDto) {
    return unwrap(
      await this.attendance.requestCorrection({
        recordId: body.recordId,
        toCodeId: body.toCodeId,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      }),
    );
  }

  @RequirePermission('attendance.correction:approve')
  @Post('corrections/:id/decide')
  async decideCorrection(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(DecideCorrectionDto)) body: DecideCorrectionDto) {
    return unwrap(
      await this.attendance.decideCorrection({
        correctionId: id,
        approve: body.approve,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      }),
    );
  }

  @RequirePermission('attendance.correction:approve')
  @Get('corrections')
  listCorrections(@Query('status') status?: string) {
    return this.attendance.listCorrections(status ? { status: status as CorrectionStatus } : {});
  }

  // ---------------------------------------------------------------------
  // Summary & the unmarked-sessions administrative view.
  // ---------------------------------------------------------------------

  @RequirePermission('attendance.record:read')
  @Get('summary')
  async getAttendanceSummary(@Query(new ZodValidationPipe(AttendanceSummaryQueryDto)) query: AttendanceSummaryQueryDto) {
    await this.assertSummaryAccess(query.personId as PersonId);
    return this.attendance.getAttendanceSummary({
      personId: query.personId as PersonId,
      from: query.from as DateOnly,
      to: query.to as DateOnly,
    });
  }

  @RequirePermission('attendance.record:read')
  @Get('unmarked-sessions')
  async listUnmarkedSessions(@Query(new ZodValidationPipe(UnmarkedSessionsQueryDto)) query: UnmarkedSessionsQueryDto) {
    const sessions = await this.attendance.listUnmarkedSessions({
      date: query.date as DateOnly,
      ...(query.campusId ? { campusId: query.campusId as CampusId } : {}),
    });
    return this.applyUnmarkedSessionsConstraint(sessions);
  }

  // ---------------------------------------------------------------------
  // Scope-constraint helpers - the data-filtering half `@RequirePermission`
  // cannot do on its own (see this file's top-of-file comment).
  // ---------------------------------------------------------------------

  private async resolveConstraint(permissionKey: string): Promise<ScopeConstraint> {
    const ctx = requireContext();
    if (isSystemContext(ctx) || !ctx.userId) {
      throw new ForbiddenError('No authenticated tenant context is resolved for this request.');
    }
    const constraints = await this.access.resolveScopeConstraints(ctx.userId, ctx.tenantId);
    return constraints[permissionKey] ?? { kind: 'none' };
  }

  /** Authorizes a roster read / mark write against the specific section `sectionMeetingId` belongs to - not just "may this user touch attendance records at all". */
  private async assertSessionAccess(
    sectionMeetingId: string,
    permissionKey: string,
    date: DateOnly,
  ): Promise<SectionMeetingContext> {
    // Resolved AS OF the date: a slot that does not run on that day is not a
    // session, so there is nothing to authorise and nothing to mark.
    const meeting = await this.attendance.getMeetingContext(sectionMeetingId, date);
    if (!meeting) {
      throw new ForbiddenError(`Section meeting ${sectionMeetingId} does not run on ${date}.`);
    }

    const constraint = await this.resolveConstraint(permissionKey);
    if (constraint.kind === 'tenant') {
      return meeting;
    }
    if (constraint.kind === 'section' && constraint.sectionIds.includes(meeting.sectionId)) {
      return meeting;
    }
    if (constraint.kind === 'campus' && constraint.campusIds.includes(meeting.campusId)) {
      return meeting;
    }
    // 'own'/'dependants' and 'none' say nothing about which sections a
    // caller may touch - fail closed rather than guessing.
    throw new ForbiddenError(`You do not have access to section meeting ${sectionMeetingId}.`);
  }

  /**
   * Authorizes reading `personId`'s attendance summary. `tenant`, `own` (the
   * person themselves) and `dependants` (a guardian holding a
   * `dependants`-scoped grant, reading one of THEIR children's summaries)
   * are resolvable; `section`/`campus`/`none` are denied rather than guessed
   * at - unlike a roster, a summary names no section/meeting to test a
   * `section`/`campus` grant's condition against, and widening either to
   * "every student" would be exactly the silent-over-permission failure mode
   * `docs/decisions.md` warns against.
   */
  private async assertSummaryAccess(personId: PersonId): Promise<void> {
    const constraint = await this.resolveConstraint('attendance.record:read');
    if (constraint.kind === 'tenant') {
      return;
    }
    if (constraint.kind === 'own' && constraint.personId === personId) {
      return;
    }
    if (constraint.kind === 'dependants' && constraint.personIds.includes(personId)) {
      return;
    }
    throw new ForbiddenError(`You do not have access to person ${personId}'s attendance summary.`);
  }

  /** Narrows `listUnmarkedSessions`' result to what the caller's `attendance.record:read` grant actually covers. Filtering happens in memory after the query - correct but not scalable, same acknowledged imperfection as `@sms/academic`'s `SectionsController.applySectionConstraint`. */
  private async applyUnmarkedSessionsConstraint(sessions: UnmarkedSession[]): Promise<UnmarkedSession[]> {
    const constraint = await this.resolveConstraint('attendance.record:read');
    if (constraint.kind === 'tenant') {
      return sessions;
    }
    if (constraint.kind === 'section') {
      return sessions.filter((session) => constraint.sectionIds.includes(session.sectionMeetingId) || constraint.sectionIds.includes(session.sectionId));
    }
    if (constraint.kind === 'campus') {
      return sessions.filter((session) => constraint.campusIds.includes(session.campusId));
    }
    return [];
  }
}
