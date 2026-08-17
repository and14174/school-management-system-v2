import { z } from 'zod';
import { GPA_SCOPES } from '../domain/types.js';

/**
 * Zod schemas for this module's REST bodies - parsed by the `nestjs-zod`
 * DTOs in `src/api/dto` (`createZodDto`), same convention as
 * `@sms/gradebook`'s `application/schemas.ts`.
 */

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
const dateOnlySchema = z.string().regex(dateOnlyPattern, 'must be a YYYY-MM-DD date');

// --- Report cards -------------------------------------------------------

export const previewReportCardSchema = z.object({
  personId: z.string().uuid(),
  gradingPeriodId: z.string().uuid(),
});

export const issueReportCardsSchema = z.object({
  gradingPeriodId: z.string().uuid(),
  sectionId: z.string().uuid().nullish(),
  idempotencyKey: z.string().min(1).max(200),
});

// --- Transcripts / GPA / eligibility -------------------------------------

export const finaliseTranscriptEntriesSchema = z.object({
  personId: z.string().uuid(),
  termId: z.string().uuid(),
});

export const calculateGpaQuerySchema = z.object({
  scope: z.enum(GPA_SCOPES as [string, ...string[]]),
  termId: z.string().uuid().optional(),
  academicYearId: z.string().uuid().optional(),
});

// --- Credit rule sets (rules as data) ------------------------------------

const creditRuleOverrideSchema = z.object({
  requiredCredits: z.number().min(0),
  minGpa: z.number().min(0).max(10).nullish(),
});

const creditRulesSchema = z.object({
  defaultRequiredCredits: z.number().min(0),
  minGpa: z.number().min(0).max(10).nullable(),
  gradeLevelOverrides: z.record(z.string().uuid(), creditRuleOverrideSchema).optional(),
});

export const createCreditRuleSetSchema = z.object({
  name: z.string().min(1).max(200),
  isDefault: z.boolean().optional(),
});

export const publishCreditRuleSetVersionSchema = z.object({
  rules: creditRulesSchema,
  effectiveFrom: dateOnlySchema.optional(),
});
