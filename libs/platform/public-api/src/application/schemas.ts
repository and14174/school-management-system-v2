import { z } from 'zod';

/**
 * Zod schemas for this module's REST bodies - parsed by the `nestjs-zod`
 * DTOs in `src/api/dto` (`createZodDto`), same convention as
 * `@sms/documents`' `application/schemas.ts`.
 */

export const mintApiKeySchema = z
  .object({
    name: z.string().min(1).max(200),
    grantedPermissions: z.array(z.string().min(1)).min(1, 'At least one permission must be granted.'),
    expiresAt: z.string().datetime().optional(),
    neverExpires: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const hasExpiry = value.expiresAt !== undefined;
    const neverExpires = value.neverExpires === true;

    // Exactly one of "expiresAt" / "neverExpires: true" - see the 1600
    // migration header. Neither given is "forgot to set an expiry"; both
    // given is a contradiction the caller should resolve, not something we
    // guess a resolution for.
    if (hasExpiry === neverExpires) {
      ctx.addIssue({
        code: 'custom',
        message: 'Provide exactly one of expiresAt or neverExpires: true.',
      });
    }

    if (hasExpiry && new Date(value.expiresAt as string).getTime() <= Date.now()) {
      ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'expiresAt must be in the future.' });
    }
  });
export type MintApiKeyBody = z.infer<typeof mintApiKeySchema>;

export const revokeApiKeySchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});
export type RevokeApiKeyBody = z.infer<typeof revokeApiKeySchema>;
