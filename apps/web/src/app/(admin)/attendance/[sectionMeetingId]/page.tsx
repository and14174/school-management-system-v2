'use client';

import * as React from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useParams, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CalendarX, RefreshCw, ShieldOff, WifiOff } from 'lucide-react';
import { Button, EmptyState, Skeleton } from '@sms/ui';
import { fetchAttendanceCodes, fetchSessionRoster } from '../../../../lib/api';
import { ForbiddenError } from '../../../../lib/http';
import { usePermissions } from '../../../../lib/permissions';
import { formatDateOnly, todayIso } from '../format';
import { MarkingForm } from './marking-form';

export default function MarkingScreenPage() {
  const params = useParams<{ sectionMeetingId: string }>();
  const sectionMeetingId = params.sectionMeetingId;
  const searchParams = useSearchParams();
  const date = searchParams.get('date') || todayIso();

  const { can, isLoading: permissionsLoading, isError: permissionsError } = usePermissions();

  const codesQuery = useQuery({
    queryKey: ['attendance', 'codes'],
    queryFn: ({ signal }) => fetchAttendanceCodes(signal),
    enabled: can('attendance.record:read'),
    staleTime: 5 * 60_000,
  });

  const rosterQuery = useQuery({
    queryKey: ['attendance', 'roster', sectionMeetingId, date],
    queryFn: ({ signal }) => fetchSessionRoster(sectionMeetingId, date, signal),
    enabled: Boolean(sectionMeetingId) && can('attendance.record:read'),
  });

  const backLink = (
    <Button variant="ghost" size="sm" asChild>
      <Link href={`/attendance?date=${date}` as Route}>
        <ArrowLeft className="size-4" />
        Back to attendance
      </Link>
    </Button>
  );

  if (!permissionsLoading && !permissionsError && !can('attendance.record:read')) {
    return (
      <div className="flex flex-col gap-4">
        {backLink}
        <EmptyState
          icon={<ShieldOff className="size-5" />}
          title="You don't have permission to view this"
          description="Marking attendance requires the attendance.record:read permission."
          className="min-h-[24rem] justify-center"
        />
      </div>
    );
  }

  if (codesQuery.isPending || rosterQuery.isPending) {
    return (
      <div className="flex flex-col gap-4">
        {backLink}
        <MarkingScreenSkeleton />
      </div>
    );
  }

  if (codesQuery.isError) {
    return (
      <div className="flex flex-col gap-4">
        {backLink}
        <MarkingScreenError error={codesQuery.error} onRetry={() => void codesQuery.refetch()} />
      </div>
    );
  }

  if (rosterQuery.isError) {
    const message = rosterQuery.error.message;
    // The API 403s (not 404s) a session that does not run on `date` - see
    // fetchSessionRoster's own comment. A ForbiddenError with that specific
    // message is a navigation mistake (a stale link, a guessed date), not a
    // permission problem, so it gets its own honest explanation rather than
    // "you don't have permission" or a generic retry.
    if (rosterQuery.error instanceof ForbiddenError && /does not run on/i.test(message)) {
      return (
        <div className="flex flex-col gap-4">
          {backLink}
          <EmptyState
            icon={<CalendarX className="size-5" />}
            title="This class doesn't meet on this date"
            description={`There is no scheduled session for ${formatDateOnly(date)}. Go back and pick a date this class actually runs.`}
            className="min-h-[24rem] justify-center"
          />
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-4">
        {backLink}
        <MarkingScreenError error={rosterQuery.error} onRetry={() => void rosterQuery.refetch()} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {backLink}
      {/* Keyed on the session identity so a fresh MarkingForm instance mounts
          for every distinct (sectionMeetingId, date) - see that component's
          own comment for why that is exactly what makes its idempotency-key
          and initial-marks seeding correct. */}
      <MarkingForm
        key={`${sectionMeetingId}:${date}`}
        sectionMeetingId={sectionMeetingId}
        date={date}
        roster={rosterQuery.data}
        codes={codesQuery.data}
        canWrite={can('attendance.record:write')}
      />
    </div>
  );
}

function MarkingScreenSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-10 w-full" />
      {Array.from({ length: 8 }).map((_, index) => (
        <Skeleton key={index} className="h-16 w-full rounded-card" />
      ))}
    </div>
  );
}

function MarkingScreenError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  if (error instanceof ForbiddenError) {
    return (
      <EmptyState
        icon={<ShieldOff className="size-5" />}
        title="You don't have permission to view this"
        description="Marking attendance requires the attendance.record:read permission."
        className="min-h-[24rem] justify-center"
      />
    );
  }
  return (
    <EmptyState
      icon={<WifiOff className="size-5" />}
      title="Couldn't load this register"
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
