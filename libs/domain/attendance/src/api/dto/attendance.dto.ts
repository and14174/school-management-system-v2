import { createZodDto } from 'nestjs-zod';
import {
  attendanceSummaryQuerySchema,
  createCodeSchema,
  decideCorrectionSchema,
  markSessionSchema,
  requestCorrectionSchema,
  sessionRosterQuerySchema,
  unmarkedSessionsQuerySchema,
  updateCodeSchema,
} from '../../application/schemas.js';

export class CreateCodeDto extends createZodDto(createCodeSchema) {}
export class UpdateCodeDto extends createZodDto(updateCodeSchema) {}
export class MarkSessionDto extends createZodDto(markSessionSchema) {}
export class RequestCorrectionDto extends createZodDto(requestCorrectionSchema) {}
export class DecideCorrectionDto extends createZodDto(decideCorrectionSchema) {}
export class UnmarkedSessionsQueryDto extends createZodDto(unmarkedSessionsQuerySchema) {}
export class AttendanceSummaryQueryDto extends createZodDto(attendanceSummaryQuerySchema) {}
export class SessionRosterQueryDto extends createZodDto(sessionRosterQuerySchema) {}
