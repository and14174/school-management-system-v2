import { createZodDto } from 'nestjs-zod';
import { mergePersonsSchema } from '../../application/schemas.js';

export class MergePersonsDto extends createZodDto(mergePersonsSchema) {}
