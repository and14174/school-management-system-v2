import { createZodDto } from 'nestjs-zod';
import { createAcademicYearSchema, updateAcademicYearSchema } from '../../application/schemas.js';

export class CreateAcademicYearDto extends createZodDto(createAcademicYearSchema) {}
export class UpdateAcademicYearDto extends createZodDto(updateAcademicYearSchema) {}
