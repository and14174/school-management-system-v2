import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { unwrap, type CampusId } from '@sms/kernel';
import { RequirePermission } from '@sms/access';
import { ACADEMIC_CONTRACT, type AcademicContract } from '../contract.js';
import {
  CreateCourseDto,
  CreateDepartmentDto,
  CreateGradeLevelDto,
  CreateRoomDto,
  CreateSubjectDto,
  UpdateCourseDto,
  UpdateDepartmentDto,
  UpdateGradeLevelDto,
  UpdateRoomDto,
  UpdateSubjectDto,
} from './dto/catalog.dto.js';

/**
 * Academic structure's reference data - grade levels, departments, subjects,
 * courses, rooms. Read/write gated by the matching `academic.<resource>:read`/
 * `:write` permission catalogue entries (see `@sms/access`'s
 * `domain/permissions.ts`), all scoped `tenant` for the seeded administrative
 * roles - this is reference data an administrator manages tenant-wide, not
 * something a teacher's `section` scope has any reason to narrow.
 */
@ApiTags('academic')
@Controller('academic')
export class CatalogController {
  constructor(@Inject(ACADEMIC_CONTRACT) private readonly academic: AcademicContract) {}

  @RequirePermission('academic.grade_level:read')
  @Get('grade-levels')
  listGradeLevels() {
    return this.academic.listGradeLevels();
  }

  @RequirePermission('academic.grade_level:write')
  @Post('grade-levels')
  async createGradeLevel(@Body(new ZodValidationPipe(CreateGradeLevelDto)) body: CreateGradeLevelDto) {
    return unwrap(await this.academic.createGradeLevel(body));
  }

  @RequirePermission('academic.grade_level:write')
  @Patch('grade-levels/:id')
  async updateGradeLevel(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(UpdateGradeLevelDto)) body: UpdateGradeLevelDto) {
    return unwrap(await this.academic.updateGradeLevel(id, body));
  }

  @RequirePermission('academic.department:read')
  @Get('departments')
  listDepartments() {
    return this.academic.listDepartments();
  }

  @RequirePermission('academic.department:write')
  @Post('departments')
  async createDepartment(@Body(new ZodValidationPipe(CreateDepartmentDto)) body: CreateDepartmentDto) {
    return unwrap(await this.academic.createDepartment(body));
  }

  @RequirePermission('academic.department:write')
  @Patch('departments/:id')
  async updateDepartment(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(UpdateDepartmentDto)) body: UpdateDepartmentDto) {
    return unwrap(await this.academic.updateDepartment(id, body));
  }

  @RequirePermission('academic.subject:read')
  @Get('subjects')
  listSubjects() {
    return this.academic.listSubjects();
  }

  @RequirePermission('academic.subject:write')
  @Post('subjects')
  async createSubject(@Body(new ZodValidationPipe(CreateSubjectDto)) body: CreateSubjectDto) {
    return unwrap(await this.academic.createSubject(body));
  }

  @RequirePermission('academic.subject:write')
  @Patch('subjects/:id')
  async updateSubject(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(UpdateSubjectDto)) body: UpdateSubjectDto) {
    return unwrap(await this.academic.updateSubject(id, body));
  }

  @RequirePermission('academic.course:read')
  @Get('courses')
  listCourses() {
    return this.academic.listCourses();
  }

  @RequirePermission('academic.course:write')
  @Post('courses')
  async createCourse(@Body(new ZodValidationPipe(CreateCourseDto)) body: CreateCourseDto) {
    return unwrap(await this.academic.createCourse({ ...body, credits: body.credits ?? undefined }));
  }

  @RequirePermission('academic.course:write')
  @Patch('courses/:id')
  async updateCourse(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(UpdateCourseDto)) body: UpdateCourseDto) {
    return unwrap(await this.academic.updateCourse(id, body));
  }

  @RequirePermission('academic.room:read')
  @Get('rooms')
  listRooms() {
    return this.academic.listRooms();
  }

  @RequirePermission('academic.room:write')
  @Post('rooms')
  async createRoom(@Body(new ZodValidationPipe(CreateRoomDto)) body: CreateRoomDto) {
    return unwrap(await this.academic.createRoom({ ...body, campusId: body.campusId as CampusId }));
  }

  @RequirePermission('academic.room:write')
  @Patch('rooms/:id')
  async updateRoom(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(UpdateRoomDto)) body: UpdateRoomDto) {
    return unwrap(
      await this.academic.updateRoom(id, {
        ...(body.campusId !== undefined ? { campusId: body.campusId as CampusId } : {}),
        ...(body.code !== undefined ? { code: body.code } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.capacity !== undefined ? { capacity: body.capacity } : {}),
      }),
    );
  }
}
