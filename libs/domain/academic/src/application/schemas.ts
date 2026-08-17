import { z } from 'zod';
import { SECTION_ENROLLMENT_STATUSES, SECTION_TEACHER_ROLES } from '../domain/types.js';

/**
 * Zod schemas for this module's REST bodies - parsed by the `nestjs-zod`
 * DTOs in `src/api/dto` (`createZodDto`), same convention as `@sms/people`'s
 * `application/schemas.ts`.
 */

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
const dateOnlySchema = z.string().regex(dateOnlyPattern, 'must be a YYYY-MM-DD date');

export const createGradeLevelSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  sequence: z.number().int().optional(),
});
export const updateGradeLevelSchema = createGradeLevelSchema.partial();

export const createDepartmentSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
});
export const updateDepartmentSchema = createDepartmentSchema.partial();

export const createSubjectSchema = z.object({
  departmentId: z.string().uuid(),
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
});
export const updateSubjectSchema = createSubjectSchema.partial();

export const createCourseSchema = z.object({
  subjectId: z.string().uuid(),
  gradeLevelId: z.string().uuid(),
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  credits: z.number().nullish(),
});
export const updateCourseSchema = createCourseSchema.partial();

export const createRoomSchema = z.object({
  campusId: z.string().uuid(),
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  capacity: z.number().int().nullish(),
});
export const updateRoomSchema = createRoomSchema.partial();

export const createTermSchema = z.object({
  academicYearId: z.string().uuid(),
  name: z.string().min(1).max(200),
  startsOn: dateOnlySchema,
  endsOn: dateOnlySchema,
  sequence: z.number().int().optional(),
});
export const updateTermSchema = createTermSchema.omit({ academicYearId: true }).partial();

export const createGradingPeriodSchema = z.object({
  termId: z.string().uuid(),
  name: z.string().min(1).max(200),
  startsOn: dateOnlySchema,
  endsOn: dateOnlySchema,
  sequence: z.number().int().optional(),
});

export const createSectionSchema = z.object({
  courseId: z.string().uuid(),
  termId: z.string().uuid(),
  campusId: z.string().uuid(),
  roomId: z.string().uuid().nullish(),
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  capacity: z.number().int().nullish(),
});
export const updateSectionSchema = createSectionSchema.omit({ termId: true }).partial();

export const assignTeacherSchema = z.object({
  personId: z.string().uuid(),
  role: z.enum(SECTION_TEACHER_ROLES as [string, ...string[]]).optional(),
  validFrom: dateOnlySchema.optional(),
  validTo: dateOnlySchema.nullish(),
});

export const endTeacherAssignmentSchema = z.object({
  personId: z.string().uuid(),
  role: z.enum(SECTION_TEACHER_ROLES as [string, ...string[]]).optional(),
  asOf: dateOnlySchema.optional(),
});

export const enrolStudentSchema = z.object({
  personId: z.string().uuid(),
  validFrom: dateOnlySchema.optional(),
});

export const endEnrollmentSchema = z.object({
  personId: z.string().uuid(),
  asOf: dateOnlySchema.optional(),
  status: z.enum(SECTION_ENROLLMENT_STATUSES as [string, ...string[]]).optional(),
});

export const transferStudentSchema = z.object({
  personId: z.string().uuid(),
  toSectionId: z.string().uuid(),
  effectiveFrom: dateOnlySchema.optional(),
});

// -----------------------------------------------------------------------------
// Scheduling / timetabling - see the `0610` migration header.
// -----------------------------------------------------------------------------

const timeOfDaySchema = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'must be a HH:MM or HH:MM:SS time');
const dayOfWeekSchema = z.number().int().min(1).max(7);

export const createBellScheduleSchema = z.object({
  campusId: z.string().uuid(),
  academicYearId: z.string().uuid(),
  name: z.string().min(1).max(200),
  isDefault: z.boolean().optional(),
});
export const updateBellScheduleSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  isDefault: z.boolean().optional(),
});

export const createPeriodSchema = z.object({
  bellScheduleId: z.string().uuid(),
  name: z.string().min(1).max(200),
  sequence: z.number().int().optional(),
  startsAt: timeOfDaySchema,
  endsAt: timeOfDaySchema,
  isInstructional: z.boolean().optional(),
});
export const updatePeriodSchema = createPeriodSchema.omit({ bellScheduleId: true }).partial();

const sectionMeetingInputSchema = z.object({
  periodId: z.string().uuid(),
  dayOfWeek: dayOfWeekSchema,
  roomId: z.string().uuid().nullish(),
  validFrom: dateOnlySchema.optional(),
  validTo: dateOnlySchema.nullish(),
});

export const setSectionMeetingsSchema = z.object({
  meetings: z.array(sectionMeetingInputSchema),
});

export const assignSubstituteSchema = z.object({
  date: dateOnlySchema,
  substitutePersonId: z.string().uuid(),
  reason: z.string().max(1000).nullish(),
});

export const timetableRangeSchema = z.object({
  from: dateOnlySchema,
  to: dateOnlySchema,
});
