import type { DomainError, NotFoundError, Result } from '@sms/kernel';
import type {
  ColumnMapping,
  ImportFieldSpec,
  ImportJob,
  ImportRow,
  ImportRowOutcome,
  PageResult,
  RowError,
} from './domain/types.js';

export * from './domain/types.js';
export * from './application/import-target-registry.js';

export interface CreateJobInput {
  readonly entityType: string;
  readonly filename: string;
  readonly csv: string;
}

export interface CreateJobResult {
  readonly job: ImportJob;
  /** Fuzzy-matched target field key -> CSV header, for the mapping UI to pre-fill and let the caller correct. */
  readonly suggestedMapping: ColumnMapping;
  readonly headers: string[];
}

export interface ListRowsInput {
  readonly outcome?: ImportRowOutcome;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ImportTargetSummary {
  readonly entityType: string;
  readonly fields: ImportFieldSpec[];
}

export interface DryRunRowError {
  readonly rowNumber: number;
  readonly errors: RowError[];
}

export interface DryRunSummary {
  readonly job: ImportJob;
  readonly rowCount: number;
  readonly validCount: number;
  readonly errorCount: number;
  /** How many valid rows `ImportTarget.findExisting` predicts will be creates vs. updates - a preview only; `commit` recomputes this for real. */
  readonly predictedCreateCount: number;
  readonly predictedUpdateCount: number;
  /** First `errorCount` capped to a small number - the point is showing the school what's wrong, not shipping a 1,200-line response. */
  readonly firstErrors: DryRunRowError[];
}

export interface CommitSummary {
  readonly job: ImportJob;
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly errorCount: number;
  readonly skippedCount: number;
}

/**
 * The public port this module exposes to the rest of the system
 * (`apps/api`'s `ImportExportController`) - matching `@sms/people`'s
 * `PeopleContract` pattern: every method resolves the ambient tenant context
 * (`currentTenantContext()`), never takes `tenantId` explicitly.
 *
 * Three phases, one code path: `createJob`/`setMapping` (parse + map),
 * `dryRun` (validate, write nothing to the target), `commit` (write, inside
 * `AuditContract.withBulkOperation` so it is reversible via `revert`). See
 * `application/pipeline.service.ts` for why `dryRun` and `commit` are
 * guaranteed to agree: they call the exact same `ImportTarget.parseRow`/
 * `findExisting`, not two hand-synchronised copies of that logic.
 */
export interface ImportExportContract {
  /** Every registered target's entity type and field list, for the mapping UI. */
  listTargets(): Promise<ImportTargetSummary[]>;

  /** Parses `csv`'s header row and returns the job plus a fuzzy-matched suggested mapping - see `domain/fuzzy-match.ts`. */
  createJob(input: CreateJobInput): Promise<Result<CreateJobResult, DomainError>>;

  setMapping(jobId: string, mapping: ColumnMapping): Promise<Result<ImportJob, DomainError>>;

  /** Validates every row, persists per-row outcomes/errors, writes nothing to the target table. */
  dryRun(jobId: string): Promise<Result<DryRunSummary, DomainError>>;

  /** Requires a prior `dryRun` (`status: 'previewed'`). Creates/updates per row inside one bulk operation. */
  commit(jobId: string): Promise<Result<CommitSummary, DomainError>>;

  /** Requires a completed commit. Restores every row the bulk operation wrote to its prior state and marks the job `'reverted'`. */
  revert(jobId: string): Promise<Result<ImportJob, DomainError>>;

  getJob(jobId: string): Promise<Result<ImportJob, NotFoundError>>;

  listJobs(): Promise<ImportJob[]>;

  listRows(jobId: string, input?: ListRowsInput): Promise<PageResult<ImportRow>>;

  /** The other direction: only works for a target that implements the optional `list()` capability. Stream-friendly - yields CSV text chunks, header row first. */
  exportCsv(entityType: string, filter?: Record<string, unknown>): AsyncIterable<string>;
}

/**
 * DI token for `ImportExportContract` - see `TENANCY_CONTRACT` in
 * `@sms/tenancy` for why a concrete Symbol token is used instead of relying
 * on implicit type-based DI.
 */
export const IMPORT_EXPORT_CONTRACT = Symbol('IMPORT_EXPORT_CONTRACT');
