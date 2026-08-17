import { Module } from '@nestjs/common';
import { AccessModule } from '@sms/access';
import { AuditModule } from '@sms/audit';
import { IMPORT_EXPORT_CONTRACT } from '../contract.js';
import { ImportExportService } from '../application/import-export.service.js';
import { JobService } from '../application/job.service.js';
import { PipelineService } from '../application/pipeline.service.js';
import { ImportExportController } from './import-export.controller.js';

/**
 * Exports `IMPORT_EXPORT_CONTRACT` (not the concrete `ImportExportService`) -
 * matching `@sms/people`'s `PeopleModule` shape. Imports `AuditModule` for
 * `AUDIT_CONTRACT` (`PipelineService.commit`/`revert`) and `AccessModule` for
 * `RequirePermission`, used by every route on `ImportExportController`.
 *
 * Deliberately does NOT provide `IMPORT_TARGET_REGISTRY` - same reasoning as
 * `@sms/access`'s `AccessModule` not registering `SECTION_SCOPE_RESOLVER`
 * (see `application/import-target-registry.ts`'s own comment): leaving it
 * unbound here is what lets `apps/api`'s `@Global()` override actually reach
 * `JobService`/`PipelineService`, which live inside THIS module's own DI
 * container.
 */
@Module({
  imports: [AuditModule, AccessModule],
  controllers: [ImportExportController],
  providers: [
    JobService,
    PipelineService,
    ImportExportService,
    { provide: IMPORT_EXPORT_CONTRACT, useExisting: ImportExportService },
  ],
  exports: [IMPORT_EXPORT_CONTRACT],
})
export class ImportExportModule {}
