import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

/**
 * Shape of `GET /tenancy/scope` - documented (not runtime-validated; this is
 * a response, not a request body) so the OpenAPI docs and the web scope
 * switcher this feeds have one agreed contract.
 */
export const scopeResponseSchema = z.object({
  tenant: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
  }),
  campuses: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      name: z.string(),
      isDefault: z.boolean(),
      status: z.string(),
    }),
  ),
  academicYears: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      startsOn: z.string(),
      endsOn: z.string(),
      status: z.string(),
      isCurrent: z.boolean(),
    }),
  ),
  current: z.object({
    campusId: z.string().nullable(),
    academicYearId: z.string().nullable(),
  }),
});

export class ScopeResponseDto extends createZodDto(scopeResponseSchema) {}
