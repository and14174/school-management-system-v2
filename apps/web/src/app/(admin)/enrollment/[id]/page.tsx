'use client';

import * as React from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, History, ShieldOff, UserRoundX, WifiOff } from 'lucide-react';
import { Avatar, AvatarFallback, Badge, Button, EmptyState, Skeleton } from '@sms/ui';
import {
  fetchEnrollment,
  fetchEnrollmentHistory,
  fetchGradeLevels,
  fetchPerson,
  fetchScope,
  personDetailQueryKey,
} from '../../../../lib/api';
import { ForbiddenError } from '../../../../lib/http';
import { usePermissions } from '../../../../lib/permissions';
import { useSession } from '../../../../components/providers/session-provider';
import { ENROLLMENT_STATUS_BADGE_VARIANT, ENROLLMENT_STATUS_LABELS, formatDateOnly } from '../format';
import { StatusTimeline } from './status-timeline';
import { TransitionDialog } from './transition-dialog';

export default function EnrollmentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { can, isLoading: permissionsLoading, isError: permissionsError } = usePermissions();
  const { user } = useSession();
  const [transitionOpen, setTransitionOpen] = React.useState(false);

  const enrollmentQuery = useQuery({
    queryKey: ['enrollment', 'detail', id],
    queryFn: ({ signal }) => fetchEnrollment(id, signal),
    enabled: Boolean(id) && can('enrollment.enrollment:read'),
  });

  const historyQuery = useQuery({
    queryKey: ['enrollment', 'history', id],
    queryFn: ({ signal }) => fetchEnrollmentHistory(id, signal),
    enabled: Boolean(id) && can('enrollment.enrollment:read'),
  });

  const enrollment = enrollmentQuery.data;

  const personQuery = useQuery({
    queryKey: personDetailQueryKey(enrollment?.personId ?? ''),
    queryFn: ({ signal }) => fetchPerson(enrollment!.personId, signal),
    enabled: Boolean(enrollment),
  });

  const scopeQuery = useQuery({ queryKey: ['tenancy', 'scope'], queryFn: ({ signal }) => fetchScope(undefined, signal) });
  const gradeLevelsQuery = useQuery({
    queryKey: ['academic', 'grade-levels'],
    queryFn: ({ signal }) => fetchGradeLevels(signal),
    retry: false,
  });

  if (!permissionsLoading && !permissionsError && !can('enrollment.enrollment:read')) {
    return (
      <EmptyState
        icon={<ShieldOff className="size-5" />}
        title="You don't have permission to view this"
        description="Viewing enrollment requires the enrollment.enrollment:read permission."
        className="min-h-[24rem] justify-center"
      />
    );
  }

  if (enrollmentQuery.isPending) {
    return <EnrollmentDetailSkeleton />;
  }

  if (enrollmentQuery.isError) {
    if (enrollmentQuery.error instanceof ForbiddenError) {
      return (
        <EmptyState
          icon={<ShieldOff className="size-5" />}
          title="You don't have permission to view this"
          description="Viewing this enrollment requires the enrollment.enrollment:read permission."
          className="min-h-[24rem] justify-center"
        />
      );
    }
    return (
      <EmptyState
        icon={<WifiOff className="size-5" />}
        title="Couldn't load this enrollment"
        description={enrollmentQuery.error.message}
        action={<Button onClick={() => void enrollmentQuery.refetch()}>Retry</Button>}
        className="min-h-[24rem] justify-center"
      />
    );
  }

  if (!enrollment) {
    return (
      <EmptyState
        icon={<UserRoundX className="size-5" />}
        title="Enrollment not found"
        className="min-h-[24rem] justify-center"
      />
    );
  }

  const person = personQuery.data;
  const shownName = person ? person.preferredName?.trim() || `${person.givenName} ${person.familyName}` : 'Loading…';
  const gradeLevelName =
    gradeLevelsQuery.data?.find((gradeLevel) => gradeLevel.id === enrollment.gradeLevelId)?.name ??
    enrollment.gradeLevelId;
  const campusName = scopeQuery.data?.campuses.find((campus) => campus.id === enrollment.campusId)?.name ?? enrollment.campusId;
  const academicYearName =
    scopeQuery.data?.academicYears.find((year) => year.id === enrollment.academicYearId)?.name ?? enrollment.academicYearId;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href={'/enrollment' as Route}
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted transition-colors duration-150 hover:text-fg"
        >
          <ArrowLeft className="size-3.5" />
          Back to enrollment
        </Link>
      </div>

      <div className="flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-start sm:justify-between sm:gap-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
          <Avatar className="size-16 shrink-0 text-base">
            <AvatarFallback className="text-base">{initials(shownName)}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              {person ? (
                <Link href={`/people/${person.id}` as Route} className="text-xl font-semibold text-fg hover:underline">
                  {shownName}
                </Link>
              ) : (
                <h1 className="text-xl font-semibold text-fg">{shownName}</h1>
              )}
              <Badge variant={ENROLLMENT_STATUS_BADGE_VARIANT[enrollment.status]}>
                {ENROLLMENT_STATUS_LABELS[enrollment.status]}
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
              <span>{gradeLevelName}</span>
              <span>·</span>
              <span>{campusName}</span>
              <span>·</span>
              <span>{academicYearName}</span>
              {enrollment.studentNumber ? (
                <>
                  <span>·</span>
                  <span data-tabular>#{enrollment.studentNumber}</span>
                </>
              ) : null}
            </div>
            <p className="text-xs text-fg-subtle" data-tabular>
              Enrolled {formatDateOnly(enrollment.enrolledOn)}
              {enrollment.exitedOn ? ` · Exited ${formatDateOnly(enrollment.exitedOn)}` : ''}
              {enrollment.exitReason ? ` (${enrollment.exitReason})` : ''}
            </p>
          </div>
        </div>

        {can('enrollment.enrollment:write') ? (
          <Button onClick={() => setTransitionOpen(true)} className="shrink-0">
            Change status
          </Button>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <History className="size-4 text-fg-subtle" />
          <h2 className="text-sm font-semibold text-fg">Status history</h2>
        </div>
        {historyQuery.isPending ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-16 w-full" />
            ))}
          </div>
        ) : historyQuery.isError ? (
          <p className="text-sm text-danger">Could not load status history: {historyQuery.error.message}</p>
        ) : (
          <StatusTimeline events={historyQuery.data} currentUser={user} />
        )}
      </div>

      <TransitionDialog open={transitionOpen} onOpenChange={setTransitionOpen} enrollment={enrollment} />
    </div>
  );
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

function EnrollmentDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-4 w-32" />
      <div className="flex items-start gap-5 border-b border-border pb-6">
        <Skeleton className="size-16 rounded-full" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
