import { Inject, Injectable, Optional } from '@nestjs/common';
import type { DomainError, NotFoundError, Result } from '@sms/kernel';
import type {
  ColumnMapping,
  CommitSummary,
  CreateJobInput,
  CreateJobResult,
  DryRunSummary,
  ImportExportContract,
  ImportJob,
  ImportRow,
  ImportTargetSummary,
  ListRowsInput,
  PageResult,
} from '../contract.js';
import { DEFAULT_IMPORT_TARGET_REGISTRY, IMPORT_TARGET_REGISTRY, type ImportTargetRegistry } from './import-target-registry.js';
import { JobService } from './job.service.js';
import { PipelineService } from './pipeline.service.js';

/**
 * The `ImportExportContract` facade `apps/api`'s `ImportExportController`
 * calls through - composes `JobService` (storage) and `PipelineService`
 * (parse -> dry run -> commit -> revert), same split/composition
 * `@sms/people`'s `PeopleService` uses over `PersonService`/`MergeService`/....
 */
@Injectable()
export class ImportExportService implements ImportExportContract {
  constructor(
    // Explicit @Inject() throughout, including for plain classes - see
    // PipelineService's own constructor comment.
    @Inject(JobService) private readonly jobs: JobService,
    @Inject(PipelineService) private readonly pipeline: PipelineService,
    // @Optional() + default value, last param - see JobService's constructor comment.
    @Optional() @Inject(IMPORT_TARGET_REGISTRY) private readonly registry: ImportTargetRegistry = DEFAULT_IMPORT_TARGET_REGISTRY,
  ) {}

  async listTargets(): Promise<ImportTargetSummary[]> {
    return this.registry.list().map((target) => ({ entityType: target.entityType, fields: target.fields }));
  }

  createJob(input: CreateJobInput): Promise<Result<CreateJobResult, DomainError>> {
    return this.jobs.createJob(input);
  }

  setMapping(jobId: string, mapping: ColumnMapping): Promise<Result<ImportJob, DomainError>> {
    return this.jobs.setMapping(jobId, mapping);
  }

  dryRun(jobId: string): Promise<Result<DryRunSummary, DomainError>> {
    return this.pipeline.dryRun(jobId);
  }

  commit(jobId: string): Promise<Result<CommitSummary, DomainError>> {
    return this.pipeline.commit(jobId);
  }

  revert(jobId: string): Promise<Result<ImportJob, DomainError>> {
    return this.pipeline.revert(jobId);
  }

  getJob(jobId: string): Promise<Result<ImportJob, NotFoundError>> {
    return this.jobs.getJob(jobId);
  }

  listJobs(): Promise<ImportJob[]> {
    return this.jobs.listJobs();
  }

  listRows(jobId: string, input?: ListRowsInput): Promise<PageResult<ImportRow>> {
    return this.jobs.listRows(jobId, input);
  }

  exportCsv(entityType: string, filter?: Record<string, unknown>): AsyncIterable<string> {
    return this.jobs.exportCsv(entityType, filter);
  }
}
