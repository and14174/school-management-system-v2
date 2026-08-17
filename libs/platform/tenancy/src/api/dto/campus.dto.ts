import { createZodDto } from 'nestjs-zod';
import { createCampusSchema, updateCampusSchema } from '../../application/schemas.js';

/** Validated by the globally-registered `ZodValidationPipe` (see `apps/api/src/main.ts`) because the param is typed with a `createZodDto` class. */
export class CreateCampusDto extends createZodDto(createCampusSchema) {}
export class UpdateCampusDto extends createZodDto(updateCampusSchema) {}
