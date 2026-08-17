// The public surface other modules should depend on: the port
// (`RecordsContract`), its DI token, and the domain types it deals in.
export * from './contract.js';

// `apps/api` additionally needs an actual NestJS module class to wire up.
export { RecordsModule } from './api/records.module.js';

// Exported so `apps/api` can bind the real attendance-summary implementation
// (see `application/attendance-summary-provider.ts`'s own comment) without
// reaching into this module's internals.
export { REPORT_CARD_TEMPLATE_KEY } from './application/report-card.service.js';
