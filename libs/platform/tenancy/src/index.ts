// The public surface other modules should depend on: the port
// (`TenancyContract`), its DI token, and the domain types it deals in.
export * from './contract.js';

// `apps/api` additionally needs an actual NestJS module class to wire up -
// an interface alone can't be `imports: [...]`'d. Exporting it here (rather
// than adding a second entrypoint) keeps this package's contract the single
// public surface, per the module's spec, while still giving the one real
// consumer (`apps/api`) what it needs to register controllers/providers.
export { TenancyModule } from './api/tenancy.module.js';
