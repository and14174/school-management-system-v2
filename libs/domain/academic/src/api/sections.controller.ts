import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { ForbiddenError, isSystemContext, unwrap, type CampusId, type DateOnly, type PersonId } from '@sms/kernel';
import { requireContext } from '@sms/db';
import { ACCESS_CONTRACT, RequirePermission, type AccessContract } from '@sms/access';
import { ACADEMIC_CONTRACT, type AcademicContract } from '../contract.js';
import type { SectionEnrollmentStatus, SectionTeacherRole } from '../domain/types.js';
import { CreateSectionDto, UpdateSectionDto, AssignTeacherDto, EndTeacherAssignmentDto, EnrolStudentDto, EndEnrollmentDto, TransferStudentDto } from './dto/section.dto.js';

/**
 * `GET /academic/sections/:id/students` is the headline endpoint this
 * module exists to secure correctly (see the module brief's "central
 * deliverable"). `@RequirePermission('people.student:read')` only answers
 * the CASL question - "may this user read students AT ALL" - as a cheap
 * type-level check with no `sectionId` to test conditions against (see
 * `@sms/access`'s `ability.types.ts`: a bare-string subject check ignores
 * every rule's conditions). That is not enough on its own: a Teacher's grant
 * is scoped `section`, and the guard has no way to know WHICH section this
 * request is about. `assertCanListStudents` below is the second, REQUIRED
 * half - the data-filtering layer `@sms/access`'s `resolveScopeConstraints`
 * exists for - that actually checks the requested `sectionId` against the
 * caller's resolved constraint before the roster is returned.
 */
@ApiTags('academic')
@Controller('academic')
export class SectionsController {
  constructor(
    @Inject(ACADEMIC_CONTRACT) private readonly academic: AcademicContract,
    @Inject(ACCESS_CONTRACT) private readonly access: AccessContract,
  ) {}

  @RequirePermission('academic.section:read')
  @Get('sections')
  async listSections(
    @Query('termId') termId?: string,
    @Query('courseId') courseId?: string,
    @Query('campusId') campusId?: string,
  ) {
    const sections = await this.academic.listSections({
      ...(termId ? { termId } : {}),
      ...(courseId ? { courseId } : {}),
      ...(campusId ? { campusId: campusId as CampusId } : {}),
    });

    // The guard above only answers "may this user read sections AT ALL". A
    // Teacher's grant is scoped `section`, and a LIST request names no section
    // for the guard to test - so without this the whole school's timetable came
    // back to a teacher who teaches three classes. A list endpoint cannot be
    // secured by a per-row check it never performs.
    return this.applySectionConstraint(sections);
  }

  /** Sections the CALLER (via their linked `people.person`) currently teaches - what a teacher's own "My sections" view calls. */
  @RequirePermission('academic.section:read')
  @Get('sections/mine')
  async mySections() {
    const ctx = requireContext();
    if (isSystemContext(ctx) || !ctx.personId) {
      return [];
    }
    return this.academic.listSectionsForTeacher(ctx.personId);
  }

  @RequirePermission('academic.section:read')
  @Get('sections/:id')
  async getSection(@Param('id', ParseUUIDPipe) id: string) {
    const section = unwrap(await this.academic.getSection(id));
    // Same reasoning as the list: the guard cannot see which section was asked
    // for, so a section-scoped teacher could otherwise read any section by id.
    const [permitted] = await this.applySectionConstraint([section]);
    if (!permitted) {
      throw new ForbiddenError(`You do not have access to section ${id}.`);
    }
    return permitted;
  }

  @RequirePermission('academic.section:write')
  @Post('sections')
  async createSection(@Body(new ZodValidationPipe(CreateSectionDto)) body: CreateSectionDto) {
    return unwrap(await this.academic.createSection({ ...body, campusId: body.campusId as CampusId }));
  }

