import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
  err,
  newId,
  ok,
  type DomainError,
  type Result,
  type UserId,
} from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import { ACCESS_CONTRACT, type AccessContract } from '@sms/access';
import type {
  ApprovalsContract,
  DecideApprovalInput,
  ListRequestsInput,
  RequestApprovalInput,
  UpsertPolicyInput,
} from '../contract.js';
import type { ApprovalPolicy, ApprovalRequest, ApprovalRequestDetail } from '../domain/types.js';
import { toDecision, toPolicy, toRequest } from '../infrastructure/mappers.js';
import { decisionTable, policyTable, requestTable } from '../infrastructure/schema.js';
import {
  DEFAULT_APPROVAL_HANDLER_REGISTRY,
  APPROVAL_HANDLER_REGISTRY,
  type ApprovalHandlerRegistry,
} from './handler-registry.js';
import { requireTenantContext } from './current-context.js';
import { toDomainError } from './sql-errors.js';

type DecisionCountRow = { readonly n: string | number };

/**
 * Implements `ApprovalsContract`. The engine decides; it never applies a
 * change itself (module brief rule 2) - `decide()`'s only domain-specific
 * act is handing `request.payload` untouched to whatever `ApprovalHandler`
 * is registered for `request.requestType`.
 */
@Injectable()
export class ApprovalsService implements ApprovalsContract {
  // @Optional() with the DEFAULT_APPROVAL_HANDLER_REGISTRY fallback - only a
  // safety net for a standalone `new ApprovalsService(access)` outside Nest
  // DI. Under normal DI, `ApprovalsModule` always provides a real (empty,
  // mutable) `MapApprovalHandlerRegistry` for this token - see that module's
  // own comment for why it owns the registry rather than expecting an
  // `apps/api`-supplied `@Global()` override (the shape
  // `NOTIFICATION_CHANNEL_REGISTRY`/`SECTION_SCOPE_RESOLVER` use).
  constructor(
    @Inject(ACCESS_CONTRACT) private readonly access: AccessContract,
    @Optional()
    @Inject(APPROVAL_HANDLER_REGISTRY)
    private readonly handlers: ApprovalHandlerRegistry = DEFAULT_APPROVAL_HANDLER_REGISTRY,
  ) {}

  async upsertPolicy(input: UpsertPolicyInput): Promise<Result<ApprovalPolicy, DomainError>> {
    const ctx = requireTenantContext();
    const approvalsRequired = input.approvalsRequired ?? 1;
    if (!Number.isInteger(approvalsRequired) || approvalsRequired < 1) {
      return err(new ValidationError('approvalsRequired must be a positive integer.'));
    }
    if (!input.requestType.trim() || !input.permissionKey.includes(':')) {
      return err(new ValidationError('permissionKey must be a catalogue key of the form "resource:action".'));
    }

    try {
      const [row] = await withTenantTx(ctx, (tx) =>
        tx
          .insert(policyTable)
          .values({
            id: newId(),
            tenantId: ctx.tenantId,
            requestType: input.requestType,
            permissionKey: input.permissionKey,
            approvalsRequired,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [policyTable.tenantId, policyTable.requestType],
            set: { permissionKey: input.permissionKey, approvalsRequired, updatedAt: new Date() },
          })
          .returning(),
      );
      if (!row) throw new Error('approvals.policy upsert returned no row.');
      return ok(toPolicy(row));
    } catch (error) {
      return err(toDomainError(error, `Could not save an approval policy for "${input.requestType}".`) as DomainError);
    }
  }

  async listPolicies(): Promise<ApprovalPolicy[]> {
    const ctx = requireTenantContext();
    const rows = await withTenantTx(ctx, (tx) =>
      tx.select().from(policyTable).where(eq(policyTable.tenantId, ctx.tenantId)).orderBy(policyTable.requestType),
    );
    return rows.map(toPolicy);
  }

  async getPolicy(requestType: string): Promise<ApprovalPolicy | null> {
    const ctx = requireTenantContext();
    const [row] = await withTenantTx(ctx, (tx) =>
      tx
        .select()
        .from(policyTable)
        .where(and(eq(policyTable.tenantId, ctx.tenantId), eq(policyTable.requestType, requestType)))
        .limit(1),
    );
    return row ? toPolicy(row) : null;
  }

