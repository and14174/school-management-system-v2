import { Global, Module } from '@nestjs/common';
import {
  DOCUMENT_TEMPLATE_REGISTRY,
  sampleCertificateTemplate,
  type DocumentTemplate,
  type DocumentTemplateRegistry,
} from '@sms/documents';
import { reportCardTemplate } from './report-card.template.js';

/**
 * `@Global()`: this is what actually lets `@sms/documents`' `DocumentsService`
 * (living inside `DocumentsModule`'s own DI container) see the
 * `DOCUMENT_TEMPLATE_REGISTRY` override - exactly the reasoning
 * `@sms/import-export`'s `ImportTargetsModule` documents for
 * `IMPORT_TARGET_REGISTRY` (same file shape, same precedent): `@sms/documents`
 * deliberately does not register this token itself, so a `@Global()` module's
 * exports are the one mechanism that reaches into `DocumentsModule`'s
 * container without it ever importing this one (`@nx/enforce-module-boundaries`
 * forbids `type:platform -> type:domain` outright). `apps/api`'s `AppModule`
 * still has to import this module once for Nest to instantiate it.
 *
 * `sample-certificate` plus the real `report_card` template
 * (`report-card.template.ts`, built against `@sms/records`' exported
 * `ReportCardSnapshot` shape - see that file's own header) are registered
 * here. Transcripts/ID cards/invoices are future work. When one exists,
 * register it here the same way `PersonImportTarget` is registered in
 * `people-import-target.module.ts`: build it against that module's own
 * contract, add it to the `Map` below.
 */
@Global()
@Module({
  providers: [
    {
      provide: DOCUMENT_TEMPLATE_REGISTRY,
      useFactory: (): DocumentTemplateRegistry => {
        const templates = new Map<string, DocumentTemplate>([
          [sampleCertificateTemplate.key, sampleCertificateTemplate],
          [reportCardTemplate.key, reportCardTemplate as unknown as DocumentTemplate],
        ]);
        return {
          list: () => [...templates.values()].map((t) => ({ key: t.key, name: t.name })),
          get: (key: string) => templates.get(key),
        };
      },
    },
  ],
  exports: [DOCUMENT_TEMPLATE_REGISTRY],
})
export class DocumentTemplatesModule {}
