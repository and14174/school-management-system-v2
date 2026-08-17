import { z } from 'zod';
import { ATTENDANCE_CATEGORIES, CORRECTION_STATUSES } from '../domain/types.js';

/**
 * Zod schemas for this module's REST bodies - parsed by the `nestjs-zod`
 * DTOs in `src/api/dto` (`createZodDto`), same convention as `@sms/enrollment`'s
 * `application/schemas.ts`.
 */

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
const dateOnlySchema = z.string().regex(dateOnlyPattern, 'must be a YYYY-MM-DD date');

export const createCodeSchema = z.object({
  code: z.string().min(1).max(50),
  label: z.string().min(1).max(200),
  category: z.enum(ATTENDANCE_CATEGORIES as [string, ...string[]]),
  countsAsPresent: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  requiresReason: z.boolean().optional(),
  sequence: z.number().int().optional(),
});

export const updateCodeSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  category: z.enum(ATTENDANCE_CATEGORIES as [string, ...string[]]).optional(),
  countsAsPresent: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  requiresReason: z.boolean().optional(),
  sequence: z.number().int().optional(),
  active: z.boolean().optional(),
});

const markInputSchema = z.object({
  personId: z.string().uuid(),
  codeId: z.string().uuid(),
  minutesLate: z.number().int().min(0).nullish(),
  note: z.string().max(2000).nullish(),
});

export const markSessionSchema = z.object({
  sectionMeetingId: z.string().uuid(),
  date: dateOnlySchema,
  idempotencyKey: z.string().min(1).max(200),
  marks: z.array(markInputSchema).min(1),
});

export const requestCorrectionSchema = z.object({
  recordId: z.string().uuid(),
  toCodeId: z.string().uuid(),
  reason: z.string().max(2000).nullish(),
});

export const decideCorrectionSchema = z.object({
  approve: z.boolean(),
  reason: z.string().max(2000).nullish(),
});

export const listCorrectionsQuerySchema = z.object({
  status: z.enum(CORRECTION_STATUSES as [string, ...string[]]).optional(),
});

/**
 * Query schemas for the two endpoints whose parameters are REQUIRED. Without
 * them a caller who omits `date` reaches `isoDayOfWeek(undefined)` and gets a
 * 500 ("Cannot read properties of undefined") for what is plainly a bad
 * request - the caller cannot tell a mistake of theirs from an outage of ours.
 */
export const unmarkedSessionsQuerySchema = z.object({
  date: dateOnlySchema,
  campusId: z.string().uuid().optional(),
});

export const attendanceSummaryQuerySchema = z.object({
  personId: z.string().uuid(),
  from: dateOnlySchema,
  to: dateOnlySchema,
});

/** `date` is REQUIRED on `GET /attendance/sessions/:sectionMeetingId/roster` - same fix as `unmarkedSessionsQuerySchema` above. */
export const sessionRosterQuerySchema = z.object({
  date: dateOnlySchema,
});