  async requestApproval(input: RequestApprovalInput): Promise<Result<ApprovalRequest, DomainError>> {
    const ctx = requireTenantContext();
    const requesterId = ctx.actorUserId ?? ctx.userId;
    if (!requesterId) {
      return err(new ForbiddenError('requestApproval requires an authenticated caller.'));
    }

    try {
      const created = await withTenantTx(ctx, async (tx) => {
        const [policyRow] = await tx
          .select()
          .from(policyTable)
          .where(and(eq(policyTable.tenantId, ctx.tenantId), eq(policyTable.requestType, input.requestType)))
          .limit(1);

        // No policy yet is NOT refused here - the request is durably
        // recorded and simply stays pending until a policy exists (see
        // decide()'s own fail-closed check). Snapshotted onto the row so a
        // later policy edit never retroactively changes how many votes an
        // in-flight request needs - see the `1700` migration header.
        const approvalsRequired = policyRow?.approvalsRequired ?? 1;

        const [row] = await tx
          .insert(requestTable)
          .values({
            id: newId(),
            tenantId: ctx.tenantId,
            requestType: input.requestType,
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            payload: input.payload,
            requestedByUserId: requesterId,
            approvalsRequired,
            status: 'pending',
          })
          .returning();
        if (!row) throw new Error('approvals.request insert returned no row.');
        return row;
      });
      return ok(toRequest(created));
    } catch (error) {
      return err(toDomainError(error, `Could not create an approval request of type "${input.requestType}".`) as DomainError);
    }
  }

  async decide(input: DecideApprovalInput): Promise<Result<ApprovalRequest, DomainError>> {
    const ctx = requireTenantContext();
    const deciderId = ctx.actorUserId ?? ctx.userId;
    if (!deciderId) {
      return err(new ForbiddenError('decide requires an authenticated caller.'));
    }

    try {
      // Resolved BEFORE the transaction below, deliberately - it is a read of
      // the DECIDER's own permissions, independent of which request is being
      // decided, so resolving it up front costs nothing on the common path.
      // `AccessContract.compileAbility` opens its OWN `withTenantTx` calls
      // internally (`AbilityService.loadGrants`) - nesting those inside the
      // transaction below is exactly what deadlocked `withAuthTx` inside
      // Better Auth's session hook (see docs/decisions.md and
      // `NotificationsService.notify`'s identical `RECIPIENT_RESOLVER`
      // precedent). It genuinely hung every decide() call in testing until
      // moved out here - not resource contention, a real nested-transaction
      // deadlock.
      const ability = await this.access.compileAbility(deciderId as UserId, ctx.tenantId);

      const decided = await withTenantTx(ctx, async (tx) => {
        // Row-locked for the rest of this transaction: two concurrent
        // decide() calls on the SAME request serialize here, which is what
        // makes the distinct-approver count (below) and the pending ->
        // approved|rejected claim correct under concurrency, not merely under
        // a single caller retrying.
        const requestRows = await tx
          .select()
          .from(requestTable)
          .where(and(eq(requestTable.tenantId, ctx.tenantId), eq(requestTable.id, input.requestId)))
          .for('update')
          .limit(1);
        const request = requestRows[0];
        if (!request) {
          throw new NotFoundError(`Approval request ${input.requestId} not found.`);
        }
        if (request.status !== 'pending') {
          throw new ConflictError(`Approval request ${input.requestId} has already been decided (status: ${request.status}).`);
        }

        const [policyRow] = await tx
          .select()
          .from(policyTable)
          .where(and(eq(policyTable.tenantId, ctx.tenantId), eq(policyTable.requestType, request.requestType)))
          .limit(1);
        if (!policyRow) {
          // Fail closed: nobody is configured to decide this request type -
          // module brief rule 6. It stays pending.
          throw new PreconditionFailedError(
            `No approval policy is configured for request type "${request.requestType}" - it cannot be decided and stays pending.`,
          );
        }

        // App-level check for a clean error message. The REAL enforcement is
        // the database trigger on approvals.decision
        // (trg_forbid_self_decision) - see the `1700` migration header and
        // docs/decisions.md's "Conflict detection belongs in the database".
        if (request.requestedByUserId === deciderId) {
          throw new ForbiddenError('You requested this approval and cannot decide it yourself.');
        }

        const separatorIndex = policyRow.permissionKey.lastIndexOf(':');
        const resource = policyRow.permissionKey.slice(0, separatorIndex);
        const action = policyRow.permissionKey.slice(separatorIndex + 1);
        if (!ability.can(action, resource)) {
          throw new ForbiddenError(`Deciding a "${request.requestType}" request requires permission "${policyRow.permissionKey}".`);
        }

        if (input.decision === 'reject') {
          await tx.insert(decisionTable).values({
            id: newId(),
            tenantId: ctx.tenantId,
            requestId: request.id,
            decidedByUserId: deciderId,
            decision: 'reject',
            reason: input.reason ?? null,
          });

          const [updated] = await tx
            .update(requestTable)
            .set({ status: 'rejected' })
            .where(and(eq(requestTable.id, request.id), eq(requestTable.status, 'pending')))
            .returning();
          if (!updated) throw new Error('approvals.request update returned no row despite holding its row lock.');
          return updated;
        }

        // Approve path. A handler must exist BEFORE the vote is recorded -
        // an approval that could never be applied must never look like it
        // succeeded (fail closed, same posture as the missing-policy check
        // above).
        const handler = this.handlers.get(request.requestType);
        if (!handler) {
          throw new PreconditionFailedError(
            `No approval handler is registered for request type "${request.requestType}" - it cannot be applied.`,
          );
        }

        // Unique (request_id, decided_by_user_id) - a second approval by the
        // SAME user conflicts here rather than being counted twice. See the
        // `1700` migration header.
        await tx.insert(decisionTable).values({
          id: newId(),
          tenantId: ctx.tenantId,
          requestId: request.id,
          decidedByUserId: deciderId,
          decision: 'approve',
          reason: input.reason ?? null,
        });

        const countRows = await tx.execute<DecisionCountRow>(
          sql`select count(distinct decided_by_user_id) as n from approvals.decision where request_id = ${request.id} and decision = 'approve'`,
        );
        const approvalsCast = Number((countRows as unknown as DecisionCountRow[])[0]?.n ?? 0);

        if (approvalsCast < request.approvalsRequired) {
          // Recorded, but the threshold has not been met yet - still pending.
          return request;
        }

        // The atomic claim (module brief rule 4): only the decision that
        // actually crosses the threshold gets to flip status and run the
        // handler, via `UPDATE ... WHERE status = 'pending'`, never
        // check-then-write.
        const [updated] = await tx
          .update(requestTable)
          .set({ status: 'approved' })
          .where(and(eq(requestTable.id, request.id), eq(requestTable.status, 'pending')))
          .returning();
        if (!updated) throw new Error('approvals.request update returned no row despite holding its row lock.');

        // Same transaction as the decision and the status flip (module brief
        // rule 3) - see `ApprovalHandler.apply`'s own comment and
        // docs/decisions.md's notifications-dedupe entry. A throw here rolls
        // EVERYTHING in this function back, including the vote just inserted
        // above - the request is left genuinely `pending`, not falsely
        // `approved` with an effect that never landed.
        await handler.apply(tx, { request: toRequest(updated), decidedByUserId: deciderId as UserId });

        return updated;
      });
      return ok(toRequest(decided));
    } catch (error) {
      return err(toDomainError(error, `Could not decide approval request ${input.requestId}.`) as DomainError);
    }
  }

