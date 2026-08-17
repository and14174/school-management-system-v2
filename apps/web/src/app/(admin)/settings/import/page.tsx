'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useQuery } from '@tanstack/react-query';
import { FileUp, RefreshCw, ShieldOff, Upload, WifiOff } from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@sms/ui';
import { fetchImportJobs } from '../../../../lib/api';
import { ForbiddenError } from '../../../../lib/http';
import { usePermissions } from '../../../../lib/permissions';
import { useSession } from '../../../../components/providers/session-provider';
import { formatActorLabel, formatTimestamp, IMPORT_JOB_STATUS_BADGE_VARIANT, IMPORT_JOB_STATUS_LABELS } from './format';

export default function ImportHistoryPage() {
  const { can, isLoading: permissionsLoading, isError: permissionsError } = usePermissions();
  const { user } = useSession();

  const jobsQuery = useQuery({
    queryKey: ['import', 'jobs'],
    queryFn: ({ signal }) => fetchImportJobs(signal),
    enabled: can('people.person:read'),
  });

  const canImport = can('people.person:write');

  if (!permissionsLoading && !permissionsError && !can('people.person:read')) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Settings" title="Import" description="Bring people into Greenwood from a CSV file." />
        <EmptyState
          icon={<ShieldOff className="size-5" />}
          title="You don't have permission to view this"
          description="Viewing import history requires the people.person:read permission. Ask an administrator if you believe this is a mistake."
          className="min-h-[24rem] justify-center"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Settings"
        title="Import"
        description="Bring people into Greenwood from a CSV file, mapped column by column and previewed before anything is written."
        actions={
          canImport ? (
            <Button asChild>
              <Link href={'/settings/import/new' as Route}>
                <Upload className="size-4" />
                New import
              </Link>
            </Button>
          ) : undefined
        }
      />

      {jobsQuery.isPending ? (
        <ImportHistorySkeleton />
      ) : jobsQuery.isError ? (
        <ImportHistoryError error={jobsQuery.error} onRetry={() => void jobsQuery.refetch()} />
      ) : jobsQuery.data.length === 0 ? (
        <EmptyState
          icon={<FileUp className="size-5" />}
          title="No imports yet"
          description="Run your first CSV import to bring people into Greenwood in bulk."
          action={
            canImport ? (
              <Button asChild>
                <Link href={'/settings/import/new' as Route}>
                  <Upload className="size-4" />
                  New import
                </Link>
              </Button>
            ) : undefined
          }
          className="min-h-[24rem] justify-center"
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead>Entity type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Rows</TableHead>
              <TableHead>Created / updated / errors</TableHead>
              <TableHead>Run by</TableHead>
              <TableHead>Started</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobsQuery.data.map((job) => (
              <TableRow key={job.id} className="cursor-pointer">
                <TableCell>
                  <Link href={`/settings/import/${job.id}` as Route} className="font-medium text-fg hover:underline">
                    {job.filename}
                  </Link>
                </TableCell>
                <TableCell className="text-fg-muted">{job.entityType}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Badge variant={IMPORT_JOB_STATUS_BADGE_VARIANT[job.status]}>
                      {IMPORT_JOB_STATUS_LABELS[job.status]}
                    </Badge>
                    {job.status === 'reverted' ? (
                      <span className="text-xs text-fg-subtle">(undone)</span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell data-tabular className="text-fg-muted">
                  {job.rowCount}
                </TableCell>
                <TableCell data-tabular className="text-fg-muted">
                  {job.status === 'completed' || job.status === 'reverted'
                    ? `${job.createdCount} / ${job.updatedCount} / ${job.errorCount}`
                    : '—'}
                </TableCell>
                <TableCell className="text-fg-muted">{formatActorLabel(job.createdByUserId, user)}</TableCell>
                <TableCell data-tabular className="text-fg-muted">
                  {formatTimestamp(job.createdAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function ImportHistorySkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-card border border-border p-4">
      {Array.from({ length: 6 }).map((_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}

function ImportHistoryError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  if (error instanceof ForbiddenError) {
    return (
      <EmptyState
        icon={<ShieldOff className="size-5" />}
        title="You don't have permission to view this"
        description="Viewing import history requires the people.person:read permission."
        className="min-h-[24rem] justify-center"
      />
    );
  }
  return (
    <EmptyState
      icon={<WifiOff className="size-5" />}
      title="Couldn't load import history"
      description={error.message}
      action={
        <Button onClick={onRetry}>
          <RefreshCw className="size-4" />
          Retry
        </Button>
      }
      className="min-h-[24rem] justify-center"
    />
  );
}
