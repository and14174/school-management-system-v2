import { createZodDto } from 'nestjs-zod';
import { enrolStudentSchema, rollOverYearSchema, transferCampusSchema, transitionStatusSchema } from '../../application/schemas.js';

export class EnrolStudentDto extends createZodDto(enrolStudentSchema) {}
export class TransitionStatusDto extends createZodDto(transitionStatusSchema) {}
export class TransferCampusDto extends createZodDto(transferCampusSchema) {}
export class RollOverYearDto extends createZodDto(rollOverYearSchema) {}
