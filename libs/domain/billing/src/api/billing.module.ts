import { Module } from '@nestjs/common';
import { AccessModule } from '@sms/access';
import { AuditModule } from '@sms/audit';
import { OutboxModule } from '@sms/outbox';
import { ApprovalsModule } from '@sms/approvals';
import { BILLING_CONTRACT } from '../contract.js';
import { BillingService } from '../application/billing.service.js';
import { CreditNoteService } from '../application/credit-note.service.js';
import { CreditNoteApprovalHandler } from '../application/credit-note-approval.handler.js';
import { FeeScheduleService } from '../application/fee-schedule.service.js';
import { InvoiceService } from '../application/invoice.service.js';
import { PaymentService } from '../application/payment.service.js';
import { BillingController } from './billing.controller.js';

/**
 * Exports `BILLING_CONTRACT` (not the concrete `BillingService`) - matching
 * `@sms/records`'s `RecordsModule` shape. Imports `AccessModule`
 * (`@RequirePermission` plus `BillingController`'s own direct
 * `resolveScopeConstraints` calls - see that file's own comment),
 * `OutboxModule` (`billing.invoice_issued`/`billing.payment_recorded`,
 * published on the caller's transaction - see `InvoiceService.issueInvoice`/
 * `PaymentService.recordPayment`), and `AuditModule` for parity with
 * `@sms/records`/`@sms/communications` even though nothing here calls
 * `AUDIT_CONTRACT` directly - every table's history is captured by the
 * `audit.attach_history` DB trigger, not application code.
 *
 * Does NOT import `@sms/people` or `@sms/academic`: `student_person_id`/
 * `payer_person_id`/`academic_year_id` are plain (unvalidated beyond the FK)
 * ids here, same "point at another schema's row without depending on its
 * module" posture `communications.thread.subject_id` documents - the
 * foreign-key constraints in the `1400` migration are the actual
 * referential-integrity check.
 *
 * Imports `ApprovalsModule` for `APPROVALS_CONTRACT`
 * (`CreditNoteService.issueCreditNote`'s opt-in gating - see the `1401`
 * migration header) and provides `CreditNoteApprovalHandler`, exported so
 * `apps/api`'s `CreditNoteApprovalHandlerModule` can register it into
 * `@sms/approvals`' `APPROVAL_HANDLER_REGISTRY` - the same two-step
 * "define here, wire in apps/api" split `NotificationsModule` uses for
 * `AttendanceAbsenceSubscriber`.
 */
@Module({
  imports: [AccessModule, AuditModule, OutboxModule, ApprovalsModule],
  controllers: [BillingController],
  providers: [
    FeeScheduleService,
    InvoiceService,
    PaymentService,
    CreditNoteService,
    CreditNoteApprovalHandler,
    BillingService,
    { provide: BILLING_CONTRACT, useExisting: BillingService },
  ],
  exports: [BILLING_CONTRACT, CreditNoteApprovalHandler],
})
export class BillingModule {}
