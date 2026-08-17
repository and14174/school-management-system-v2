import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { PreconditionFailedError, ValidationError, err, ok, type DomainError, type Result } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import { AUDIT_CONTRACT, type AuditContract } from '@sms/audit';
import type { CommitSummary, DryRunRowError, DryRunSummary } from '../contract.js';
import type { ImportJob, RowError } from '../domain/types.js';
import { currentTenantContext } from './current-context.js';
import { DEFAULT_IMPORT_TARGET_REGISTRY, IMPORT_TARGET_REGISTRY, type ImportTargetRegistry, type ImportTx } from './import-target-registry.js';
import { JobService } from './job.service.js';
import { auditBulkOperation, auditRecordHistory, importJob, importRow } from '../infrastructure/schema.js';
import { toDomainError } from './sql-errors.js';

const MAX_PREVIEW_ERRORS = 20;

/** Postgres identifiers this module builds dynamic SQL against for `revert()` are validated against this before being quoted and spliced in - see that method's own comment. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Tables whose rows are withdrawn from view by setting `archived_at` rather
 * than deleted, because their ids are referenced outside this database (URLs,
 * exports, external integrations) and must keep resolving.
 *
 * Listed explicitly rather than probed at runtime: reverting an import is
 * exactly the moment not to be guessing which tables tolerate a DELETE. A table
 * added here must have both `archived_at` and `archived_reason` columns and
 * exclude archived rows from its read paths - see `people.person` (migration
 * 0502) and `PersonService.searchPeople` for the reference implementation.
 */
const ARCHIVABLE_TABLES = new Set(['people.person']);

function quotedTable(schema: string, table: string): string {
  for (const part of [schema, table]) {
    if (!SAFE_IDENTIFIER.test(part)) {
      throw new Error(`Refusing to build dynamic SQL against unexpected identifier "${part}".`);
    }
  }
  return `"${schema}"."${table}"`;
}

interface RowOutcome {
  readonly rowId: string;
  readonly outcome: 'created' | 'updated' | 'error' | 'skipped';
  readonly normalised: Record<string, unknown> | null;
  readonly errors: RowError[];
  readonly targetId: string | null;
}

/**
 * The parse -> dry run -> commit pipeline, and `revert`. The property the
 * whole module exists for lives here: `dryRun` and `commit` both call
 * `ImportTarget.parseRow`/`findExisting` - the SAME functions, on the SAME
 * `import_row.raw` input - so a preview can never predict something the
 * commit then does differently. See `ImportTarget`'s own doc comment
 * (`application/import-target-registry.ts`) for why `commit`'s writes go
 * through the transaction `AuditContract.withBulkOperation` hands its
 * callback, never a fresh one.
 */
@Injectable()
export class PipelineService {
  constructor(
    // Explicit @Inject() throughout, including for plain classes like
    // JobService - tsx/esbuild's decorator metadata emission does not
    // reliably resolve implicit type-based DI in this codebase (see
    // apps/api's HealthController, and @sms/people's PeopleService for the
    // same convention).
    @Inject(AUDIT_CONTRACT) private readonly audit: AuditContract,
    @Inject(JobService) private readonly jobs: JobService,
    // @Optional() + default value, last param - see JobService's constructor
    // comment (and @sms/access's AbilityService, the established precedent).
    @Optional() @Inject(IMPORT_TARGET_REGISTRY) private readonly registry: ImportTargetRegistry = DEFAULT_IMPORT_TARGET_REGISTRY,
  ) {}