  @RequirePermission('academic.section:write')
  @Patch('sections/:id')
  async updateSection(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(UpdateSectionDto)) body: UpdateSectionDto) {
    return unwrap(
      await this.academic.updateSection(id, {
        ...(body.courseId !== undefined ? { courseId: body.courseId } : {}),
        ...(body.campusId !== undefined ? { campusId: body.campusId as CampusId } : {}),
        ...(body.roomId !== undefined ? { roomId: body.roomId } : {}),
        ...(body.code !== undefined ? { code: body.code } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.capacity !== undefined ? { capacity: body.capacity } : {}),
      }),
    );
  }

  @RequirePermission('academic.section:read')
  @Get('sections/:id/teachers')
  listTeachers(@Param('id', ParseUUIDPipe) id: string) {
    return this.academic.listTeachersForSection(id);
  }

  @RequirePermission('academic.section_roster:manage')
  @Post('sections/:id/teachers')
  async assignTeacher(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(AssignTeacherDto)) body: AssignTeacherDto) {
    return unwrap(
      await this.academic.assignTeacher({
        sectionId: id,
        personId: body.personId as PersonId,
        ...(body.role !== undefined ? { role: body.role as SectionTeacherRole } : {}),
        ...(body.validFrom !== undefined ? { validFrom: body.validFrom as DateOnly } : {}),
        ...(body.validTo !== undefined ? { validTo: body.validTo as DateOnly | null } : {}),
      }),
    );
  }

  @RequirePermission('academic.section_roster:manage')
  @Delete('sections/:id/teachers')
  async endTeacherAssignment(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(EndTeacherAssignmentDto)) body: EndTeacherAssignmentDto) {
    unwrap(
      await this.academic.endTeacherAssignment({
        sectionId: id,
        personId: body.personId as PersonId,
        ...(body.role !== undefined ? { role: body.role as SectionTeacherRole } : {}),
        ...(body.asOf !== undefined ? { asOf: body.asOf as DateOnly } : {}),
      }),
    );
    return { ended: true };
  }

  /** See this file's own top-of-file comment: the two-layer check this endpoint exists to demonstrate. */
  @RequirePermission('people.student:read')
  @Get('sections/:id/students')
  async listStudents(@Param('id', ParseUUIDPipe) id: string) {
    await this.assertCanListStudents(id);
    return this.academic.listStudentsInSection(id);
  }

  @RequirePermission('academic.section_roster:manage')
  @Post('sections/:id/students')
  async enrolStudent(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(EnrolStudentDto)) body: EnrolStudentDto) {
    return unwrap(
      await this.academic.enrolStudent({
        sectionId: id,
        personId: body.personId as PersonId,
        ...(body.validFrom !== undefined ? { validFrom: body.validFrom as DateOnly } : {}),
      }),
    );
  }

  @RequirePermission('academic.section_roster:manage')
  @Delete('sections/:id/students')
  async endEnrollment(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(EndEnrollmentDto)) body: EndEnrollmentDto) {
    unwrap(
      await this.academic.endEnrollment({
        sectionId: id,
        personId: body.personId as PersonId,
        ...(body.asOf !== undefined ? { asOf: body.asOf as DateOnly } : {}),
        ...(body.status !== undefined ? { status: body.status as SectionEnrollmentStatus } : {}),
      }),
    );
    return { ended: true };
  }

  @RequirePermission('academic.section_roster:manage')
  @Post('sections/:id/students/transfer')
  async transferStudent(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(TransferStudentDto)) body: TransferStudentDto) {
    return unwrap(
      await this.academic.transferStudent({
        personId: body.personId as PersonId,
        fromSectionId: id,
        toSectionId: body.toSectionId,
        ...(body.effectiveFrom !== undefined ? { effectiveFrom: body.effectiveFrom as DateOnly } : {}),
      }),
    );
  }

  /**
   * The data-filtering half of securing `GET /academic/sections/:id/students`
   * - see this file's top-of-file comment. Resolves the caller's
   * `people.student:read` constraint and checks the REQUESTED section
   * against it, rather than trusting the coarse `@RequirePermission` type-
   * level check alone.
   */
  /**
   * Narrows a set of sections to those the caller's `academic.section:read`
   * grant actually covers. This is the data-filtering half that
   * `@RequirePermission` cannot do: the guard answers a type-level question
   * ("may they read sections?") with no particular section in hand.
   *
   * Filtering happens in memory after the query. That is correct but not
   * scalable - push the constraint down into the SQL `WHERE` once section
   * counts justify it. It must never be dropped in the meantime.
   */
  private async applySectionConstraint<T extends { id: string; campusId: CampusId }>(
    sections: T[],
  ): Promise<T[]> {
    const ctx = requireContext();
    if (isSystemContext(ctx) || !ctx.userId) {
      throw new ForbiddenError('No authenticated tenant context is resolved for this request.');
    }

    const constraints = await this.access.resolveScopeConstraints(ctx.userId, ctx.tenantId);
    const constraint = constraints['academic.section:read'];

    if (!constraint || constraint.kind === 'none') {
      return [];
    }
    if (constraint.kind === 'tenant') {
      return sections;
    }
    if (constraint.kind === 'section') {
      return sections.filter((section) => constraint.sectionIds.includes(section.id));
    }
    if (constraint.kind === 'campus') {
      return sections.filter((section) => constraint.campusIds.includes(section.campusId));
    }
    // 'own'/'dependants' identify a person or set of people, which says
    // nothing about which sections they may see. Fail closed rather than
    // guessing.
    return [];
  }

  private async assertCanListStudents(sectionId: string): Promise<void> {
    const ctx = requireContext();
    if (isSystemContext(ctx) || !ctx.userId) {
      throw new ForbiddenError('No authenticated tenant context is resolved for this request.');
    }

    const constraints = await this.access.resolveScopeConstraints(ctx.userId, ctx.tenantId);
    const constraint = constraints['people.student:read'];

    if (!constraint || constraint.kind === 'none') {
      throw new ForbiddenError('Missing permission "people.student:read".');
    }
    if (constraint.kind === 'tenant') {
      return;
    }
    if (constraint.kind === 'section') {
      if (!constraint.sectionIds.includes(sectionId)) {
        throw new ForbiddenError(`You do not teach section ${sectionId}.`);
      }
      return;
    }
    if (constraint.kind === 'campus') {
      const section = unwrap(await this.academic.getSection(sectionId));
      if (!constraint.campusIds.includes(section.campusId)) {
        throw new ForbiddenError(`Section ${sectionId} is outside your campus.`);
      }
      return;
    }
    // 'own'/'dependants' (a person, or a set of them) do not resolve to
    // "every student in a section".
    throw new ForbiddenError('Missing permission "people.student:read".');
  }
}
