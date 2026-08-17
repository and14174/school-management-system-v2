import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { ConflictError, NotFoundError, ValidationError, newId, err, ok, type DomainError, type Result } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import { formatCsvRow, parseCsv, rowToRecord } from '../domain/csv.js';
import { computeRowHash } from '../domain/hash.js';
import { suggestMapping } from '../domain/fuzzy-match.js';
import type { ColumnMapping, ImportJob, ImportRow, PageResult } from '../domain/types.js';
import type { CreateJobInput, CreateJobResult, ListRowsInput } from '../contract.js';
import { toImportJob, toImportRow } from '../infrastructure/mappers.js';
import { importJob, importRow } from '../infrastructure/schema.js';
import { currentTenantContext } from './current-context.js';
import { DEFAULT_IMPORT_TARGET_REGISTRY, IMPORT_TARGET_REGISTRY, type ImportTargetRegistry } from './import-target-registry.js';
import { toDomainError } from './sql-errors.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/**
 * Owns `import_export.import_job`/`import_row` storage: parsing an upload
 * into rows (`createJob`), recording a mapping (`setMapping`), and reading
 * jobs/rows/export data back out. The actual parse -> validate -> write
 * pipeline (`dryRun`/`commit`/`revert`) lives in `PipelineService` - kept
 * separate because that half needs `AUDIT_CONTRACT` and this half does not,
 * same split `@sms/people` uses between `PersonService` (storage) and
 * `MergeService`/`DuplicateService` (a distinct capability layered on top).
 */
@Injectable()
export class JobService {
  // @Optional() with a plain default parameter value, not a provider
  // registered inside this module - see import-export.module.ts's own
  // comment (and @sms/access's AbilityService, the established precedent)
  // for why: nothing here binds IMPORT_TARGET_REGISTRY, so an app that never
  // wires a @Global() override (every test in this file's own spec, most
  // notably) gets the safe "no targets" default instead of a DI resolution
  // error.
  constructor(
    @Optional() @Inject(IMPORT_TARGET_REGISTRY) private readonly registry: ImportTargetRegistry = DEFAULT_IMPORT_TARGET_REGISTRY,
  ) {}

  async createJob(input: CreateJobInput): Promise<Result<CreateJobResult, DomainError>> {
    const target = this.registry.get(input.entityType);
    if (!target) {
      return err(new ValidationError(`No import target is registered for entity type "${input.entityType}".`));
    }

    const { headers, rows } = parseCsv(input.csv);
    if (headers.length === 0) {
      return err(new ValidationError('The uploaded file has no header row.'));
    }

    const ctx = currentTenantContext();
    const jobId = newId();

    try {
      const job = await withTenantTx(ctx, async (tx) => {
        const [jobRow] = await tx
          .insert(importJob)
          .values({
            id: jobId,
            tenantId: ctx.tenantId,
            entityType: input.entityType,
            filename: input.filename,
            status: 'mapping',
            columnMapping: {},
            rowCount: rows.length,
            createdByUserId: ctx.userId ?? null,
          })
          .returning();

        if (rows.length > 0) {
          const rowValues = rows.map((row, index) => {
            const raw = rowToRecord(headers, row);
            return {
              id: newId(),
              tenantId: ctx.tenantId,
              importJobId: jobId,
              rowNumber: index + 1,
              raw,
              rowHash: computeRowHash(raw),
              outcome: 'pending' as const,
            };
          });
          // One round trip for the whole file, not one per row.
          await tx.insert(importRow).values(rowValues);
        }

        return jobRow;
      });

      if (!job) {
        return err(new ConflictError('Could not create the import job.'));
      }

      const suggestedMapping = suggestMapping(headers, target.fields);
      return ok({ job: toImportJob(job), suggestedMapping, headers });
    } catch (error) {
      return err(toDomainError(error, 'Could not create the import job.') as DomainError);
    }
  }

  async setMapping(jobId: string, mapping: ColumnMapping): Promise<Result<ImportJob, DomainError>> {
    const ctx = currentTenantContext();

    const rows = await withTenantTx(ctx, (tx) =>
      tx.update(importJob).set({ columnMapping: mapping }).where(eq(importJob.id, jobId)).returning(),
    );
    const row = rows[0];
    if (!row) {
      return err(new NotFoundError(`Import job ${jobId} not found.`));
    }
    return ok(toImportJob(row));
  }

  async getJob(jobId: string): Promise<Result<ImportJob, NotFoundError>> {
    const ctx = currentTenantContext();
    const rows = await withTenantTx(ctx, (tx) => tx.select().from(importJob).where(eq(importJob.id, jobId)).limit(1));
    const row = rows[0];
    if (!row) {
      return err(new NotFoundError(`Import job ${jobId} not found.`));
    }
    return ok(toImportJob(row));
  }

  async listJobs(): Promise<ImportJob[]> {
    const ctx = currentTenantContext();
    const rows = await withTenantTx(ctx, (tx) =>
      tx.select().from(importJob).orderBy(desc(importJob.createdAt)).limit(DEFAULT_LIST_LIMIT),
    );
    return rows.map(toImportJob);
  }

  async listRows(jobId: string, input: ListRowsInput = {}): Promise<PageResult<ImportRow>> {
    const ctx = currentTenantContext();
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);

    const conditions = [eq(importRow.importJobId, jobId)];
    if (input.outcome) {
      conditions.push(eq(importRow.outcome, input.outcome));
    }
    if (input.cursor) {
      conditions.push(gt(importRow.id, input.cursor));
    }

    const rows = await withTenantTx(ctx, (tx) =>
      tx
        .select()
        .from(importRow)
        .where(and(...conditions))
        .orderBy(asc(importRow.rowNumber))
        .limit(limit + 1),
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1]!.id : null;
    return { items: page.map(toImportRow), nextCursor };
  }

  /** Only works for a target whose optional `list()` capability is implemented - see `ImportTarget`'s own doc comment. */
  async *exportCsv(entityType: string, filter: Record<string, unknown> = {}): AsyncIterable<string> {
    const target = this.registry.get(entityType);
    if (!target?.list) {
      throw new ValidationError(`No exportable import target is registered for entity type "${entityType}".`);
    }

    yield formatCsvRow(target.fields.map((field) => field.label));
    for await (const record of target.list(filter)) {
      yield formatCsvRow(target.fields.map((field) => String(record[field.key] ?? '')));
    }
  }
}
