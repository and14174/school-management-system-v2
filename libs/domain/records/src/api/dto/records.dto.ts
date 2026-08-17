import { createZodDto } from 'nestjs-zod';
import {
  calculateGpaQuerySchema,
  createCreditRuleSetSchema,
  finaliseTranscriptEntriesSchema,
  issueReportCardsSchema,
  previewReportCardSchema,
  publishCreditRuleSetVersionSchema,
} from '../../application/schemas.js';

export class PreviewReportCardDto extends createZodDto(previewReportCardSchema) {}
export class IssueReportCardsDto extends createZodDto(issueReportCardsSchema) {}
export class FinaliseTranscriptEntriesDto extends createZodDto(finaliseTranscriptEntriesSchema) {}
/**
 * `scope` is REQUIRED on `GET /records/transcripts/:personId/gpa`. Typing it
 * as `string` without validating it let a caller who omitted it reach the
 * service with `undefined` and get a 500 - the request was malformed, but the
 * caller was told our service broke. Same fix as `@sms/attendance`'s
 * `UnmarkedSessionsQueryDto`; see `docs/decisions.md`.
 */
export class CalculateGpaQueryDto extends createZodDto(calculateGpaQuerySchema) {}
export class CreateCreditRuleSetDto extends createZodDto(createCreditRuleSetSchema) {}
export class PublishCreditRuleSetVersionDto extends createZodDto(publishCreditRuleSetVersionSchema) {}
