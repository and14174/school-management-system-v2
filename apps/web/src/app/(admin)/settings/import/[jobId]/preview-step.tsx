'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, CircleAlert, CircleCheck, Loader2, RefreshCw } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  StatTile,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@sms/ui';
import { dryRunImportJob, fetchImportRows, type DryRunSummary, type ImportJob } from '../../../../../lib/api';

const ERROR_ROW_LIMIT = 20;

export interface PreviewStepProps {
  job: ImportJob;
  onBackToMapping: () => void;
  onPreviewed: () => void;
}

/** Was a dry run ever completed for this job (as opposed to still sitting at "mapping", never previewed)? */
function hasBeenPreviewed(status: ImportJob['status']): boolean {
  return status === 'previewed' || status === 'committing' || status === 'completed' || status === 'reverted';
}

export function PreviewStep({ job, onBackToMapping, onPreviewed }: PreviewStepProps) {
  const queryClient = useQueryClient();
  const [lastRun, setLastRun] = React.useState<DryRunSummary | null>(null);
  const autoRunTriggered = React.useRef(false);

  const dryRunMutation = useMutation({
    mutationFn: () => dryRunImportJob(job.id),
    onSuccess: (summary) => {
      setLastRun(summary);
      void queryClient.invalidateQueries({ queryKey: ['import', 'job', job.id] });
      void queryClient.invalidateQueries({ queryKey: ['import', 'job', job.id, 'rows', 'error'] });
    },
    onError: (error: Error) => {
      toast.error('Could not run the dry run', { description: error.message });
    },
  });

  // Arriving here right after mapping (status still "mapping") means a dry
  // run has never run for this job - kick it off automatically rather than
  // making the user press an extra button for what is otherwise the very
  // next step in the wizard. A resumed job that's already "previewed" never
  // re-triggers this.
  React.useEffect(() => {
    if (!autoRunTriggered.current && job.status === 'mapping') {
      autoRunTriggered.current = true;
      dryRunMutation.mutate();
    }
    // dryRunMutation is a fresh object each render (useMutation's identity)
    // and the ref guard above already makes this a run-once effect, so it's
    // deliberately the only listed dependency.
  }, [job.status]);

  // The per-row error detail (row number + problem) is read back from
  // GET .../rows?outcome=error, NOT kept only in dryRunMutation's in-memory
  // response - a refresh mid-preview must show the same error table again,
  // and the mutation result does not survive a reload but this query does
  // (job.status stays "previewed" server-side).
  const errorRowsQuery = useQuery({
    queryKey: ['import', 'job', job.id, 'rows', 'error'],
    queryFn: ({ signal }) => fetchImportRows(job.id, { outcome: 'error', limit: ERROR_ROW_LIMIT }, signal),
    enabled: hasBeenPreviewed(job.status),
  });

  const previewed = hasBeenPreviewed(job.status);
  // `job.status` (server-confirmed, via the job query) is the source of
  // truth once it moves past "mapping"/"validating" - `dryRunMutation
  // .isPending` is trusted only up to that point. Trusting the mutation's
  // own pending flag unconditionally is NOT reliable here: it can still read
  // `true` on a render taken after the job query has already refetched and
  // confirmed "previewed" (both come from TanStack Query, but the mutation
  // observer's pending flag has been observed lagging one render behind the
  // query cache update it itself triggered via invalidateQueries - a fast
  // dry run on a small file can retire before the mutation's own listeners
  // have flushed). Gating on `!previewed` first means the loading state
  // always yields to a server-confirmed result rather than getting stuck.
  const isRunning = !previewed && (dryRunMutation.isPending || job.status === 'validating');

  const validCount = lastRun?.validCount ?? job.validCount;
  const errorCount = lastRun?.errorCount ?? job.errorCount;
  const errorRows = errorRowsQuery.data?.items ?? [];
  const shownErrorCount = errorRows.length;

  return (
    <div className="flex flex-col gap-6">
      {isRunning ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-border px-6 py-12 text-center">
          <Loader2 className="size-6 animate-spin text-fg-subtle motion-reduce:animate-none" />
          <p className="text-sm text-fg-muted">Validating every row against your column mapping…</p>
        </div>
      ) : previewed ? (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatTile
              label="Valid rows"
              value={validCount}
              icon={<CircleCheck className="size-4 text-success" />}
            />
            <StatTile
              label="Rows with errors"
              value={errorCount}
              icon={<CircleAlert className="size-4 text-danger" />}
            />
            <StatTile label="Will be created" value={lastRun?.predictedCreateCount ?? '—'} />
            <StatTile label="Will be updated" value={lastRun?.predictedUpdateCount ?? '—'} />
          </div>

          {errorCount === 0 ? (
            <Alert variant="success">
              <AlertTitle>Every row is valid</AlertTitle>
              <AlertDescription>All {validCount} rows are ready to commit.</AlertDescription>
            </Alert>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-fg">
                  {errorCount} {errorCount === 1 ? 'row needs' : 'rows need'} attention
                </h3>
                {errorCount > shownErrorCount ? (
                  <span className="text-xs text-fg-subtle">
                    Showing the first {shownErrorCount} of {errorCount}
                  </span>
                ) : null}
              </div>
              {errorRowsQuery.isPending ? (
                <p className="text-sm text-fg-subtle">Loading error detail…</p>
              ) : errorRowsQuery.isError ? (
                <Alert variant="danger">
                  <AlertTitle>Could not load error detail</AlertTitle>
                  <AlertDescription>{errorRowsQuery.error.message}</AlertDescription>
                </Alert>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-24">Row</TableHead>
                      <TableHead>Problem</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {errorRows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell data-tabular className="font-medium text-fg">
                          {row.rowNumber}
                        </TableCell>
                        <TableCell className="text-fg-muted">
                          {row.errors.map((error, index) => (
                            <p key={index}>
                              {error.field ? <span className="font-medium text-fg">{error.field}: </span> : null}
                              {error.message}
                            </p>
                          ))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <p className="text-xs text-fg-subtle">
                Erroring rows are skipped, not blocking - you can go back and fix the mapping and re-run, or continue
                and only the valid rows will be committed.
              </p>
            </div>
          )}
        </>
      ) : (
        <Alert variant="danger">
          <AlertTitle>Could not start the dry run</AlertTitle>
          <AlertDescription>{dryRunMutation.error?.message ?? 'Try again.'}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-border pt-5">
        <Button variant="outline" onClick={onBackToMapping} disabled={isRunning}>
          <ArrowLeft className="size-4" />
          Back to mapping
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => dryRunMutation.mutate()} loading={isRunning}>
            <RefreshCw className="size-4" />
            Re-run dry run
          </Button>
          <Button onClick={onPreviewed} disabled={!previewed || isRunning}>
            Continue to commit
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
