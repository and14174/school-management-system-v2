import { z } from 'zod';

/** Zod schemas for this module's REST bodies - parsed by the `nestjs-zod` DTOs in `src/api/dto` (`createZodDto`), same convention as `@sms/billing`'s `application/schemas.ts`. */

export const upsertPolicySchema = z.object({
  requestType: z.string().trim().min(1).max(100),
  permissionKey: z
    .string()
    .trim()
    .min(3)
    .max(150)
    .regex(/^[a-z0-9_.]+:[a-z0-9_]+$/, 'permissionKey must look like "resource:action"'),
  approvalsRequired: z.number().int().positive().max(50).optional(),
});

export const decideRequestSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().min(1).max(1000).optional(),
});

export const listRequestsQuerySchema = z.object({
  requestType: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});
