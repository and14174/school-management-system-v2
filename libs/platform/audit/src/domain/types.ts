import type { Brand, PersonId, TenantId, UserId } from '@sms/kernel';

/**
 * Domain-level shapes for the audit module. These mirror `0100_audit.sql`
 * exactly (see the migration for the authoritative schema) - this file is
 * the pure, infrastructure-free vocabulary that `contract.ts` re-exports
 * and `application/audit.service.ts` implements against.
 */

/** Brand for `audit.bulk_operation.id` - not declared in `@sms/kernel` because it is owned by this module, not shared vocabulary. */
export type BulkOperationId = Brand<string, 'BulkOperationId'>;

export type BulkOperationStatus = 'running' | 'completed' | 'failed' | 'reverted';

export type HistoryOperation = 'insert' | 'update' | 'delete';

/** One row of `audit.record_history` - a before/after image of a tracked table row. */
export interface HistoryEntry {
  readonly id: string;
  readonly tableSchema: string;
  readonly tableName: string;
  readonly recordId: string;
  readonly operation: HistoryOperation;
  readonly before?: Record<string, unknown>;
  readonly after?: Record<string, unknown>;
  /**
   * The authenticated user who made the change - the REAL actor, never an
   * impersonation target. A UserId, not a PersonId: a login is not a person
   * record, and conflating the two makes history unresolvable once
   * people.person exists.
   */
  readonly changedByUserId?: UserId;
  readonly tenantId?: TenantId;
  readonly requestId?: string;
  readonly bulkOperationId?: BulkOperationId;
  readonly occurredAt: Date;
}

/** One row of `audit.bulk_operation`. */
export interface BulkOperation {
  readonly id: BulkOperationId;
  readonly tenantId: TenantId;
  readonly kind: string;
  readonly actorId?: UserId;
  readonly status: BulkOperationStatus;
  readonly summary: Record<string, unknown>;
  readonly startedAt: Date;
  readonly completedAt?: Date;
  readonly revertedByOperationId?: BulkOperationId;
}

export interface RecordAccessInput {
  /** Who the restricted data is about. Omitted for resources that aren't about a single person. */
  readonly personId?: PersonId;
  /** What was read, e.g. `'person.medical_notes'`. */
  readonly resource: string;
  readonly fieldNames: string[];
  readonly reason?: string;
  /** Defaults to the ambient context's `userId` when not supplied. */
  readonly actorId?: UserId;
}

export interface BeginBulkOperationInput {
  readonly kind: string;
  readonly summary?: Record<string, unknown>;
}

export interface GetHistoryInput {
  readonly tableSchema: string;
  readonly tableName: string;
  readonly recordId: string;
  /** Defaults to 50. */
  readonly limit?: number;
  /** Only entries strictly before this instant - for paging back through history. */
  readonly before?: Date;
}

export interface ListBulkOperationsInput {
  /** Defaults to 50. */
  readonly limit?: number;
}
