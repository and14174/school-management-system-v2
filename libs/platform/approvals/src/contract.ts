import type { DomainError, NotFoundError, Result } from '@sms/kernel';
import type { ApprovalDecisionOutcome, ApprovalPolicy, ApprovalRequest, ApprovalRequestDetail, ApprovalRequestStatus } from './domain/types.js';

export * from './domain/types.js';
export {
  APPROVAL_HANDLER_REGISTRY,
  DEFAULT_APPROVAL_HANDLER_REGISTRY,
  MapApprovalHandlerRegistry,
  type ApplyApprovalContext,
  type ApprovalHandler,
  type ApprovalHandlerRegistry,
} from './application/handler-registry.js';

export interface UpsertPolicyInput {
  readonly requestType: string;
  /** A permission catalogue key ('resource:action') - see the `1700` migration header on why this is not an FK. */
  readonly permissionKey: string;
  /** Distinct approvers required. Defaults to 1. */
  readonly approvalsRequired?: number;
}

export interface RequestApprovalInput {
  readonly requestType: string;
  /** Opaque pointer, e.g. `'billing.invoice'` - see the `1700` migration header. */
  readonly subjectType: string;
  readonly subjectId: string;
  /** Round-tripped verbatim to the registered `ApprovalHandler.apply` on approval - opaque to this module. */
  readonly payload: Record<string, unknown>;
}

export interface DecideApprovalInput {
  readonly requestId: string;
  readonly decision: ApprovalDecisionOutcome;
  readonly reason?: string;
}

export interface ListRequestsInput {
  readonly requestType?: string;
  readonly status?: ApprovalRequestStatus;
}

/**
 * The public port this module exposes to the rest of the system - matching
 * `@sms/notifications`' `NotificationsContract` pattern: every other module
 * depends on this interface (via `APPROVALS_CONTRACT`), never on the
 * concrete `ApprovalsService` behind it.
 */
export interface ApprovalsContract {
  /** Configures who may decide `requestType` and how many distinct approvals it needs. Upserts on `(tenant, requestType)`. */
  upsertPolicy(input: UpsertPolicyInput): Promise<Result<ApprovalPolicy, DomainError>>;
  listPolicies(): Promise<ApprovalPolicy[]>;
  getPolicy(requestType: string): Promise<ApprovalPolicy | null>;

  /**
   * Creates a pending request. Always succeeds (given a valid input) even
   * when no policy exists yet for `requestType` - the request simply stays
   * `pending` forever until one does (fail closed - see `decide`'s own
   * comment and the module brief rule 6). Domain callers are expected to
   * gate whether they call this at all on their OWN business rule (e.g.
   * "only above a threshold") - this module has no opinion on that.
   */
  requestApproval(input: RequestApprovalInput): Promise<Result<ApprovalRequest, DomainError>>;

  /**
   * Records the caller's decision (the ambient context's actor). Refuses
   * outright - the request stays `pending` - when: no policy is configured
   * for the request's type; the caller does not hold the permission the
   * policy names; the caller is the original requester (also enforced at the
   * database level - see the `1700` migration header); or, for an approval,
   * no `ApprovalHandler` is registered for the request's type.
   *
   * When the Nth distinct approval (per the policy's `approvalsRequired`) is
   * recorded, the registered handler runs INSIDE the same transaction as
   * that decision - see `ApprovalHandler.apply`'s own comment. A single
   * rejection decides the request outright.
   */
  decide(input: DecideApprovalInput): Promise<Result<ApprovalRequest, DomainError>>;

  getRequest(id: string): Promise<Result<ApprovalRequestDetail, NotFoundError>>;
  listRequests(input: ListRequestsInput): Promise<ApprovalRequest[]>;
}

/** DI token for `ApprovalsContract`. */
export const APPROVALS_CONTRACT = Symbol('APPROVALS_CONTRACT');
