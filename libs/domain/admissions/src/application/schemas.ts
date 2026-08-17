import { z } from 'zod';
import { APPLICATION_STAGES, DECISION_OUTCOMES } from '../domain/types.js';

/**
 * Zod schemas for this module's REST bodies - parsed by the `nestjs-zod`
 * DTOs in `src/api/dto` (`createZodDto`), same convention as `@sms/enrollment`'s
 * `application/schemas.ts`.
 */

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
const dateOnlySchema = z.string().regex(dateOnlyPattern, 'must be a YYYY-MM-DD date');

export const submitApplicationSchema = z.object({
  personId: z.string().uuid().optional(),
  applicantGivenName: z.string().min(1).max(200),
  applicantFamilyName: z.string().min(1).max(200),
  applicantDateOfBirth: dateOnlySchema.nullish(),
  applicantGender: z.string().max(50).nullish(),
  guardianName: z.string().max(200).nullish(),
  guardianEmail: z.string().email().nullish(),
  guardianPhone: z.string().max(50).nullish(),
  desiredAcademicYearId: z.string().uuid(),
  desiredCampusId: z.string().uuid(),
  desiredGradeLevelId: z.string().uuid(),
  source: z.string().max(100).nullish(),
});

export const moveStageSchema = z.object({
  toStage: z.enum(APPLICATION_STAGES as [string, ...string[]]),
  note: z.string().max(500).nullish(),
  occurredOn: dateOnlySchema.optional(),
});

export const recordDecisionSchema = z.object({
  outcome: z.enum(DECISION_OUTCOMES as [string, ...string[]]),
  reason: z.string().max(500).nullish(),
  decidedOn: dateOnlySchema.optional(),
});
