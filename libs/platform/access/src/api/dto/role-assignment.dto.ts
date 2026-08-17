import { createZodDto } from 'nestjs-zod';
import { assignRoleSchema, revokeRoleSchema } from '../../application/schemas.js';

/** Validated by the globally-registered `ZodValidationPipe` (see `apps/api/src/main.ts`) because the param is typed with a `createZodDto` class. */
export class AssignRoleDto extends createZodDto(assignRoleSchema) {}
export class RevokeRoleDto extends createZodDto(revokeRoleSchema) {}
