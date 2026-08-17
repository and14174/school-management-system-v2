import { z } from 'zod';

/**
 * Zod schemas for this module's REST bodies - parsed by the `nestjs-zod`
 * DTOs in `src/api/dto` (`createZodDto`), same convention as
 * `@sms/import-export`'s `application/schemas.ts`.
 */

export const publishTemplateVersionSchema = z.object({
  templateKey: z.string().min(1),
  html: z.string(),
  css: z.string(),
});
export type PublishTemplateVersionBody = z.infer<typeof publishTemplateVersionSchema>;

export const generateDocumentSchema = z.object({
  templateKey: z.string().min(1),
  subjectType: z.string().min(1),
  subjectId: z.string().uuid(),
  title: z.string().min(1).max(500),
  data: z.unknown(),
});
export type GenerateDocumentBody = z.infer<typeof generateDocumentSchema>;

export const reissueDocumentSchema = z.object({
  data: z.unknown(),
  title: z.string().min(1).max(500).optional(),
});
export type ReissueDocumentBody = z.infer<typeof reissueDocumentSchema>;

/**
 * `subjectType`/`subjectId` are REQUIRED on `GET /documents`. Typing them as
 * plain `string` without validating them let a caller who omitted either
 * reach the service with `undefined` and get a 500 for what is plainly a bad
 * request - same fix as `@sms/attendance`'s `unmarkedSessionsQuerySchema`;
 * see `docs/decisions.md`.
 */
export const listDocumentsQuerySchema = z.object({
  subjectType: z.string().min(1),
  subjectId: z.string().uuid(),
});
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;
