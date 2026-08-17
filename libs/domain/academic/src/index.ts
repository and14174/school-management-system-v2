// The public surface other modules should depend on: the port
// (`AcademicContract`), its DI token, and the domain types it deals in.
export * from './contract.js';

// `apps/api` additionally needs an actual NestJS module class to wire up.
export { AcademicModule } from './api/academic.module.js';

// `apps/api` binds this as `@sms/access`'s `SECTION_SCOPE_RESOLVER` override
// (see `AcademicModule`'s own comment) - exported so it can be referenced by
// type if ever needed outside this module's own DI wiring.
export { SectionScopeResolverService } from './application/section-scope-resolver.service.js';
