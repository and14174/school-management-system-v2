import type { TenantId, UserId } from '@sms/kernel';

/** Mirrors `approvals.policy`. Configuration, not code - see the `1700` migration header. */
export interface ApprovalPolicy {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly requestType: string;
  readonly permissionKey: string;
  readonly approvalsRequired: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ApprovalRequestStatus = 'pending' | 'approved' | 'rejected';
export const APPROVAL_REQUEST_STATUSES: readonly ApprovalRequestStatus[] = ['pending', 'approved', 'rejected'];

/**
 * Mirrors `approvals.request`. `subjectType`/`subjectId` and `payload` are
 * opaque to this module - see the `1700` migration header. `payload` is
 * whatever the requesting domain module needs to round-trip through its
 * `ApprovalHandler.apply` once a decision approves it.
 */
export interface ApprovalRequest {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly requestType: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly payload: Record<string, unknown>;
  readonly requestedByUserId: UserId;
  /** Snapshotted from `approvals.policy` at request time - see the `1700` migration header. */
  readonly approvalsRequired: number;
  readonly status: ApprovalRequestStatus;
  readonly createdAt: Date;
}

export type ApprovalDecisionOutcome = 'approve' | 'reject';

/** Mirrors `approvals.decision`. Append-only - see the `1700` migration header. */
export interface ApprovalDecisionRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly requestId: string;
  readonly decidedByUserId: UserId;
  readonly decision: ApprovalDecisionOutcome;
  readonly reason: string | null;
  readonly decidedAt: Date;
}

/** An `ApprovalRequest` together with every decision recorded against it - what `getRequest` returns. */
export interface ApprovalRequestDetail extends ApprovalRequest {
  readonly decisions: readonly ApprovalDecisionRecord[];
}
