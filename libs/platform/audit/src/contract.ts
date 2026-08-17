import type { Tx } from '@sms/db';
import type {
  BeginBulkOperationInput,
  BulkOperation,
  BulkOperationId,
  BulkOperationStatus,
  GetHistoryInput,
  HistoryEntry,
  HistoryOperation,
  ListBulkOperationsInput,
  RecordAccessInput,
} from './domain/types.js';

export type {
  BeginBulkOperationInput,
  BulkOperation,
  BulkOperationId,
  BulkOperationStatus,
  GetHistoryInput,
  HistoryEntry,
  HistoryOperation,
  ListBulkOperationsInput,
  RecordAccessInput,
};

/**
 * The public surface of the audit module. Every other module reaches audit
 * capability through this interface (injected via the `AUDIT_CONTRACT`
 * token) and never through `application/` or `infrastructure/` directly -
 * those are implementation details that can change without touching a
 * caller.
 */
export interface AuditContract {
  /**
   * Appends a row to `audit.access_log`. Call this whenever a response
   * includes a restricted field (medical, counselling, safeguarding) so
   * there is a durable record of who read what about whom, and why.
   * `tenantId`/`requestId` always come from the ambient context (see
   * `@sms/db`'s `getContext`); `actorId` falls back to the ambient
   * context's `userId` when not supplied.
   */
  recordAccess(entry: RecordAccessInput): Promise<void>;

  /**
   * Opens a new `audit.bulk_operation` row with `status: 'running'` and
   * returns its id. Prefer `withBulkOperation` unless you need begin/complete
   * to straddle more than one transaction (e.g. a long-running import
   * processed in batches).
   */
  beginBulkOperation(input: BeginBulkOperationInput): Promise<BulkOperationId>;

  /** Marks a bulk operation `'completed'` or `'failed'`, stamping `completed_at`. */
  completeBulkOperation(
    id: BulkOperationId,
    status: Extract<BulkOperationStatus, 'completed' | 'failed'>,
    summary?: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Convenience wrapper around begin/set-GUC/run/complete. Begins the bulk
   * operation, opens a transaction with `app.bulk_operation_id` set via
   * `set_config(..., true)` (transaction-local, so it never leaks onto a
   * pooled connection - see `@sms/db`'s `withTenantTx`), and runs `fn`
   * inside it. Every row `fn` writes using the transaction handle it is
   * given is stamped with `bulk_operation_id` by the history trigger.
   *
   * The bulk operation is marked `'completed'` if `fn` resolves and
   * `'failed'` (in a fresh transaction, so the failure is durably recorded
   * even though `fn`'s own writes rolled back) if it throws; the error is
   * always rethrown to the caller.
   */
  withBulkOperation<T>(input: BeginBulkOperationInput, fn: (tx: BulkOperationTx) => Promise<T>): Promise<T>;

  /** Reads back `audit.record_history` for one record, newest first. */
  getHistory(input: GetHistoryInput): Promise<HistoryEntry[]>;

  getBulkOperation(id: BulkOperationId): Promise<BulkOperation | undefined>;

  listBulkOperations(input: ListBulkOperationsInput): Promise<BulkOperation[]>;
}

/**
 * The transaction handle `withBulkOperation`'s callback receives - the same
 * handle `withTenantTx` (`@sms/db`) hands its own callers, aliased here so
 * the contract has a name of its own.
 */
export type BulkOperationTx = Tx;

/** Nest DI token for `AuditContract` - see `audit.module.ts`. Interfaces have no runtime representation, so a token is required. */
export const AUDIT_CONTRACT = Symbol('AUDIT_CONTRACT');
