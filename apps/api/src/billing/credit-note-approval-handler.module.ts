import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { APPROVAL_HANDLER_REGISTRY, ApprovalsModule, type MapApprovalHandlerRegistry } from '@sms/approvals';
import { BillingModule, CreditNoteApprovalHandler } from '@sms/billing';

/**
 * Registers `@sms/billing`'s `CreditNoteApprovalHandler` with the approvals
 * engine. `apps/api` is the only layer allowed to depend on both a
 * `type:platform` module and a `type:domain` one, which is why the wiring
 * lives here rather than inside either module.
 *
 * Registration happens at `onModuleInit`, pushing into the empty registry
 * `ApprovalsModule` owns - NOT by building the registry from the handler and
 * supplying it through a `@Global()` token, the shape used for
 * `NOTIFICATION_CHANNEL_REGISTRY` and `SECTION_SCOPE_RESOLVER`.
 *
 * That shape cannot work here. This module needs `BillingModule` (for the
 * handler), `BillingModule` needs `ApprovalsModule` (`CreditNoteService`
 * raises the approval request), and `ApprovalsService` would need this
 * module's token - a cycle. Nest cannot detect it, because the closing edge
 * is a `@Global()` token rather than an `imports` entry, so instead of a
 * "circular dependency" error `NestFactory.create` hangs forever and
 * `bufferLogs` means not one log line is ever emitted. See
 * `ApprovalsModule`'s own comment.
 *
 * Further handlers (a gradebook/attendance migration onto this engine,
 * admissions decisions, ...) register the same way: import the owning module
 * and add a `register` call below.
 */
@Module({
  imports: [ApprovalsModule, BillingModule],
})
export class CreditNoteApprovalHandlerModule implements OnModuleInit {
  constructor(
    @Inject(APPROVAL_HANDLER_REGISTRY) private readonly registry: MapApprovalHandlerRegistry,
    @Inject(CreditNoteApprovalHandler) private readonly creditNote: CreditNoteApprovalHandler,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.creditNote);
  }
}
