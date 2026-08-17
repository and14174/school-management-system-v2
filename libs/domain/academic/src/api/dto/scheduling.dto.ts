import { createZodDto } from 'nestjs-zod';
import {
  assignSubstituteSchema,
  createBellScheduleSchema,
  createPeriodSchema,
  setSectionMeetingsSchema,
  updateBellScheduleSchema,
  updatePeriodSchema,
  timetableRangeSchema,
} from '../../application/schemas.js';

export class CreateBellScheduleDto extends createZodDto(createBellScheduleSchema) {}
export class UpdateBellScheduleDto extends createZodDto(updateBellScheduleSchema) {}
export class CreatePeriodDto extends createZodDto(createPeriodSchema) {}
export class UpdatePeriodDto extends createZodDto(updatePeriodSchema) {}
export class SetSectionMeetingsDto extends createZodDto(setSectionMeetingsSchema) {}
export class AssignSubstituteDto extends createZodDto(assignSubstituteSchema) {}
/**
 * `from`/`to` are REQUIRED on every timetable view. Typing them as `string`
 * without validating them let a caller who omitted them reach the service
 * with `undefined` and get a 500 - the request was malformed, but the caller
 * was told our service broke. Same fix as `@sms/attendance`'s
 * `UnmarkedSessionsQueryDto`; see `docs/decisions.md`.
 */
export class TimetableRangeDto extends createZodDto(timetableRangeSchema) {}
