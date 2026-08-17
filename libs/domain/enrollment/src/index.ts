// The public surface other modules should depend on: the port
// (`EnrollmentContract`), its DI token, and the domain types it deals in.
export * from './contract.js';

// `apps/api` additionally needs an actual NestJS module class to wire up.
export { EnrollmentModule } from './api/enrollment.module.js';
