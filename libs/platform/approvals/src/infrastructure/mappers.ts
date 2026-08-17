import type { TenantId, UserId } from '@sms/kernel';
import type { ApprovalDecisionOutcome, ApprovalDecisionRecord, ApprovalPolicy, ApprovalRequest, ApprovalRequestStatus } from '../domain/types.js';
import type { decisionTable, policyTable, requestTable } from './schema.js';

type PolicyRow = typeof policyTable.$inferSelect;
type RequestRow = typeof requestTable.$inferSelect;
type DecisionRow = typeof decisionTable.$inferSelect;

export function toPolicy(row: PolicyRow): ApprovalPolicy {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    requestType: row.requestType,
    permissionKey: row.permissionKey,
    approvalsRequired: row.approvalsRequired,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toRequest(row: RequestRow): ApprovalRequest {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    requestType: row.requestType,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    payload: row.payload as Record<string, unknown>,
    requestedByUserId: row.requestedByUserId as UserId,
    approvalsRequired: row.approvalsRequired,
    status: row.status as ApprovalRequestStatus,
    createdAt: row.createdAt,
  };
}

export function toDecision(row: DecisionRow): ApprovalDecisionRecord {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    requestId: row.requestId,
    decidedByUserId: row.decidedByUserId as UserId,
    decision: row.decision as ApprovalDecisionOutcome,
    reason: row.reason,
    decidedAt: row.decidedAt,
  };
}
