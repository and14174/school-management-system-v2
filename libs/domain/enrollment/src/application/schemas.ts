import { z } from 'zod';
import { ENROLLMENT_STATUSES } from '../domain/types.js';

/**
 * Zod schemas for this module's REST bodies - parsed by the `nestjs-zod`
 * DTOs in `src/api/dto` (`createZodDto`), same convention as `@sms/academic`'s
 * `application/schemas.ts`.
 */

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
const dateOnlySchema = z.string().regex(dateOnlyPattern, 'must be a YYYY-MM-DD date');

export const enrolStudentSchema = z.object({
  personId: z.string().uuid(),
  academicYearId: z.string().uuid(),
  campusId: z.string().uuid(),
  gradeLevelId: z.string().uuid(),
  enrolledOn: dateOnlySchema.optional(),
  studentNumber: z.string().min(1).max(100).nullish(),
});

export const transitionStatusSchema = z.object({
  toStatus: z.enum(ENROLLMENT_STATUSES as [string, ...string[]]),
  effectiveOn: dateOnlySchema,
  reason: z.string().max(500).nullish(),
});

export const transferCampusSchema = z.object({
  toCampusId: z.string().uuid(),
  effectiveOn: dateOnlySchema,
});

export const rollOverYearSchema = z.object({
  fromAcademicYearId: z.string().uuid(),
  toAcademicYearId: z.string().uuid(),
  promotionMap: z.record(z.string().uuid(), z.string().uuid()),
  dryRun: z.boolean().optional(),
});
