import { createZodDto } from 'nestjs-zod';
import { createPersonSchema, updatePersonSchema } from '../../application/schemas.js';

/** Validated by an explicit `new ZodValidationPipe(...)` per param - see `PeopleController`. */
export class CreatePersonDto extends createZodDto(createPersonSchema) {}
export class UpdatePersonDto extends createZodDto(updatePersonSchema) {}
