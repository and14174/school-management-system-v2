// The public surface other modules should depend on: the port
// (`ImportExportContract`), its DI token, the domain types it deals in, and
// the `ImportTarget`/`IMPORT_TARGET_REGISTRY` inversion point a concrete
// target (built in `apps/api`) registers itself against.
export * from './contract.js';

// `apps/api` additionally needs an actual NestJS module class to wire up.
export { ImportExportModule } from './api/import-export.module.js';
