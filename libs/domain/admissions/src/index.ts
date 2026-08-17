// The public surface other modules should depend on: the port
// (`AdmissionsContract`), its DI token, and the domain types it deals in.
export * from './contract.js';

// `apps/api` additionally needs an actual NestJS module class to wire up.
export { AdmissionsModule } from './api/admissions.module.js';