  async getRequest(id: string): Promise<Result<ApprovalRequestDetail, NotFoundError>> {
    const ctx = requireTenantContext();
    const [row] = await withTenantTx(ctx, (tx) =>
      tx.select().from(requestTable).where(and(eq(requestTable.tenantId, ctx.tenantId), eq(requestTable.id, id))).limit(1),
    );
    if (!row) {
      return err(new NotFoundError(`Approval request ${id} not found.`));
    }
    const decisionRows = await withTenantTx(ctx, (tx) =>
      tx
        .select()
        .from(decisionTable)
        .where(and(eq(decisionTable.tenantId, ctx.tenantId), eq(decisionTable.requestId, id)))
        .orderBy(desc(decisionTable.decidedAt)),
    );
    return ok({ ...toRequest(row), decisions: decisionRows.map(toDecision) });
  }

  async listRequests(input: ListRequestsInput): Promise<ApprovalRequest[]> {
    const ctx = requireTenantContext();
    const conditions = [eq(requestTable.tenantId, ctx.tenantId)];
    if (input.requestType) conditions.push(eq(requestTable.requestType, input.requestType));
    if (input.status) conditions.push(eq(requestTable.status, input.status));

    const rows = await withTenantTx(ctx, (tx) =>
      tx
        .select()
        .from(requestTable)
        .where(and(...conditions))
        .orderBy(desc(requestTable.createdAt)),
    );
    return rows.map(toRequest);
  }
}
