import { z } from 'zod';

/** Zod schemas for this module's REST bodies - same convention as `@sms/documents`' `application/schemas.ts`. */

const channelSchema = z.enum(['email', 'sms', 'push']);

export const publishTemplateVersionSchema = z.object({
  templateKey: z.string().min(1),
  channel: channelSchema,
  locale: z.string().min(1).optional(),
  subjectTemplate: z.string().optional(),
  bodyTemplate: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
});
export type PublishTemplateVersionBody = z.infer<typeof publishTemplateVersionSchema>;

export const setPreferenceSchema = z.object({
  channel: channelSchema,
  category: z.string().min(1),
  optedIn: z.boolean(),
});
export type SetPreferenceBody = z.infer<typeof setPreferenceSchema>;

export const notifySchema = z.object({
  templateKey: z.string().min(1),
  category: z.string().min(1),
  subjectType: z.string().min(1),
  subjectId: z.string().uuid(),
  payload: z.record(z.string(), z.unknown()).default({}),
  dedupeKey: z.string().min(1),
});
export type NotifyBody = z.infer<typeof notifySchema>;
