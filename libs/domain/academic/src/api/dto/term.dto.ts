import { createZodDto } from 'nestjs-zod';
import { createGradingPeriodSchema, createTermSchema, updateTermSchema } from '../../application/schemas.js';

export class CreateTermDto extends createZodDto(createTermSchema) {}
export class UpdateTermDto extends createZodDto(updateTermSchema) {}
export class CreateGradingPeriodDto extends createZodDto(createGradingPeriodSchema) {}
