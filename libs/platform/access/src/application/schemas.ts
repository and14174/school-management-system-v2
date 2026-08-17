import { z } from 'zod';

/**
 * Zod schemas for this module's REST bodies - parsed by the `nestjs-zod`
 * DTOs in `src/api/dto` (`createZodDto`), same convention as `@sms/tenancy`'s
 * `application/schemas.ts`.
 */

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;

export const assignRoleSchema = z.object({
  userId: z.string().uuid(),
  campusId: z.string().uuid().optional(),
  validFrom: z.string().regex(dateOnlyPattern, 'validFrom must be YYYY-MM-DD').optional(),
  validTo: z.string().regex(dateOnlyPattern, 'validTo must be YYYY-MM-DD').nullish(),
});
export type AssignRoleBody = z.infer<typeof assignRoleSchema>;

export const revokeRoleSchema = z.object({
  userId: z.string().uuid(),
  campusId: z.string().uuid().optional(),
  asOf: z.string().regex(dateOnlyPattern, 'asOf must be YYYY-MM-DD').optional(),
});
export type RevokeRoleBody = z.infer<typeof revokeRoleSchema>;

export const startImpersonationSchema = z.object({
  targetUserId: z.string().uuid(),
  reason: z.string().min(1).max(500),
});
export type StartImpersonationBody = z.infer<typeof startImpersonationSchema>;
