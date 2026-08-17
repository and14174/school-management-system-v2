import { createZodDto } from 'nestjs-zod';
import {
  calculateSectionGradesQuerySchema,
  createAssignmentSchema,
  createCalculationRuleSetSchema,
  createCategorySchema,
  createGradeScaleSchema,
  createLearningOutcomeSchema,
  decideCorrectionSchema,
  enterScoresSchema,
  getStudentGradesQuerySchema,
  publishRuleSetVersionSchema,
  publishScaleVersionSchema,
  recordOutcomeResultSchema,
  requestCorrectionSchema,
  updateAssignmentSchema,
  updateCategorySchema,
} from '../../application/schemas.js';

export class CreateGradeScaleDto extends createZodDto(createGradeScaleSchema) {}
export class PublishScaleVersionDto extends createZodDto(publishScaleVersionSchema) {}
export class CreateCalculationRuleSetDto extends createZodDto(createCalculationRuleSetSchema) {}
export class PublishRuleSetVersionDto extends createZodDto(publishRuleSetVersionSchema) {}
export class CreateCategoryDto extends createZodDto(createCategorySchema) {}
export class UpdateCategoryDto extends createZodDto(updateCategorySchema) {}
export class CreateAssignmentDto extends createZodDto(createAssignmentSchema) {}
export class UpdateAssignmentDto extends createZodDto(updateAssignmentSchema) {}
export class EnterScoresDto extends createZodDto(enterScoresSchema) {}
export class RequestCorrectionDto extends createZodDto(requestCorrectionSchema) {}
export class DecideCorrectionDto extends createZodDto(decideCorrectionSchema) {}
export class CreateLearningOutcomeDto extends createZodDto(createLearningOutcomeSchema) {}
export class RecordOutcomeResultDto extends createZodDto(recordOutcomeResultSchema) {}
/** `gradingPeriodId` is REQUIRED - see `application/schemas.js`'s own comment. */
export class CalculateSectionGradesQueryDto extends createZodDto(calculateSectionGradesQuerySchema) {}
export class GetStudentGradesQueryDto extends createZodDto(getStudentGradesQuerySchema) {}
