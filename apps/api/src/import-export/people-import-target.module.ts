import { Global, Module } from '@nestjs/common';
import { PeopleModule } from '@sms/people';
import { IMPORT_TARGET_REGISTRY, type ImportTarget, type ImportTargetRegistry } from '@sms/import-export';
import { PersonImportTarget } from './people-import-target.js';

/**
 * `@Global()`: this is what actually lets `@sms/import-export`'s
 * `JobService`/`PipelineService` (living inside `ImportExportModule`'s own
 * DI container) see the `IMPORT_TARGET_REGISTRY` override - exactly the
 * reasoning `@sms/academic`'s `AcademicModule` documents for
 * `SECTION_SCOPE_RESOLVER` (see that file's own comment): `@sms/import-export`
 * deliberately does not register this token itself, so a `@Global()`
 * module's exports are the one mechanism that reaches into
 * `ImportExportModule`'s container without it ever importing this one
 * (`@nx/enforce-module-boundaries` forbids `type:platform` -> `type:domain`
 * outright). `apps/api`'s `AppModule` still has to import this module once
 * for Nest to instantiate it.
 *
 * A `Map`-backed registry today (one target), built to hold more without
 * changing shape as further targets (`academic.section_roster`, ...) are
 * registered the same way.
 */
@Global()
@Module({
  imports: [PeopleModule],
  providers: [
    PersonImportTarget,
    {
      provide: IMPORT_TARGET_REGISTRY,
      useFactory: (personTarget: PersonImportTarget): ImportTargetRegistry => {
        const targets = new Map<string, ImportTarget<unknown>>([
          [personTarget.entityType, personTarget as unknown as ImportTarget<unknown>],
        ]);
        return {
          list: () => [...targets.values()].map((target) => ({ entityType: target.entityType, fields: target.fields })),
          get: (entityType: string) => targets.get(entityType),
        };
      },
      inject: [PersonImportTarget],
    },
  ],
  exports: [IMPORT_TARGET_REGISTRY],
})
export class ImportTargetsModule {}
