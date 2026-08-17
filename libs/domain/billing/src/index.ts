// The public surface other modules should depend on: the port
// (`BillingContract`), its DI token, and the domain types it deals in.
export * from './contract.js';

// `apps/api` additionally needs an actual NestJS module class to wire up.
export { BillingModule } from './api/billing.module.js';

// The credit-note pilot's domain-side ApprovalHandler - `apps/api`'s
// CreditNoteApprovalHandlerModule is the one place it gets registered into
// @sms/approvals' APPROVAL_HANDLER_REGISTRY - see that module's own comment.
export { CreditNoteApprovalHandler } from './application/credit-note-approval.handler.js';
export { CREDIT_NOTE_APPROVAL_REQUEST_TYPE, CREDIT_NOTE_APPROVAL_SUBJECT_TYPE } from './application/credit-note.service.js';
