import { createZodDto } from 'nestjs-zod';
import { createJobSchema, setMappingSchema } from '../../application/schemas.js';

/** Validated by an explicit `new ZodValidationPipe(...)` per param - see `ImportExportController`. */
export class CreateJobDto extends createZodDto(createJobSchema) {}
export class SetMappingDto extends createZodDto(setMappingSchema) {}
