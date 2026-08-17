import { createZodDto } from 'nestjs-zod';
import { notifySchema, publishTemplateVersionSchema, setPreferenceSchema } from '../../application/schemas.js';

/** Validated by an explicit `new ZodValidationPipe(...)` per param - see `NotificationsController`. */
export class PublishTemplateVersionDto extends createZodDto(publishTemplateVersionSchema) {}
export class SetPreferenceDto extends createZodDto(setPreferenceSchema) {}
export class NotifyDto extends createZodDto(notifySchema) {}
