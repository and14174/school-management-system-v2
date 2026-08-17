import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { ForbiddenError, isSystemContext, unwrap, type AcademicYearId, type CampusId, type DateOnly, type PersonId } from '@sms/kernel';
import { requireContext } from '@sms/db';
import { ACCESS_CONTRACT, RequirePermission, type AccessContract, type ScopeConstraint } from '@sms/access';
import { ACADEMIC_CONTRACT, type AcademicContract } from '../contract.js';
import type { TimetableEntry } from '../domain/types.js';
import {
  AssignSubstituteDto,
  CreateBellScheduleDto,
  CreatePeriodDto,
  SetSectionMeetingsDto,
  TimetableRangeDto,
  UpdateBellScheduleDto,
  UpdatePeriodDto,
} from './dto/scheduling.dto.js';

/**
 * Scheduling/timetabling. Every endpoint here is gated by a SINGLE catalogue
 * permission pair, `academic.timetable:read`/`:write` (see `@sms/access`'s
 * `domain/permissions.ts`) - Teacher holds `:read` scoped `section`,
 * School Administrator/Registrar hold both scoped `tenant` (see this
 * module's `seed.ts`... `@sms/access`'s `seed.ts`, which owns role grants).
 *
 * `@RequirePermission` only answers "may this user read timetables AT ALL" -
 * same limitation `SectionsController`'s own top-of-file comment documents.
 * A `section`-scoped Teacher's grant has to be narrowed by the ACTUAL
 * requested resource, on every read here, list and single-record alike -
 * `applyTimetableScope` below is that data-filtering layer, reused by the
 * teacher/student/room timetable endpoints and `sections/:id/meetings`.
 * Bell schedules and periods are treated as reference data (like
 * `CatalogController`'s grade levels/rooms) - a period's name and time-of-day
 * carries no per-teacher information to narrow, so those list/read endpoints
 * are gated by the permission alone, same as `CatalogController`'s own
 * stated rationale.
 */
@ApiTags('academic')
@Controller('academic')
export class SchedulingController {
  constructor(
    @Inject(ACADEMIC_CONTRACT) private readonly academic: AcademicContract,
    @Inject(ACCESS_CONTRACT) private readonly access: AccessContract,
  ) {}

  // --- Bell schedules / periods: reference data, gated by permission alone ---

  @RequirePermission('academic.timetable:read')
  @Get('bell-schedules')
  listBellSchedules(@Query('campusId') campusId?: string, @Query('academicYearId') academicYearId?: string) {
    return this.academic.listBellSchedules({
      ...(campusId ? { campusId: campusId as CampusId } : {}),
      ...(academicYearId ? { academicYearId: academicYearId as AcademicYearId } : {}),
    });
  }

  @RequirePermission('academic.timetable:write')
  @Post('bell-schedules')
  async createBellSchedule(@Body(new ZodValidationPipe(CreateBellScheduleDto)) body: CreateBellScheduleDto) {
    return unwrap(
      await this.academic.createBellSchedule({
        campusId: body.campusId as CampusId,
        academicYearId: body.academicYearId as AcademicYearId,
        name: body.name,
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
      }),
    );
  }

