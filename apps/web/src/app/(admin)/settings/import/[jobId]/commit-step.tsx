'use client';

import * as React from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, CircleCheck, Loader2, RotateCcw, TriangleAlert, Undo2 } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  StatTile,
} from '@sms/ui';
import { commitImportJob, revertImportJob, type ImportJob } from '../../../../../lib/api';

export interface CommitStepProps {
  job: ImportJob;
  onBackToPreview: () => void;
}

export function CommitStep({ job, onBackToPreview }: CommitStepProps) {
  const queryClient = useQueryClient();
  const [revertDialogOpen, setRevertDialogOpen] = React.useState(false);

  const commitMutation = useMutation({
    mutationFn: () => commitImportJob(job.id),
    onSuccess: (summary) => {
      toast.success('Import committed', {
        description: `${summary.createdCount} created, ${summary.updatedCount} updated.`,
      });
      void queryClient.invalidateQueries({ queryKey: ['import', 'job', job.id] });
      void queryClient.invalidateQueries({ queryKey: ['import', 'jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['people'] });
    },
    onError: (error: Error) => {
      toast.error('Could not commit this import', { description: error.message });
    },
  });

  const revertMutation = useMutation({
    mutationFn: () => revertImportJob(job.id),
    onSuccess: () => {
      toast.success('Import undone', { description: 'Every row this import created was archived; every row it updated was restored.' });
      setRevertDialogOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['import', 'job', job.id] });
      void queryClient.invalidateQueries({ queryKey: ['import', 'jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['people'] });
    },
    onError: (error: Error) => {
      toast.error('Could not undo this import', { description: error.message });
    },
  });

  if (job.status === 'previewed') {
    return (
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <StatTile label="Valid rows to write" value={job.validCount} />
          <StatTile label="Rows that will be skipped" value={job.errorCount} />
          <StatTile label="Total rows" value={job.rowCount} />
        </div>
        <Alert variant="info">
          <AlertTitle>Ready to commit</AlertTitle>
          <AlertDescription>
            Committing writes every valid row to Greenwood - each is matched against existing people and either
            creates a new record or updates a matching one. This can be undone afterwards as a single unit.
          </AlertDescription>
        </Alert>
        <div className="flex items-center justify-between gap-2 border-t border-border pt-5">
          <Button variant="outline" onClick={onBackToPreview} disabled={commitMutation.isPending}>
            <ArrowLeft className="size-4" />
            Back to preview
          </Button>
          <Button onClick={() => commitMutation.mutate()} loading={commitMutation.isPending}>
            Commit import
          </Button>
        </div>
      </div>
    );
  }

  // Checked before the "committing" loading branch below on purpose: once
  // the job query has refetched and confirmed a terminal status, that must
  // win over a local mutation's own `isPending` flag - see PreviewStep's
  // `isRunning` for why a mutation's pending flag can still read `true` on a
  // render taken after the very query it invalidated has already confirmed
  // the job moved on. Without this ordering, a fast commit could get stuck
  // showing "Writing rows…" forever despite the job already being done.
  if (job.status === 'completed' || job.status === 'reverted') {
    return (
      <CommitResult
        job={job}
        revertDialogOpen={revertDialogOpen}
        onRevertDialogOpenChange={setRevertDialogOpen}
        revertMutation={revertMutation}
      />
    );
  }

  if (job.status === 'committing' || commitMutation.isPending) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-border px-6 py-12 text-center">
        <Loader2 className="size-6 animate-spin text-fg-subtle motion-reduce:animate-none" />
        <p className="text-sm text-fg-muted">Writing rows to Greenwood…</p>
      </div>
    );
  }

  if (job.status === 'failed') {
    return (
      <div className="flex flex-col gap-6">
        <Alert variant="danger" icon={<TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" />}>
          <AlertTitle>This import failed while committing</AlertTitle>
          <AlertDescription>
            Some rows may have been written before the failure. Contact an administrator with this job&apos;s id (
            {job.id}) before re-running - re-importing the same file without checking first could create duplicates.
          </AlertDescription>
        </Alert>
        <div className="border-t border-border pt-5">
          <Button variant="outline" onClick={onBackToPreview}>
            <ArrowLeft className="size-4" />
            Back to preview
          </Button>
        </div>
      </div>
    );
  }

  return null;
}

interface CommitResultProps {
  job: ImportJob;
  revertDialogOpen: boolean;
  onRevertDialogOpenChange: (open: boolean) => void;
  revertMutation: ReturnType<typeof useMutation<ImportJob, Error, void>>;
}

function CommitResult({ job, revertDialogOpen, onRevertDialogOpenChange, revertMutation }: CommitResultProps) {
  return (
    <div className="flex flex-col gap-6">
      {job.status === 'reverted' ? (
        <Alert variant="warning">
          <AlertTitle>This import was undone</AlertTitle>
          <AlertDescription>
            Every person this import created was archived and every person it updated was restored to its prior
            state. The counts below are what the original commit did.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="success">
          <AlertTitle>Import committed</AlertTitle>
          <AlertDescription>{job.filename} finished writing to Greenwood.</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile label="Created" value={job.createdCount} icon={<CircleCheck className="size-4 text-success" />} />
        <StatTile label="Updated" value={job.updatedCount} />
        <StatTile label="Skipped / errored" value={job.errorCount + job.skippedCount} />
        <StatTile label="Total rows" value={job.rowCount} />
      </div>

      {job.status === 'completed' ? (
        <div className="flex flex-col gap-3 rounded-card border border-danger/30 bg-danger-soft p-4">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-fg">Made a mistake?</p>
            <p className="text-sm text-fg-muted">
              Undo archives every person this import created and restores every person it updated - it does not
              permanently delete anyone.
            </p>
          </div>
          <Button variant="danger" className="self-start" onClick={() => onRevertDialogOpenChange(true)}>
            <Undo2 className="size-4" />
            Undo this import
          </Button>
        </div>
      ) : null}

      <div className="border-t border-border pt-5">
        <Button variant="outline" asChild>
          <Link href={'/settings/import' as Route}>Back to import history</Link>
        </Button>
      </div>

      <Dialog
        open={revertDialogOpen}
        onOpenChange={(open) => (!revertMutation.isPending ? onRevertDialogOpenChange(open) : undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Undo this import?</DialogTitle>
            <DialogDescription>
              This does <strong className="text-fg">not</strong> permanently delete the {job.createdCount}{' '}
              {job.createdCount === 1 ? 'person' : 'people'} this import created. Instead, they are{' '}
              <strong className="text-fg">archived</strong>: they disappear from every list and search, but keep
              their ids, so any existing links or exports that reference them still resolve. The {job.updatedCount}{' '}
              {job.updatedCount === 1 ? 'person' : 'people'} this import updated will be restored to their values
              from before the import.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => onRevertDialogOpenChange(false)} disabled={revertMutation.isPending}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => revertMutation.mutate()} loading={revertMutation.isPending}>
              <RotateCcw className="size-4" />
              Undo import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
