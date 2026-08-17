import { createZodDto } from 'nestjs-zod';
import {
  assignTeacherSchema,
  createSectionSchema,
  endEnrollmentSchema,
  endTeacherAssignmentSchema,
  enrolStudentSchema,
  transferStudentSchema,
  updateSectionSchema,
} from '../../application/schemas.js';

export class CreateSectionDto extends createZodDto(createSectionSchema) {}
export class UpdateSectionDto extends createZodDto(updateSectionSchema) {}
export class AssignTeacherDto extends createZodDto(assignTeacherSchema) {}
export class EndTeacherAssignmentDto extends createZodDto(endTeacherAssignmentSchema) {}
export class EnrolStudentDto extends createZodDto(enrolStudentSchema) {}
export class EndEnrollmentDto extends createZodDto(endEnrollmentSchema) {}
export class TransferStudentDto extends createZodDto(transferStudentSchema) {}
