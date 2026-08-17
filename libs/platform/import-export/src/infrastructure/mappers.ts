import type { ImportJob, ImportJobId, ImportJobStatus, ImportRow, ImportRowId, ImportRowOutcome, RowError } from '../domain/types.js';
import type { importJob, importRow } from './schema.js';

type ImportJobRow = typeof importJob.$inferSelect;
type ImportRowRow = typeof importRow.$inferSelect;

export function toImportJob(row: ImportJobRow): ImportJob {
  return {
    id: row.id as ImportJobId,
    tenantId: row.tenantId as ImportJob['tenantId'],
    entityType: row.entityType,
    filename: row.filename,
    status: row.status as ImportJobStatus,
    columnMapping: row.columnMapping,
    options: row.options,
    rowCount: row.rowCount,
    validCount: row.validCount,
    errorCount: row.errorCount,
    createdCount: row.createdCount,
    updatedCount: row.updatedCount,
    skippedCount: row.skippedCount,
    bulkOperationId: row.bulkOperationId ?? undefined,
    createdByUserId: (row.createdByUserId ?? undefined) as ImportJob['createdByUserId'],
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? undefined,
  };
}

export function toImportRow(row: ImportRowRow): ImportRow {
  return {
    id: row.id as ImportRowId,
    tenantId: row.tenantId as ImportRow['tenantId'],
    importJobId: row.importJobId as ImportJobId,
    rowNumber: row.rowNumber,
    raw: row.raw,
    normalised: row.normalised ?? undefined,
    rowHash: row.rowHash,
    outcome: row.outcome as ImportRowOutcome,
    errors: row.errors as RowError[],
    targetId: row.targetId ?? undefined,
  };
}