  async dryRun(jobId: string): Promise<Result<DryRunSummary, DomainError>> {
    const ctx = currentTenantContext();
    const jobResult = await this.jobs.getJob(jobId);
    if (!jobResult.ok) return jobResult;
    const job = jobResult.value;

    if (job.status === 'completed' || job.status === 'committing' || job.status === 'reverted') {
      return err(new PreconditionFailedError(`Import job ${jobId} is "${job.status}" and cannot be re-validated.`));
    }
    if (Object.keys(job.columnMapping).length === 0) {
      return err(new ValidationError('Set a column mapping before running a dry run.'));
    }

    const target = this.registry.get(job.entityType);
    if (!target) {
      return err(new ValidationError(`No import target is registered for entity type "${job.entityType}".`));
    }

    await withTenantTx(ctx, (tx) => tx.update(importJob).set({ status: 'validating' }).where(eq(importJob.id, jobId)));

    const rows = await withTenantTx(ctx, (tx) =>
      tx.select().from(importRow).where(eq(importRow.importJobId, jobId)).orderBy(asc(importRow.rowNumber)),
    );

    let validCount = 0;
    let errorCount = 0;
    let predictedCreateCount = 0;
    let predictedUpdateCount = 0;
    const firstErrors: DryRunRowError[] = [];
    const updates: Array<{ id: string; outcome: 'valid' | 'error'; normalised: Record<string, unknown> | null; errors: RowError[] }> = [];

    for (const row of rows) {
      const parsed = await target.parseRow(row.raw, job.columnMapping);

      if (!parsed.ok) {
        errorCount += 1;
        if (firstErrors.length < MAX_PREVIEW_ERRORS) {
          firstErrors.push({ rowNumber: row.rowNumber, errors: parsed.error });
        }
        updates.push({ id: row.id, outcome: 'error', normalised: null, errors: parsed.error });
        continue;
      }

      validCount += 1;
      // No `tx`: a read, made outside any bulk operation (dry run writes
      // nothing to the target table) - see `ImportTarget.findExisting`'s doc
      // comment.
      const existing = await target.findExisting(parsed.value);
      if (existing) {
        predictedUpdateCount += 1;
      } else {
        predictedCreateCount += 1;
      }
      updates.push({ id: row.id, outcome: 'valid', normalised: parsed.value as Record<string, unknown>, errors: [] });
    }

    await withTenantTx(ctx, async (tx) => {
      for (const update of updates) {
        await tx
          .update(importRow)
          .set({ outcome: update.outcome, normalised: update.normalised, errors: update.errors })
          .where(eq(importRow.id, update.id));
      }
      await tx.update(importJob).set({ status: 'previewed', validCount, errorCount }).where(eq(importJob.id, jobId));
    });

    const finalJob = await this.jobs.getJob(jobId);
    if (!finalJob.ok) return finalJob;

    return ok({
      job: finalJob.value,
      rowCount: rows.length,
      validCount,
      errorCount,
      predictedCreateCount,
      predictedUpdateCount,
      firstErrors,
    });
  }

  async commit(jobId: string): Promise<Result<CommitSummary, DomainError>> {
    const ctx = currentTenantContext();
    const jobResult = await this.jobs.getJob(jobId);
    if (!jobResult.ok) return jobResult;
    const job = jobResult.value;

    if (job.status !== 'previewed') {
      return err(
        new PreconditionFailedError(
          `Import job ${jobId} must be dry-run (status "previewed") before it can be committed; current status is "${job.status}".`,
        ),
      );
    }

    const target = this.registry.get(job.entityType);
    if (!target) {
      return err(new ValidationError(`No import target is registered for entity type "${job.entityType}".`));
    }

    await withTenantTx(ctx, (tx) => tx.update(importJob).set({ status: 'committing' }).where(eq(importJob.id, jobId)));

    const rows = await withTenantTx(ctx, (tx) =>
      tx.select().from(importRow).where(eq(importRow.importJobId, jobId)).orderBy(asc(importRow.rowNumber)),
    );

    try {
      const { bulkOperationId, outcomes } = await this.audit.withBulkOperation(
        { kind: 'import_export.commit', summary: { jobId, entityType: job.entityType, filename: job.filename } },
        async (tx) => {
          // The GUC AuditContract.withBulkOperation set via SET LOCAL on
          // THIS transaction - the same one every target.create()/update()
          // call below writes through, which is exactly why the history
          // trigger stamps every one of those rows with it. Read back rather
          // than trusting a closed-over id from beginBulkOperation, since
          // this pipeline never calls that directly (withBulkOperation owns
          // the whole begin/commit/fail lifecycle) - same technique
          // `@sms/audit`'s own audit.spec.ts uses to observe it.
          const gucRows = (await tx.execute(
            sql`select current_setting('app.bulk_operation_id', true) as id`,
          )) as unknown as Array<{ id: string }>;
          const bulkOperationId = gucRows[0]!.id;

          const collected: RowOutcome[] = [];
          for (const row of rows) {
            const parsed = await target.parseRow(row.raw, job.columnMapping);
            if (!parsed.ok) {
              collected.push({ rowId: row.id, outcome: 'error', normalised: null, errors: parsed.error, targetId: null });
              continue;
            }

            const existing = await target.findExisting(parsed.value, tx as ImportTx);
            if (existing) {
              await target.update(existing.id, parsed.value, tx as ImportTx);
              collected.push({
                rowId: row.id,
                outcome: 'updated',
                normalised: parsed.value as Record<string, unknown>,
                errors: [],
                targetId: existing.id,
              });
            } else {
              const created = await target.create(parsed.value, tx as ImportTx);
              collected.push({
                rowId: row.id,
                outcome: 'created',
                normalised: parsed.value as Record<string, unknown>,
                errors: [],
                targetId: created.id,
              });
            }
          }

          return { bulkOperationId, outcomes: collected };
        },
      );

      let createdCount = 0;
      let updatedCount = 0;
      let errorCount = 0;
      const skippedCount = 0;
      for (const outcome of outcomes) {
        if (outcome.outcome === 'created') createdCount += 1;
        else if (outcome.outcome === 'updated') updatedCount += 1;
        else if (outcome.outcome === 'error') errorCount += 1;
      }

      // Bookkeeping writes deliberately happen in a SEPARATE, un-tagged
      // transaction - if they ran inside the bulk operation's own tx above,
      // import_export.import_row/import_job would themselves be stamped
      // with bulk_operation_id and revert() would try to "restore" this
      // module's own audit trail, not just the data the import wrote.
      await withTenantTx(ctx, async (tx) => {
        for (const outcome of outcomes) {
          await tx
            .update(importRow)
            .set({ outcome: outcome.outcome, normalised: outcome.normalised, errors: outcome.errors, targetId: outcome.targetId })
            .where(eq(importRow.id, outcome.rowId));
        }
        await tx
          .update(importJob)
          .set({
            status: 'completed',
            bulkOperationId,
            createdCount,
            updatedCount,
            errorCount,
            skippedCount,
            completedAt: new Date(),
          })
          .where(eq(importJob.id, jobId));
      });

      const finalJob = await this.jobs.getJob(jobId);
      if (!finalJob.ok) return finalJob;

      return ok({ job: finalJob.value, createdCount, updatedCount, errorCount, skippedCount });
    } catch (error) {
      await withTenantTx(ctx, (tx) => tx.update(importJob).set({ status: 'failed' }).where(eq(importJob.id, jobId))).catch(() => {
        // Best-effort: the original error below is what matters to the caller.
      });
      return err(toDomainError(error, `Could not commit import job ${jobId}.`) as DomainError);
    }
  }

