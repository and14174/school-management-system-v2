import { z } from 'zod';
import { CORRECTION_STATUSES, GRADE_SCALE_KINDS, PROFICIENCY_LEVELS, ROUNDING_MODES, SCORE_STATUSES } from '../domain/types.js';

/**
 * Zod schemas for this module's REST bodies - parsed by the `nestjs-zod`
 * DTOs in `src/api/dto` (`createZodDto`), same convention as
 * `@sms/attendance`'s `application/schemas.ts`.
 */

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
const dateOnlySchema = z.string().regex(dateOnlyPattern, 'must be a YYYY-MM-DD date');

// --- Grade scales -----------------------------------------------------------

const gradeBandSchema = z.object({
  label: z.string().min(1).max(20),
  min: z.number().min(0).max(1000),
  gpaPoints: z.number().min(0).max(10).nullish(),
});

export const createGradeScaleSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(GRADE_SCALE_KINDS as [string, ...string[]]),
  isDefault: z.boolean().optional(),
});

export const publishScaleVersionSchema = z.object({
  bands: z.array(gradeBandSchema).min(1),
  effectiveFrom: dateOnlySchema.optional(),
});

// --- Calculation rule sets ---------------------------------------------------

export const createCalculationRuleSetSchema = z.object({
  name: z.string().min(1).max(200),
  isDefault: z.boolean().optional(),
});

const calculationRuleCategorySchema = z.object({
  name: z.string().min(1).max(200),
  weight: z.number().min(0).max(100),
  dropLowest: z.number().int().min(0),
});

const calculationRulesSchema = z.object({
  rounding: z.object({
    decimals: z.number().int().min(0).max(4),
    mode: z.enum(ROUNDING_MODES as [string, ...string[]]),
  }),
  categories: z.array(calculationRuleCategorySchema),
});

export const publishRuleSetVersionSchema = z.object({
  rules: calculationRulesSchema,
  effectiveFrom: dateOnlySchema.optional(),
});

// --- Categories / assignments -------------------------------------------------

export const createCategorySchema = z.object({
  sectionId: z.string().uuid(),
  name: z.string().min(1).max(200),
  weight: z.number().min(0).max(100).optional(),
  dropLowest: z.number().int().min(0).optional(),
  sequence: z.number().int().optional(),
});

export const updateCategorySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  weight: z.number().min(0).max(100).optional(),
  dropLowest: z.number().int().min(0).optional(),
  sequence: z.number().int().optional(),
});

export const createAssignmentSchema = z.object({
  sectionId: z.string().uuid(),
  categoryId: z.string().uuid(),
  gradingPeriodId: z.string().uuid(),
  title: z.string().min(1).max(300),
  description: z.string().max(4000).nullish(),
  pointsPossible: z.number().positive(),
  dueOn: dateOnlySchema.nullish(),
});

export const updateAssignmentSchema = z.object({
  categoryId: z.string().uuid().optional(),
  gradingPeriodId: z.string().uuid().optional(),
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(4000).nullish(),
  pointsPossible: z.number().positive().optional(),
  dueOn: dateOnlySchema.nullish(),
});

// --- Scores --------------------------------------------------------------------

const enterScoreSchema = z.object({
  personId: z.string().uuid(),
  points: z.number().min(0).nullish(),
  status: z.enum(SCORE_STATUSES as [string, ...string[]]),
  comment: z.string().max(2000).nullish(),
});

export const enterScoresSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  scores: z.array(enterScoreSchema).min(1),
});

// --- Corrections -----------------------------------------------------------------

export const requestCorrectionSchema = z.object({
  scoreId: z.string().uuid(),
  toPoints: z.number().min(0).nullish(),
  toStatus: z.enum(SCORE_STATUSES as [string, ...string[]]),
  reason: z.string().max(2000).nullish(),
});

export const decideCorrectionSchema = z.object({
  approve: z.boolean(),
  reason: z.string().max(2000).nullish(),
});

export const listCorrectionsQuerySchema = z.object({
  status: z.enum(CORRECTION_STATUSES as [string, ...string[]]).optional(),
});

// --- Standards-based grading -------------------------------------------------------

export const createLearningOutcomeSchema = z.object({
  code: z.string().min(1).max(100),
  description: z.string().min(1).max(2000),
  subjectId: z.string().uuid().nullish(),
});

export const recordOutcomeResultSchema = z.object({
  sectionId: z.string().uuid(),
  personId: z.string().uuid(),
  outcomeId: z.string().uuid(),
  assignmentId: z.string().uuid().nullish(),
  proficiencyLevel: z.enum(PROFICIENCY_LEVELS as [string, ...string[]]),
  comment: z.string().max(2000).nullish(),
});

// --- Computed views ----------------------------------------------------------

/**
 * Query schemas for the two computed-view endpoints whose `gradingPeriodId`
 * is REQUIRED. Without them a caller who omitted it reached the service with
 * `undefined` and got a 500 for what is plainly a bad request - same fix as
 * `@sms/attendance`'s `UnmarkedSessionsQueryDto`; see `docs/decisions.md`.
 */
export const calculateSectionGradesQuerySchema = z.object({
  gradingPeriodId: z.string().uuid(),
  asOf: dateOnlySchema.optional(),
});

export const getStudentGradesQuerySchema = z.object({
  gradingPeriodId: z.string().uuid(),
});
