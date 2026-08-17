// The public surface other modules should depend on: the port
// (`CustomFieldsContract`), its DI token, and the domain types it deals in.
export * from './contract.js';

// `apps/api` additionally needs an actual NestJS module class to wire up.
export { CustomFieldsModule } from './api/custom-fields.module.js';