  /**
   * Reverses every row `commit`'s bulk operation wrote, restoring the prior
   * state, and marks the job `'reverted'`.
   *
   * Deliberately does NOT go through `ImportTarget` (which has no
   * delete/restore method - see that interface's own comment) - instead it
   * reads `audit.record_history` directly by `bulk_operation_id` (a query
   * `AuditContract` does not expose) and replays each row generically:
   * `delete` an `insert`, restore an `update`'s `before` image. This works
   * for ANY target's table without this module knowing its columns, which is
   * the whole point of `audit.bulk_operation` existing - see the migration's
   * own header.
   *
   * Table/schema identifiers from `audit.record_history` are validated
   * against `SAFE_IDENTIFIER` before being quoted and spliced into SQL as a
   * defence-in-depth measure - they are written by our own trigger, not
   * client input, but reverting into raw dynamic SQL warrants the extra
   * check anyway.
   *
   * Atomic: every row's reversal runs inside ONE transaction, so a bulk
   * operation is either fully undone or not undone at all - never left half
   * reverted. (A per-row `SAVEPOINT`, tried first, does not actually buy
   * partial-failure resilience here: `postgres.js`'s `sql.begin()` tracks
   * *any* query rejection on the transaction via its own internal
   * `uncaughtError`, independent of whichever savepoint recovered it
   * application-side, and re-throws it once the callback returns - see that
   * package's `src/index.js` `scope()`. So a target whose table denies a
   * write this needs (see below) fails the WHOLE revert, atomically, which
   * is the correct behaviour given that constraint - not a design compromise
   * to route around.)
   *
   * This surfaces a real limitation for `people.person`, this module's own
   * first concrete target: it grants `sms_app` only `select, insert,
   * update` - deliberately never `delete` (the same "tombstone, never
   * remove a person" design `people.person.merged_into_id` exists for, see
   * `0500_people.sql`'s own header). Undoing an UPDATE (restoring the
   * `before` image) works; undoing a CREATE does not, and this method fails
   * with a clear `PreconditionFailedError` rather than a raw 500 when it
   * hits that - see the module report for the full writeup and options
   * (grant `delete`, or give `people.person` a real tombstone flag `import
   * -export` could set instead of deleting).
   */
  async revert(jobId: string): Promise<Result<ImportJob, DomainError>> {
    const ctx = currentTenantContext();
    const jobResult = await this.jobs.getJob(jobId);
    if (!jobResult.ok) return jobResult;
    const job = jobResult.value;

    if (job.status !== 'completed') {
      return err(new PreconditionFailedError(`Import job ${jobId} must be "completed" to revert; current status is "${job.status}".`));
    }
    if (!job.bulkOperationId) {
      return err(new PreconditionFailedError(`Import job ${jobId} has no bulk operation to revert.`));
    }

    const bulkOperationId = job.bulkOperationId;

    const historyRows = await withTenantTx(ctx, (tx) =>
      tx
        .select({
          tableSchema: auditRecordHistory.tableSchema,
          tableName: auditRecordHistory.tableName,
          recordId: auditRecordHistory.recordId,
          operation: auditRecordHistory.operation,
          before: auditRecordHistory.before,
        })
        .from(auditRecordHistory)
        .where(eq(auditRecordHistory.bulkOperationId, bulkOperationId))
        .orderBy(asc(auditRecordHistory.occurredAt)),
    );

    try {
      await withTenantTx(ctx, async (tx) => {
        for (const entry of historyRows) {
          const table = quotedTable(entry.tableSchema, entry.tableName);

          if (entry.operation === 'insert') {
            // Undo a CREATE by archiving where the table supports it, and only
            // deleting where it does not.
            //
            // Some tables deliberately refuse DELETE - `people.person` grants
            // sms_app none, because a person id lives on in URLs, exports and
            // external integrations (see its 0500 migration header). Deleting
            // was therefore impossible, which made a reverted import of people
            // fail outright: the school was told the import could not be undone.
            //
            // Archiving satisfies both requirements - the row survives so its id
            // still resolves, but every read path excludes it, which is what
            // "undo my import" actually means to the person asking.
            if (ARCHIVABLE_TABLES.has(`${entry.tableSchema}.${entry.tableName}`)) {
              await tx.execute(
                sql`update ${sql.raw(table)}
                    set archived_at = now(),
                        archived_reason = ${`Reverted import job ${jobId}`}
                    where id = ${entry.recordId}`,
              );
            } else {
              await tx.execute(sql`delete from ${sql.raw(table)} where id = ${entry.recordId}`);
            }
            continue;
          }

          if (entry.operation === 'update' && entry.before) {
            const columns = Object.keys(entry.before);
            if (columns.length === 0) continue;
            for (const column of columns) {
              if (!SAFE_IDENTIFIER.test(column)) {
                throw new Error(`Refusing to build dynamic SQL against unexpected column "${column}".`);
              }
            }
            const colList = columns.map((c) => `"${c}"`).join(', ');
            await tx.execute(
              sql`update ${sql.raw(table)} as t set (${sql.raw(colList)}) = (
                select ${sql.raw(colList)} from jsonb_populate_record(null::${sql.raw(table)}, ${JSON.stringify(entry.before)}::jsonb)
              ) where t.id = ${entry.recordId}`,
            );
          }
          // 'delete' operations never occur inside an import commit (a
          // target's create()/update() only insert/update) - nothing to
          // replay for one if it somehow did.
        }

        await tx.update(importJob).set({ status: 'reverted' }).where(eq(importJob.id, jobId));
        await tx
          .update(auditBulkOperation)
          .set({ status: 'reverted' })
          .where(and(eq(auditBulkOperation.id, bulkOperationId), eq(auditBulkOperation.tenantId, ctx.tenantId)));
      });
    } catch (error) {
      if (isInsufficientPrivilege(error)) {
        return err(
          new PreconditionFailedError(
            `Import job ${jobId} cannot be fully reverted: the database role does not have permission to undo every write this bulk operation made (a target table that denies the required grant - e.g. people.person deliberately has no DELETE grant, so a created person cannot be un-created). No changes were made; the import remains "completed".`,
          ),
        );
      }
      return err(toDomainError(error, `Could not revert import job ${jobId}.`) as DomainError);
    }

    return this.jobs.getJob(jobId);
  }
}

const INSUFFICIENT_PRIVILEGE = '42501';

function isInsufficientPrivilege(error: unknown): boolean {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  return typeof cause === 'object' && cause !== null && 'code' in cause && (cause as { code?: unknown }).code === INSUFFICIENT_PRIVILEGE;
}
