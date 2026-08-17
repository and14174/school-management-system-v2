'use client';

import * as React from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import type { Route } from 'next';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ShieldOff, WifiOff } from 'lucide-react';
import { Button, EmptyState, PageHeader, Skeleton } from '@sms/ui';
import { fetchImportJob, type ImportJob, type ImportJobStatus } from '../../../../../lib/api';
import { ForbiddenError } from '../../../../../lib/http';
import { usePermissions } from '../../../../../lib/permissions';
import { StepIndicator, type ImportWizardStep } from '../step-indicator';
import { MappingStep } from './mapping-step';
import { PreviewStep } from './preview-step';
import { CommitStep } from './commit-step';

/** Where a job resumes when its URL carries no `?step=` (a fresh open, or a shared link with none set). */
function defaultStepForStatus(status: ImportJobStatus): ImportWizardStep {
  switch (status) {
    case 'mapping':
      return 'map';
    case 'validating':
    case 'previewed':
      return 'preview';
    case 'committing':
    case 'completed':
    case 'failed':
    case 'reverted':
      return 'commit';
    default:
      return 'map';
  }
}

/** Whether `step` is safe to render for a job's current state - guards a stale/tampered `?step=` (e.g. jumping to "commit" before any dry run ran). */
function isStepReachable(step: ImportWizardStep, job: ImportJob): boolean {
  if (step === 'map') return true;
  if (step === 'preview') return Object.keys(job.columnMapping).length > 0 || job.status !== 'mapping';
  if (step === 'commit') {
    return (
      job.status === 'previewed' ||
      job.status === 'committing' ||
      job.status === 'completed' ||
      job.status === 'failed' ||
      job.status === 'reverted'
    );
  }
  return false;
}

// Re-fetches while the job is mid-transition (a dry run or commit in
// flight) so a step relying on the freshest status - in particular another
// browser tab/user watching the same resumable job - doesn't sit on a stale
// "validating"/"committing" forever.
const TRANSIENT_STATUSES = new Set<ImportJobStatus>(['validating', 'committing']);

export default function ImportJobWizardPage() {
  const params = useParams<{ jobId: string }>();
  const jobId = params.jobId;
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can, isLoading: permissionsLoading, isError: permissionsError } = usePermissions();

  const jobQuery = useQuery({
    queryKey: ['import', 'job', jobId],
    queryFn: ({ signal }) => fetchImportJob(jobId, signal),
    enabled: Boolean(jobId) && can('people.person:read'),
    refetchInterval: (query) => (query.state.data && TRANSIENT_STATUSES.has(query.state.data.status) ? 1000 : false),
  });

  function goToStep(step: ImportWizardStep) {
    router.replace(`/settings/import/${jobId}?step=${step}` as Route, { scroll: false });
  }

  if (!permissionsLoading && !permissionsError && !can('people.person:read')) {
    return (
      <EmptyState
        icon={<ShieldOff className="size-5" />}
        title="You don't have permission to view this"
        description="Viewing an import job requires the people.person:read permission."
        className="min-h-[24rem] justify-center"
      />
    );
  }

  if (jobQuery.isPending) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (jobQuery.isError) {
    if (jobQuery.error instanceof ForbiddenError) {
      return (
        <EmptyState
          icon={<ShieldOff className="size-5" />}
          title="You don't have permission to view this"
          description="Viewing an import job requires the people.person:read permission."
          className="min-h-[24rem] justify-center"
        />
      );
    }
    return (
      <EmptyState
        icon={<WifiOff className="size-5" />}
        title="Couldn't load this import job"
        description={jobQuery.error.message}
        action={<Button onClick={() => void jobQuery.refetch()}>Retry</Button>}
        className="min-h-[24rem] justify-center"
      />
    );
  }

  const job = jobQuery.data;
  const requestedStep = searchParams.get('step') as ImportWizardStep | null;
  const step: ImportWizardStep =
    requestedStep && isStepReachable(requestedStep, job) ? requestedStep : defaultStepForStatus(job.status);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => router.push('/settings/import' as Route)}>
          <ArrowLeft className="size-3.5" />
          Back to import history
        </Button>
      </div>

      <PageHeader
        eyebrow={`Settings · Import · ${job.entityType}`}
        title={job.filename}
        description={`${job.rowCount} rows parsed.`}
        actions={<StepIndicator current={step} />}
      />

      {step === 'map' ? (
        <MappingStep job={job} onMapped={() => goToStep('preview')} />
      ) : step === 'preview' ? (
        <PreviewStep
          job={job}
          onBackToMapping={() => goToStep('map')}
          onPreviewed={() => goToStep('commit')}
        />
      ) : (
        <CommitStep job={job} onBackToPreview={() => goToStep('preview')} />
      )}
    </div>
  );
}
