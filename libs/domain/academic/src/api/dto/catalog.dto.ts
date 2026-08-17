import { createZodDto } from 'nestjs-zod';
import {
  createCourseSchema,
  createDepartmentSchema,
  createGradeLevelSchema,
  createRoomSchema,
  createSubjectSchema,
  updateCourseSchema,
  updateDepartmentSchema,
  updateGradeLevelSchema,
  updateRoomSchema,
  updateSubjectSchema,
} from '../../application/schemas.js';

/** Validated by an explicit `new ZodValidationPipe(...)` per param - see the academic controllers. */
export class CreateGradeLevelDto extends createZodDto(createGradeLevelSchema) {}
export class UpdateGradeLevelDto extends createZodDto(updateGradeLevelSchema) {}

export class CreateDepartmentDto extends createZodDto(createDepartmentSchema) {}
export class UpdateDepartmentDto extends createZodDto(updateDepartmentSchema) {}

export class CreateSubjectDto extends createZodDto(createSubjectSchema) {}
export class UpdateSubjectDto extends createZodDto(updateSubjectSchema) {}

export class CreateCourseDto extends createZodDto(createCourseSchema) {}
export class UpdateCourseDto extends createZodDto(updateCourseSchema) {}

export class CreateRoomDto extends createZodDto(createRoomSchema) {}
export class UpdateRoomDto extends createZodDto(updateRoomSchema) {}
