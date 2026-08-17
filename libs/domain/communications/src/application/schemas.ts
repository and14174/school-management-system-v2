import { z } from 'zod';
import { THREAD_SUBJECT_TYPES } from '../domain/types.js';

/**
 * Zod schemas for this module's REST bodies - parsed by the `nestjs-zod`
 * DTOs in `src/api/dto` (`createZodDto`), same convention as `@sms/attendance`'s
 * `application/schemas.ts`.
 */

const audienceQuerySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tenant') }),
  z.object({ kind: z.literal('campus'), campusId: z.string().uuid() }),
  z.object({ kind: z.literal('gradeLevel'), gradeLevelId: z.string().uuid() }),
  z.object({ kind: z.literal('personIds'), personIds: z.array(z.string().uuid()).min(1) }),
]);

export const createAnnouncementSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(20_000),
  category: z.string().min(1).max(100),
  audience: audienceQuerySchema,
  campusId: z.string().uuid().nullish(),
});

export const supersedeAnnouncementSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(20_000),
});

export const listAnnouncementsQuerySchema = z.object({
  forPersonId: z.string().uuid().optional(),
});

export const startThreadSchema = z.object({
  subject: z.string().min(1).max(300),
  subjectType: z.enum(THREAD_SUBJECT_TYPES as [string, ...string[]]),
  subjectId: z.string().uuid(),
  participantPersonIds: z.array(z.string().uuid()).min(1),
  firstMessage: z.string().min(1).max(20_000),
});

export const postMessageSchema = z.object({
  body: z.string().min(1).max(20_000),
  idempotencyKey: z.string().min(1).max(200),
});

export const listThreadsQuerySchema = z.object({
  personId: z.string().uuid().optional(),
  subjectType: z.enum(THREAD_SUBJECT_TYPES as [string, ...string[]]).optional(),
  subjectId: z.string().uuid().optional(),
});
