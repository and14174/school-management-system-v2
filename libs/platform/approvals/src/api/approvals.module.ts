import { Module } from '@nestjs/common';
import { AccessModule } from '@sms/access';
import { APPROVALS_CONTRACT } from '../contract.js';
import { ApprovalsService } from '../application/approvals.service.js';
import { APPROVAL_HANDLER_REGISTRY, MapApprovalHandlerRegistry } from '../application/handler-registry.js';
import { ApprovalsController } from './approvals.controller.js';

/**
 * Exports `APPROVALS_CONTRACT` (not the concrete `ApprovalsService`) -
 * matching `@sms/notifications`' `NotificationsModule` shape. Imports
 * `AccessModule` for `ACCESS_CONTRACT` (`ApprovalsService.decide`'s
 * permission check against the deciding policy) and `RequirePermission`,
 * used by `ApprovalsController`.
 *
 * Provides `APPROVAL_HANDLER_REGISTRY` as an EMPTY, mutable registry that
 * handlers register themselves INTO, and exports it.
 *
 * This differs from `NOTIFICATION_CHANNEL_REGISTRY`'s `@Global()`-override
 * shape, and deliberately so: an approval handler necessarily depends on the
 * domain module whose change it applies (`CreditNoteApprovalHandler` needs
 * `@sms/billing`), and that module in turn depends on THIS one to raise the
 * approval request. Building the registry by injecting the handler therefore
 * closes a cycle - handler module -> billing -> approvals -> (registry token
 * supplied by the handler module). Because the last edge runs through a
 * `@Global()` token rather than an `imports` entry, Nest cannot see it as a
 * circular dependency and reports nothing: `NestFactory.create` simply hangs
 * forever, with no log line, because `bufferLogs` never flushes. That cost a
 * long debugging session; do not reintroduce it.
 *
 * Owning an empty registry here inverts the last edge. Handlers are pushed in
 * at `onModuleInit` (see `apps/api`'s `CreditNoteApprovalHandlerModule`), so
 * the dependency graph stays one-way: handler module -> {approvals, billing},
 * billing -> approvals. The fail-closed behaviour is unchanged - a request
 * type whose handler never registered still resolves to `undefined` and
 * `decide` refuses it.
 */
@Module({
  imports: [AccessModule],
  controllers: [ApprovalsController],
  providers: [
    ApprovalsService,
    { provide: APPROVALS_CONTRACT, useExisting: ApprovalsService },
    { provide: APPROVAL_HANDLER_REGISTRY, useFactory: () => new MapApprovalHandlerRegistry() },
  ],
  exports: [APPROVALS_CONTRACT, APPROVAL_HANDLER_REGISTRY],
})
export class ApprovalsModule {}