  @RequirePermission('academic.timetable:write')
  @Patch('bell-schedules/:id')
  async updateBellSchedule(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(UpdateBellScheduleDto)) body: UpdateBellScheduleDto) {
    return unwrap(await this.academic.updateBellSchedule(id, body));
  }

  @RequirePermission('academic.timetable:read')
  @Get('bell-schedules/:id/periods')
  listPeriods(@Param('id', ParseUUIDPipe) id: string) {
    return this.academic.listPeriods(id);
  }

  @RequirePermission('academic.timetable:write')
  @Post('bell-schedules/:id/periods')
  async createPeriod(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(CreatePeriodDto)) body: CreatePeriodDto) {
    return unwrap(
      await this.academic.createPeriod({
        bellScheduleId: id,
        name: body.name,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        ...(body.sequence !== undefined ? { sequence: body.sequence } : {}),
        ...(body.isInstructional !== undefined ? { isInstructional: body.isInstructional } : {}),
      }),
    );
  }

  @RequirePermission('academic.timetable:write')
  @Patch('periods/:id')
  async updatePeriod(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(UpdatePeriodDto)) body: UpdatePeriodDto) {
    return unwrap(await this.academic.updatePeriod(id, body));
  }

  // --- Section meetings ---

  @RequirePermission('academic.timetable:write')
  @Post('sections/:id/meetings')
  async setSectionMeetings(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(SetSectionMeetingsDto)) body: SetSectionMeetingsDto) {
    return unwrap(
      await this.academic.setSectionMeetings(
        id,
        body.meetings.map((m) => ({
          periodId: m.periodId,
          dayOfWeek: m.dayOfWeek as 1 | 2 | 3 | 4 | 5 | 6 | 7,
          ...(m.roomId !== undefined ? { roomId: m.roomId } : {}),
          ...(m.validFrom !== undefined ? { validFrom: m.validFrom as DateOnly } : {}),
          ...(m.validTo !== undefined ? { validTo: m.validTo as DateOnly | null } : {}),
        })),
      ),
    );
  }

  /** Same two-layer reasoning as `SectionsController.getSection`: the requested `sectionId` has to be checked against the caller's resolved constraint, not just the coarse permission. */
  @RequirePermission('academic.timetable:read')
  @Get('sections/:id/meetings')
  async listMeetingsForSection(@Param('id', ParseUUIDPipe) id: string, @Query('asOf') asOf?: string) {
    const constraint = await this.resolveTimetableConstraint();
    if (constraint.kind === 'none') {
      return [];
    }
    if (constraint.kind === 'section' && !constraint.sectionIds.includes(id)) {
      throw new ForbiddenError(`You do not have access to section ${id}'s meetings.`);
    }
    if (constraint.kind !== 'tenant' && constraint.kind !== 'section') {
      return [];
    }
    return this.academic.listMeetingsForSection(id, asOf as DateOnly | undefined);
  }

  @RequirePermission('academic.timetable:write')
  @Post('section-meetings/:id/substitutions')
  async assignSubstitute(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(AssignSubstituteDto)) body: AssignSubstituteDto) {
    return unwrap(
      await this.academic.assignSubstitute({
        sectionMeetingId: id,
        date: body.date as DateOnly,
        substitutePersonId: body.substitutePersonId as PersonId,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      }),
    );
  }

  // --- Timetable views ---

  /** The caller's OWN timetable (as a teacher) - what a teacher's "My timetable" view calls, with no `personId` to leak in the URL. */
  @RequirePermission('academic.timetable:read')
  @Get('timetables/teacher/mine')
  async myTeacherTimetable(@Query(new ZodValidationPipe(TimetableRangeDto)) range: TimetableRangeDto) {
    const ctx = requireContext();
    if (isSystemContext(ctx) || !ctx.personId) {
      return [];
    }
    const entries = await this.academic.getTimetableForTeacher(ctx.personId, { from: range.from as DateOnly, to: range.to as DateOnly });
    return this.applyTimetableScope(entries);
  }

  @RequirePermission('academic.timetable:read')
  @Get('timetables/teacher/:personId')
  async teacherTimetable(
    @Param('personId', ParseUUIDPipe) personId: string,
    @Query(new ZodValidationPipe(TimetableRangeDto)) range: TimetableRangeDto,
  ) {
    const entries = await this.academic.getTimetableForTeacher(personId as PersonId, { from: range.from as DateOnly, to: range.to as DateOnly });
    return this.applyTimetableScope(entries);
  }

  @RequirePermission('academic.timetable:read')
  @Get('timetables/student/:personId')
  async studentTimetable(
    @Param('personId', ParseUUIDPipe) personId: string,
    @Query(new ZodValidationPipe(TimetableRangeDto)) range: TimetableRangeDto,
  ) {
    const entries = await this.academic.getTimetableForStudent(personId as PersonId, { from: range.from as DateOnly, to: range.to as DateOnly });
    return this.applyTimetableScope(entries, personId as PersonId);
  }

  @RequirePermission('academic.timetable:read')
  @Get('timetables/room/:roomId')
  async roomTimetable(
    @Param('roomId', ParseUUIDPipe) roomId: string,
    @Query(new ZodValidationPipe(TimetableRangeDto)) range: TimetableRangeDto,
  ) {
    const entries = await this.academic.getRoomTimetable(roomId, { from: range.from as DateOnly, to: range.to as DateOnly });
    return this.applyTimetableScope(entries);
  }

  /** Tenant-wide admin reports - not filterable per section, so only a `tenant`-scoped caller (School Administrator/Registrar) may call these; a `section`-scoped Teacher gets nothing, not a partial/misleading report. */
  @RequirePermission('academic.timetable:read')
  @Get('teacher-workload')
  async teacherWorkload(@Query('academicYearId', ParseUUIDPipe) academicYearId: string) {
    const constraint = await this.resolveTimetableConstraint();
    if (constraint.kind !== 'tenant') {
      return [];
    }
    return this.academic.getTeacherWorkload(academicYearId as AcademicYearId);
  }

  @RequirePermission('academic.timetable:read')
  @Get('schedule-conflicts')
  async scheduleConflicts(@Query('academicYearId', ParseUUIDPipe) academicYearId: string) {
    const constraint = await this.resolveTimetableConstraint();
    if (constraint.kind !== 'tenant') {
      return [];
    }
    return this.academic.detectConflicts(academicYearId as AcademicYearId);
  }

  // -------------------------------------------------------------------------
  // Scope resolution helpers - the data-filtering half `@RequirePermission`
  // cannot do (see this file's own top-of-file comment and the reference
  // implementation, `SectionsController`).
  // -------------------------------------------------------------------------

  private async resolveTimetableConstraint(): Promise<ScopeConstraint> {
    const ctx = requireContext();
    if (isSystemContext(ctx) || !ctx.userId) {
      throw new ForbiddenError('No authenticated tenant context is resolved for this request.');
    }
    const constraints = await this.access.resolveScopeConstraints(ctx.userId, ctx.tenantId);
    return constraints['academic.timetable:read'] ?? { kind: 'none' };
  }

  /**
   * Narrows timetable entries to those the caller's `academic.timetable:read`
   * grant actually covers - every entry carries `sectionId`, so a
   * `section`-scoped Teacher only ever sees entries for sections they
   * themselves teach, whoever's `personId`/`roomId` was asked for. Requesting
   * another teacher's `personId` therefore returns only the overlap (usually
   * nothing, unless co-teaching a shared section) rather than throwing - the
   * same "filter, don't guess" posture `SectionsController.applySectionConstraint`
   * documents.
   *
   * `subjectPersonId`, when given, is the person whose OWN timetable was
   * requested (`studentTimetable`'s `:personId`) - the only case where
   * `own`/`dependants` mean anything here: entries carry no `personId` of
   * their own to filter by (they are keyed by section), so those two scopes
   * can only be honoured by checking the REQUESTED subject against the
   * constraint, not by filtering the entries themselves. `myTeacherTimetable`/
   * `teacherTimetable`/`roomTimetable` never pass one, so `own`/`dependants`
   * stay fail-closed for those - same as before.
   */
  private async applyTimetableScope(entries: TimetableEntry[], subjectPersonId?: PersonId): Promise<TimetableEntry[]> {
    const constraint = await this.resolveTimetableConstraint();
    if (constraint.kind === 'tenant') {
      return entries;
    }
    if (constraint.kind === 'section') {
      return entries.filter((entry) => constraint.sectionIds.includes(entry.sectionId));
    }
    if (subjectPersonId && constraint.kind === 'own' && constraint.personId === subjectPersonId) {
      return entries;
    }
    if (subjectPersonId && constraint.kind === 'dependants' && constraint.personIds.includes(subjectPersonId)) {
      return entries;
    }
    // 'campus'/'own'/'dependants' (with no matching subject)/'none':
    // timetable entries are keyed by section, which none of these resolve to
    // directly - fail closed rather than guessing.
    return [];
  }
}
