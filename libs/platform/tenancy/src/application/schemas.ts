import { z } from 'zod';

/**
 * Zod schemas shared by the application-layer services (parsed again there,
 * so `seed.ts` and any other caller that bypasses HTTP still gets
 * validation) and the `nestjs-zod` DTOs in `src/api/dto` (which wrap these
 * same schemas with `createZodDto` so the HTTP layer, the OpenAPI docs and
 * the service layer can never drift apart).
 */

export const createTenantSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'slug must be lowercase, alphanumeric, hyphen-separated'),
  name: z.string().min(1).max(200),
  legalName: z.string().min(1).max(200).nullish(),
  locale: z.string().min(2).max(20).default('en'),
  timezone: z.string().min(1).max(64).default('UTC'),
  currency: z.string().length(3).default('USD'),
  status: z.enum(['active', 'trial', 'suspended']).default('trial'),
  branding: z.record(z.string(), z.unknown()).default({}),
  featureFlags: z.record(z.string(), z.unknown()).default({}),
  terminology: z.record(z.string(), z.unknown()).default({}),
});
export type CreateTenantInput = z.infer<typeof createTenantSchema>;

export const updateTenantSchema = createTenantSchema.partial();
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;

export const createCampusSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'code must be lowercase, alphanumeric, hyphen-separated'),
  name: z.string().min(1).max(200),
  address: z.record(z.string(), z.unknown()).default({}),
  timezone: z.string().min(1).max(64).default('UTC'),
  locale: z.string().min(2).max(20).default('en'),
  isDefault: z.boolean().default(false),
  status: z.enum(['active', 'inactive']).default('active'),
});
export type CreateCampusInput = z.infer<typeof createCampusSchema>;

export const updateCampusSchema = createCampusSchema.partial();
export type UpdateCampusInput = z.infer<typeof updateCampusSchema>;

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;

export const createAcademicYearSchema = z
  .object({
    name: z.string().min(1).max(50),
    startsOn: z.string().regex(dateOnlyPattern, 'startsOn must be YYYY-MM-DD'),
    endsOn: z.string().regex(dateOnlyPattern, 'endsOn must be YYYY-MM-DD'),
    status: z.enum(['planning', 'open', 'locked', 'archived']).default('planning'),
    isCurrent: z.boolean().default(false),
  })
  .refine((value) => value.endsOn > value.startsOn, {
    message: 'endsOn must be after startsOn',
    path: ['endsOn'],
  });
export type CreateAcademicYearInput = z.infer<typeof createAcademicYearSchema>;

export const updateAcademicYearSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  startsOn: z.string().regex(dateOnlyPattern, 'startsOn must be YYYY-MM-DD').optional(),
  endsOn: z.string().regex(dateOnlyPattern, 'endsOn must be YYYY-MM-DD').optional(),
  status: z.enum(['planning', 'open', 'locked', 'archived']).optional(),
  isCurrent: z.boolean().optional(),
});
export type UpdateAcademicYearInput = z.infer<typeof updateAcademicYearSchema>;
