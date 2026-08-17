'use client';

import * as React from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Lock, RefreshCw, ShieldOff, WifiOff } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  EmptyState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@sms/ui';
import {
  fetchGradingPeriodLock,
  fetchGradingPeriods,
  fetchSection,
  fetchSectionAssignments,
  fetchSectionCategories,
  fetchSectionStudents,
} from '../../../../lib/api';
import { ForbiddenError } from '../../../../lib/http';
import { usePermissions } from '../../../../lib/permissions';
import { buildGradingPeriodOptions, pickDefaultGradingPeriodId } from '../gradebook-utils';
import { GradebookGrid } from './gradebook-grid';

/**
 * Orchestrates every read this screen needs before the grid can render, then
 * hands the resolved section/students/categories/assignments/lock down to
 * `GradebookGrid`, which owns all the editing state. Kept in a separate
 * component from the grid deliberately - the grid already carries a lot of
 * state (per-cell edits, per-assignment save/idempotency), and mixing that
 * with "is any of the up-front data still loading" would make both harder to
 * reason about.
 */
export default function SectionGradebookPage() {
  const params = useParams<{ sectionId: string }>();
  const sectionId = params.sectionId;
  const { can, isLoading: permissionsLoading, isError: permissionsError } = usePermissions();
  const [gradingPeriodId, setGradingPeriodId] = React.useState<string | null>(null);

  const canRead = can('academic.gradebook:read');
  const canWrite = can('academic.gradebook:write');
  const canReadTermNames = can('academic.term:read');

  const sectionQuery = useQuery({
    queryKey: ['gradebook', 'section', sectionId],
    queryFn: ({ signal }) => fetchSection(sectionId, signal),
    enabled: Boolean(sectionId) && canRead,
  });

  const studentsQuery = useQuery({
    queryKey: ['gradebook', 'section', sectionId, 'students'],
    queryFn: ({ signal }) => fetchSectionStudents(sectionId, signal),
    enabled: Boolean(sectionId) && canRead,
  });

  const categoriesQuery = useQuery({
    queryKey: ['gradebook', 'section', sectionId, 'categories'],
    queryFn: ({ signal }) => fetchSectionCategories(sectionId, signal),
    enabled: Boolean(sectionId) && canRead,
  });

  // Unfiltered - every assignment in the section, across every grading
  // period, is how the period picker below is built without ever needing
  // `academic.term:read` (see gradebook-utils.ts's own comment).
  const allAssignmentsQuery = useQuery({
    queryKey: ['gradebook', 'section', sectionId, 'assignments', 'all'],
    queryFn: ({ signal }) => fetchSectionAssignments(sectionId, undefined, signal),
    enabled: Boolean(sectionId) && canRead,
  });

  const gradingPeriodsQuery = useQuery({
    queryKey: ['academic', 'term', sectionQuery.data?.termId, 'grading-periods'],
    queryFn: ({ signal }) => fetchGradingPeriods(sectionQuery.data!.termId, signal),
    enabled: Boolean(sectionQuery.data?.termId) && canReadTermNames,
  });

  const gradingPeriodOptions = React.useMemo(
    () => buildGradingPeriodOptions(allAssignmentsQuery.data ?? [], gradingPeriodsQuery.data ?? []),
    [allAssignmentsQuery.data, gradingPeriodsQuery.data],
  );

  // Land on the most recently-due period the first time options resolve;
  // never overwrite a selection the teacher already made.
  React.useEffect(() => {
    if (gradingPeriodId !== null) return;
    if (gradingPeriodOptions.length === 0) return;
    setGradingPeriodId(pickDefaultGradingPeriodId(gradingPeriodOptions));
  }, [gradingPeriodOptions, gradingPeriodId]);

  const lockQuery = useQuery({
    queryKey: ['gradebook', 'grading-period', gradingPeriodId, 'lock'],
    queryFn: ({ signal }) => fetchGradingPeriodLock(gradingPeriodId as string, signal),
    enabled: Boolean(gradingPeriodId) && canRead,
  });

  if (!permissionsLoading && !permissionsError && !canRead) {
    return (
      <EmptyState
        icon={<ShieldOff className="size-5" />}
        title="You don't have permission to view this"
        description="Viewing the gradebook requires the academic.gradebook:read permission. Ask an administrator if you believe this is a mistake."
        className="min-h-[24rem] justify-center"
      />
    );
  }

  const loading =
    sectionQuery.isPending || studentsQuery.isPending || categoriesQuery.isPending || allAssignmentsQuery.isPending;

  const firstError = sectionQuery.error ?? studentsQuery.error ?? categoriesQuery.error ?? allAssignmentsQuery.error;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link
          href={'/gradebook' as Route}
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted transition-colors duration-150 hover:text-fg"
        >
          <ArrowLeft className="size-3.5" />
          Back to your sections
        </Link>
      </div>

      {loading ? (
        <GradebookPageSkeleton />
      ) : firstError ? (
        <GradebookPageError
          error={firstError}
          onRetry={() => {
            void sectionQuery.refetch();
            void studentsQuery.refetch();
            void categoriesQuery.refetch();
            void allAssignmentsQuery.refetch();
          }}
        />
      ) : !sectionQuery.data ? (
        <EmptyState icon={<ShieldOff className="size-5" />} title="Section not found" className="min-h-[24rem] justify-center" />
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
            <div className="flex flex-col gap-1">
              <h1 className="text-xl font-semibold text-fg">
                {sectionQuery.data.code} · {sectionQuery.data.name}
              </h1>
              <p className="text-sm text-fg-muted">
                {(studentsQuery.data ?? []).length} student{(studentsQuery.data ?? []).length === 1 ? '' : 's'}
                {!canWrite ? ' · Read-only' : ''}
              </p>
            </div>

            {gradingPeriodOptions.length > 1 ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-fg-muted">Grading period</span>
                <Select value={gradingPeriodId ?? undefined} onValueChange={setGradingPeriodId}>
                  <SelectTrigger className="w-64" aria-label="Grading period">
                    <SelectValue placeholder="Select a grading period" />
                  </SelectTrigger>
                  <SelectContent>
                    {gradingPeriodOptions.map((option) => (
                      <SelectItem key={option.gradingPeriodId} value={option.gradingPeriodId}>
                        {option.label} ({option.assignmentCount})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : gradingPeriodOptions.length === 1 ? (
              <span className="text-sm text-fg-muted">{gradingPeriodOptions[0]?.label}</span>
            ) : null}
          </div>

          {gradingPeriodOptions.length === 0 ? (
            <EmptyState
              title="No assignments yet"
              description="This section has no assignments in any grading period yet."
              className="min-h-[16rem] justify-center"
            />
          ) : gradingPeriodId ? (
            lockQuery.data?.locked ? (
              <Alert variant="warning" icon={<Lock className="mt-0.5 size-4 shrink-0" />}>
                <AlertTitle>This grading period is locked</AlertTitle>
                <AlertDescription>
                  Scores can no longer be entered directly for this grading period - the server will reject any
                  save. Ask an administrator to unlock it, or to approve a correction, before entering more grades
                  here.
                </AlertDescription>
              </Alert>
            ) : null
          ) : null}

          {gradingPeriodId ? (
            <GradebookGrid
              sectionId={sectionId}
              gradingPeriodId={gradingPeriodId}
              students={studentsQuery.data ?? []}
              categories={categoriesQuery.data ?? []}
              allAssignments={allAssignmentsQuery.data ?? []}
              canWrite={canWrite}
              locked={Boolean(lockQuery.data?.locked)}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function GradebookPageSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-64 w-full rounded-card" />
    </div>
  );
}

function GradebookPageError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  if (error instanceof ForbiddenError) {
    return (
      <EmptyState
        icon={<ShieldOff className="size-5" />}
        title="You don't have permission to view this section's gradebook"
        description="This section isn't one you teach, or your access has changed."
        className="min-h-[24rem] justify-center"
      />
    );
  }
  return (
    <EmptyState
      icon={<WifiOff className="size-5" />}
      title="Couldn't load this gradebook"
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
