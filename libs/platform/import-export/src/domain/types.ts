import type { Brand, TenantId, UserId } from '@sms/kernel';

/**
 * Domain-level shapes for the import/export module. These mirror
 * `0800_import_export.sql` exactly (see the migration for the authoritative
 * schema) - this file is the pure, infrastructure-free vocabulary that
 * `contract.ts` re-exports and `application/*.ts` implements against, same
 * convention as `@sms/audit`'s `domain/types.ts`.
 */

export type ImportJobId = Brand<string, 'ImportJobId'>;
export type ImportRowId = Brand<string, 'ImportRowId'>;

export type ImportJobStatus = 'mapping' | 'validating' | 'previewed' | 'committing' | 'completed' | 'failed' | 'reverted';

export type ImportRowOutcome = 'pending' | 'valid' | 'error' | 'created' | 'updated' | 'skipped';

/** Target field key -> source CSV header name. */
export type ColumnMapping = Record<string, string>;

export interface ImportJob {
  readonly id: ImportJobId;
  readonly tenantId: TenantId;
  readonly entityType: string;
  readonly filename: string;
  readonly status: ImportJobStatus;
  readonly columnMapping: ColumnMapping;
  readonly options: Record<string, unknown>;
  readonly rowCount: number;
  readonly validCount: number;
  readonly errorCount: number;
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly skippedCount: number;
  readonly bulkOperationId?: string;
  readonly createdByUserId?: UserId;
  readonly createdAt: Date;
  readonly completedAt?: Date;
}

export interface RowError {
  readonly field?: string;
  readonly message: string;
}

/** Describes one field an `ImportTarget` accepts, for the mapping UI - see `application/import-target-registry.ts`. */
export interface ImportFieldSpec {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly type: 'text' | 'number' | 'date' | 'boolean';
}

export interface ImportRow {
  readonly id: ImportRowId;
  readonly tenantId: TenantId;
  readonly importJobId: ImportJobId;
  readonly rowNumber: number;
  readonly raw: Record<string, string>;
  readonly normalised?: Record<string, unknown>;
  readonly rowHash: string;
  readonly outcome: ImportRowOutcome;
  readonly errors: RowError[];
  readonly targetId?: string;
}

export interface PageResult<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}
