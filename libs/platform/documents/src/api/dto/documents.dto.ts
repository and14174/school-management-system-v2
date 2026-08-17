import { createZodDto } from 'nestjs-zod';
import { generateDocumentSchema, listDocumentsQuerySchema, publishTemplateVersionSchema, reissueDocumentSchema } from '../../application/schemas.js';

/** Validated by an explicit `new ZodValidationPipe(...)` per param - see `DocumentsController`. */
export class PublishTemplateVersionDto extends createZodDto(publishTemplateVersionSchema) {}
export class GenerateDocumentDto extends createZodDto(generateDocumentSchema) {}
export class ReissueDocumentDto extends createZodDto(reissueDocumentSchema) {}
export class ListDocumentsQueryDto extends createZodDto(listDocumentsQuerySchema) {}
