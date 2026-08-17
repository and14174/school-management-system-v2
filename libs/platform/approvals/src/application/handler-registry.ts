import type { Tx } from '@sms/db';
import type { UserId } from '@sms/kernel';
import type { ApprovalRequest } from '../domain/types.js';

export interface ApplyApprovalContext {
  readonly request: ApprovalRequest;
  readonly decidedByUserId: UserId;
}

/**
 * A handler for one `requestType`. Registered by `apps/api`, never by the
 * domain module that defines it - see this file's own comment below and
 * `OutboxSubscriber`/`NotificationChannel` for the identical shape.
 *
 * `apply` runs INSIDE the same transaction as the decision that approved the
 * request - `tx` is required, not optional, for the exact reason
 * `OutboxContract.publish(tx, ...)` requires the caller's transaction (see
 * that contract's own comment and docs/decisions.md's notifications-dedupe
 * entry): if this opened its own transaction, an approved request could
 * commit while the change it was supposed to apply never landed, and the
 * system would report success. Throwing here rolls the WHOLE decision back -
 * the vote, the status transition, and whatever this handler partially did -
 * leaving the request genuinely `pending`, not falsely `approved`.
 *
 * The engine (`ApprovalsService`) never inspects `request.payload` - it is
 * opaque, defined entirely by the domain module that called
 * `requestApproval()` and read back here by the one handler that understands
 * it.
 */
export interface ApprovalHandler {
  readonly requestType: string;
  apply(tx: Tx, context: ApplyApprovalContext): Promise<void>;
}

/**
 * The inversion point. This module (`type:platform`) defines the port and
 * must never depend on `type:domain` (the Nx boundary lint enforces this
 * outright), so a real handler - which by definition knows about a domain
 * concept like a credit note - can only ever be REGISTERED from `apps/api`,
 * the one layer allowed to depend on both.
 *
 * Unlike `NOTIFICATION_CHANNEL_REGISTRY`/`SECTION_SCOPE_RESOLVER` (a
 * `@Global()` module in `apps/api` overrides a default this module never
 * binds itself), `ApprovalsModule` DOES provide this token itself - an
 * empty, mutable registry - and `apps/api` pushes handlers into it at
 * `onModuleInit` (see `CreditNoteApprovalHandlerModule`). A handler
 * necessarily depends on the domain module whose change it applies, which in
 * turn depends on `@sms/approvals` to raise the request in the first place;
 * building the registry FROM the handler and supplying it as a `@Global()`
 * override closes a cycle Nest cannot see (the closing edge is a `@Global()`
 * token, not an `imports` entry), and `NestFactory.create` hangs forever
 * with no log output rather than reporting a circular dependency. Owning a
 * mutable registry here inverts the last edge so the graph stays one-way -
 * see `ApprovalsModule`'s own comment.
 */
export interface ApprovalHandlerRegistry {
  get(requestType: string): ApprovalHandler | undefined;
}

export const APPROVAL_HANDLER_REGISTRY = Symbol('APPROVAL_HANDLER_REGISTRY');

/**
 * A request type with no registered handler must never silently resolve to
 * "nothing to apply, so approval trivially succeeds" -
 * `ApprovalsService.decide` treats a missing handler as a reason to REFUSE
 * the approval outright (fail closed, same posture as
 * `DEFAULT_NOTIFICATION_CHANNEL_REGISTRY` and
 * `DEFAULT_DOCUMENT_TEMPLATE_REGISTRY`), never as "approve with no effect".
 * Used only as a standalone-construction safety net now that `ApprovalsModule`
 * always provides a real (initially empty) registry under normal DI - see
 * `ApprovalsService`'s own constructor comment.
 */
export const DEFAULT_APPROVAL_HANDLER_REGISTRY: ApprovalHandlerRegistry = {
  get: () => undefined,
};

/** A `ApprovalHandlerRegistry` backed by a plain `Map` - the shape every real registry (`apps/api`'s included) ends up being, and this module's own test suite's fake handlers. */
export class MapApprovalHandlerRegistry implements ApprovalHandlerRegistry {
  private readonly handlers = new Map<string, ApprovalHandler>();

  constructor(handlers: readonly ApprovalHandler[] = []) {
    for (const handler of handlers) {
      this.handlers.set(handler.requestType, handler);
    }
  }

  register(handler: ApprovalHandler): void {
    this.handlers.set(handler.requestType, handler);
  }

  get(requestType: string): ApprovalHandler | undefined {
    return this.handlers.get(requestType);
  }
}
