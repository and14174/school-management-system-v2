import { createZodDto } from 'nestjs-zod';
import { startImpersonationSchema } from '../../application/schemas.js';

export class StartImpersonationDto extends createZodDto(startImpersonationSchema) {}
