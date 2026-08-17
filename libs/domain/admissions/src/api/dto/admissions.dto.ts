import { createZodDto } from 'nestjs-zod';
import { moveStageSchema, recordDecisionSchema, submitApplicationSchema } from '../../application/schemas.js';

export class SubmitApplicationDto extends createZodDto(submitApplicationSchema) {}
export class MoveStageDto extends createZodDto(moveStageSchema) {}
export class RecordDecisionDto extends createZodDto(recordDecisionSchema) {}
