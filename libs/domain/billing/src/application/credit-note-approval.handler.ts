import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@sms/db';
import type { TenantId, UserId } from '@sms/kernel';
import type { ApplyApprovalContext, ApprovalHandler } from '@sms/approvals';
import { CREDIT_NOTE_APPROVAL_REQUEST_TYPE, CreditNoteService } from './credit-note.service.js';

/**
 * The domain half of the `@sms/approvals` credit-note pilot. Defined here,
 * in `@sms/billing` (`type:domain`), NOT registered here - `apps/api`'s
 * `CreditNoteApprovalHandlerModule` is the one place that binds it into
 * `APPROVAL_HANDLER_REGISTRY`, exactly like `AttendanceAbsenceSubscriber` is
 * defined in `@sms/notifications` but wired into `OUTBOX_SUBSCRIBERS` only by
 * `apps/api` - see that module's own comment. `@sms/approvals` (`type:platform`)
 * may never import this class; the Nx boundary lint enforces it outright.
 *
 * `apply` runs INSIDE the approving decision's own transaction (`tx`) - see
 * `ApprovalHandler.apply`'s own comment. It re-validates against the
 * invoice's CURRENT state (`CreditNoteService.applyCreditNote`, the exact
 * core `issueCreditNote` itself writes through when nothing is gated) rather
 * than trusting the snapshot taken when the request was first raised; a
 * validation failure here throws, which rolls the whole decision back -
 * the vote, the status flip, and this write - leaving the request genuinely
 * `pending` again.
 */
@Injectable()
export class CreditNoteApprovalHandler implements ApprovalHandler {
  readonly requestType = CREDIT_NOTE_APPROVAL_REQUEST_TYPE;

  constructor(@Inject(CreditNoteService) private readonly creditNotes: CreditNoteService) {}

  async apply(tx: Tx, context: ApplyApprovalContext): Promise<void> {
    const input = CreditNoteService.payloadToInput(context.request.payload);
    await this.creditNotes.applyCreditNote(tx, context.request.tenantId as TenantId, input, context.decidedByUserId as UserId);
  }
}
