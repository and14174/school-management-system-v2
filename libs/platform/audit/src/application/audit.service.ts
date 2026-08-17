import { Injectable } from '@nestjs/common';
import { and, desc, eq, lt, sql as rawSql } from 'drizzle-orm';
import { getContext, withTenantTx, type Tx } from '@sms/db';
import { isSystemContext, type TenantContext } from '@sms/kernel';
import type { AuditContract } from '../contract.js';
import type {
  BeginBulkOperationInput,
  BulkOperation,
  BulkOperationId,
  BulkOperationStatus,
  GetHistoryInput,
  HistoryEntry,
  ListBulkOperationsInput,
  RecordAccessInput,
} from '../domain/types.js';
import { accessLog, bulkOperation, recordHistory } from '../infrastructure/schema.js';

const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_BULK_OPERATION_LIMIT = 50;

type BulkOperationRow = typeof bulkOperation.$inferSelect;
type RecordHistoryRow = typeof recordHistory.$inferSelect;

function toHistoryEntry(row: RecordHistoryRow): HistoryEntry {
  return {
    id: row.id,
    tableSchema: row.tableSchema,
    tableName: row.tableName,
    recordId: row.recordId,
    operation: row.operation as HistoryEntry['operation'],
    before: row.before ?? undefined,
    after: row.after ?? undefined,
    changedByUserId: (row.changedByUserId ?? undefined) as HistoryEntry['changedByUserId'],
    tenantId: (row.tenantId ?? undefined) as HistoryEntry['tenantId'],
    requestId: row.requestId ?? undefined,
    bulkOperationId: (row.bulkOperationId ?? undefined) as BulkOperationId | undefined,
    occurredAt: row.occurredAt,
  };
}

function toBulkOperation(row: BulkOperationRow): BulkOperation {
  return {
    id: row.id as BulkOperationId,
    tenantId: row.tenantId as BulkOperation['tenantId'],
    kind: row.kind,
    actorId: (row.actorId ?? undefined) as BulkOperation['actorId'],
    status: row.status as BulkOperationStatus,
    summary: row.summary,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
    revertedByOperationId: (row.revertedByOperationId ?? undefined) as BulkOperationId | undefined,
  };
}

/**
 * Implements `AuditContract` against the real `audit.*` tables (see
 * `infrastructure/schema.ts` and `migrations/0100_audit.sql`). Every method
 * goes through `withTenantTx` - never `withSystemTx` - because audit data is
 * tenant data (RLS-scoped, see the migration's row-level security section)
 * and every call site here has a tenant request in flight.
 */
@Injectable()
export class AuditService implements AuditContract {
  private requireTenantContext(): TenantContext {
    const context = getContext();
    if (!context) {
      throw new Error(
        'No execution context is set. AuditService methods must run inside runWithContext() (the tenant-context interceptor sets this for every HTTP request).',
      );
    }
    if (isSystemContext(context)) {
      throw new Error(
        'AuditService methods require a tenant context. System-level jobs have no business writing or reading audit data - see the RLS comment in 0100_audit.sql.',
      );
    }
    return context;
  }

  async recordAccess(entry: RecordAccessInput): Promise<void> {
    const ctx = this.requireTenantContext();

    await withTenantTx(ctx, async (tx) => {
      await tx.insert(accessLog).values({
        tenantId: ctx.tenantId,
        actorId: entry.actorId ?? ctx.userId ?? null,
        personId: entry.personId ?? null,
        resource: entry.resource,
        fieldNames: entry.fieldNames,
        reason: entry.reason ?? null,
        requestId: ctx.requestId,
      });
    });
  }

  async beginBulkOperation(input: BeginBulkOperationInput): Promise<BulkOperationId> {
    const ctx = this.requireTenantContext();

    return withTenantTx(ctx, (tx) => this.insertBulkOperation(tx, ctx, input));
  }

  private async insertBulkOperation(
    tx: Tx,
    ctx: TenantContext,
    input: BeginBulkOperationInput,
  ): Promise<BulkOperationId> {
    const [row] = await tx
      .insert(bulkOperation)
      .values({
        tenantId: ctx.tenantId,
        kind: input.kind,
        actorId: ctx.userId ?? null,
        summary: input.summary ?? {},
      })
      .returning({ id: bulkOperation.id });

    if (!row) {
      throw new Error('audit.bulk_operation insert returned no row.');
    }

    return row.id as BulkOperationId;
  }

  async completeBulkOperation(
    id: BulkOperationId,
    status: Extract<BulkOperationStatus, 'completed' | 'failed'>,
    summary?: Record<string, unknown>,
  ): Promise<void> {
    const ctx = this.requireTenantContext();

    await withTenantTx(ctx, async (tx) => {
      await tx
        .update(bulkOperation)
        .set({
          status,
          completedAt: new Date(),
          ...(summary !== undefined ? { summary } : {}),
        })
        .where(eq(bulkOperation.id, id));
    });
  }

  async withBulkOperation<T>(input: BeginBulkOperationInput, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const ctx = this.requireTenantContext();

    const id = await withTenantTx(ctx, (tx) => this.insertBulkOperation(tx, ctx, input));

    try {
      const result = await withTenantTx(ctx, async (tx) => {
        // set_config(..., true) => SET LOCAL, transaction-local, exactly
        // like withTenantTx itself (see tx.ts) - it must never survive past
        // this transaction onto a reused pooled connection. Bound
        // parameter, not string interpolation, for the same reason.
        await tx.execute(rawSql`select set_config('app.bulk_operation_id', ${id}, true)`);
        return fn(tx);
      });

      // Separate, fresh transaction: if fn's transaction above failed, its
      // writes (and this bulk operation's own bookkeeping, were it in the
      // same transaction) would roll back together, leaving no row to
      // explain the failure. Recording completion outside that transaction
      // means the outcome is always durable.
      await this.completeBulkOperation(id, 'completed');
      return result;
    } catch (error) {
      await this.completeBulkOperation(id, 'failed');
      throw error;
    }
  }

  async getHistory(input: GetHistoryInput): Promise<HistoryEntry[]> {
    const ctx = this.requireTenantContext();

    return withTenantTx(ctx, async (tx) => {
      const conditions = [
        eq(recordHistory.tableSchema, input.tableSchema),
        eq(recordHistory.tableName, input.tableName),
        eq(recordHistory.recordId, input.recordId),
      ];
      if (input.before) {
        conditions.push(lt(recordHistory.occurredAt, input.before));
      }

      const rows = await tx
        .select()
        .from(recordHistory)
        .where(and(...conditions))
        .orderBy(desc(recordHistory.occurredAt))
        .limit(input.limit ?? DEFAULT_HISTORY_LIMIT);

      return rows.map(toHistoryEntry);
    });
  }

  async getBulkOperation(id: BulkOperationId): Promise<BulkOperation | undefined> {
    const ctx = this.requireTenantContext();

    return withTenantTx(ctx, async (tx) => {
      const [row] = await tx.select().from(bulkOperation).where(eq(bulkOperation.id, id)).limit(1);
      return row ? toBulkOperation(row) : undefined;
    });
  }

  async listBulkOperations(input: ListBulkOperationsInput): Promise<BulkOperation[]> {
    const ctx = this.requireTenantContext();

    return withTenantTx(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(bulkOperation)
        .orderBy(desc(bulkOperation.startedAt))
        .limit(input.limit ?? DEFAULT_BULK_OPERATION_LIMIT);

      return rows.map(toBulkOperation);
    });
  }
}
