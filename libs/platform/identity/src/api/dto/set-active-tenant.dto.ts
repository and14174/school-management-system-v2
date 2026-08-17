import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const setActiveTenantSchema = z.object({
  tenantId: z.uuid(),
});
export type SetActiveTenantInput = z.infer<typeof setActiveTenantSchema>;

export class SetActiveTenantDto extends createZodDto(setActiveTenantSchema) {}
