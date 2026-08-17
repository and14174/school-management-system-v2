import { Module } from '@nestjs/common';
import { AccessModule } from '@sms/access';
import { AuditModule } from '@sms/audit';
import { DOCUMENTS_CONTRACT } from '../contract.js';
import { DocumentsService } from '../application/documents.service.js';
import { PdfRenderer } from '../infrastructure/pdf-renderer.js';
import { OBJECT_STORAGE, S3ObjectStorage } from '../infrastructure/object-storage.js';
import { DocumentsController } from './documents.controller.js';

/**
 * Exports `DOCUMENTS_CONTRACT` (not the concrete `DocumentsService`) -
 * matching `@sms/import-export`'s `ImportExportModule` shape. Imports
 * `AuditModule` for `AUDIT_CONTRACT` (`DocumentsService.getDownloadUrl`'s
 * access-log write) and `AccessModule` for `RequirePermission`, used by
 * every route on `DocumentsController`.
 *
 * Deliberately does NOT provide `DOCUMENT_TEMPLATE_REGISTRY` - same
 * reasoning as `@sms/import-export`'s `ImportExportModule` not providing
 * `IMPORT_TARGET_REGISTRY` (see `application/template-registry.ts`'s own
 * comment): leaving it unbound here is what lets `apps/api`'s `@Global()`
 * override actually reach `DocumentsService`, which lives inside THIS
 * module's own DI container.
 *
 * `S3ObjectStorage` IS provided here (unlike the registry): reading
 * `S3_ENDPOINT`/etc. from the environment is not domain knowledge, so there
 * is nothing for `apps/api` to invert - see `infrastructure/object-storage.ts`.
 */
@Module({
  imports: [AuditModule, AccessModule],
  controllers: [DocumentsController],
  providers: [
    PdfRenderer,
    { provide: OBJECT_STORAGE, useClass: S3ObjectStorage },
    DocumentsService,
    { provide: DOCUMENTS_CONTRACT, useExisting: DocumentsService },
  ],
  exports: [DOCUMENTS_CONTRACT],
})
export class DocumentsModule {}
