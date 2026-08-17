import { createZodDto } from 'nestjs-zod';
import { decideRequestSchema, listRequestsQuerySchema, upsertPolicySchema } from '../../application/schemas.js';

export class UpsertPolicyDto extends createZodDto(upsertPolicySchema) {}
export class DecideRequestDto extends createZodDto(decideRequestSchema) {}
export class ListRequestsQueryDto extends createZodDto(listRequestsQuerySchema) {}
