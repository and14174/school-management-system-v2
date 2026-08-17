import { z } from 'zod';

/**
 * Zod schemas for this module's REST bodies - parsed by the `nestjs-zod`
 * DTOs in `src/api/dto` (`createZodDto`), same convention as `@sms/people`'s
 * `application/schemas.ts`.
 */

export const createJobSchema = z.object({
  entityType: z.string().min(1),
  filename: z.string().min(1).max(500),
  csv: z.string().min(1),
});
export type CreateJobBody = z.infer<typeof createJobSchema>;

export const setMappingSchema = z.record(z.string(), z.string());
export type SetMappingBody = z.infer<typeof setMappingSchema>;
