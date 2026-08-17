'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useQuery } from '@tanstack/react-query';
import { CalendarRange, CheckCircle2 } from 'lucide-react';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@sms/ui';
import { usePermissions } from '../../../lib/permissions';
import {
  fetchScheduleConflicts,
  permissionScope,
  type AcademicYearState,
  type ScheduleConflict,
} from '../../../lib/dashboard-api';
import { CardErrorState, CardSkeletonRows } from './card-states';
import { CONFLICT_KIND_LABELS } from './format';

const WEEKDAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MAX_ROWS = 5;

/**
 * Outstanding room/teacher scheduling conflicts for the current academic
 * year. `GET /academic/schedule-conflicts` only returns real data for a
 * `tenant`-scoped `academic.timetable:read` grant - every other scope
 * (including a `section`-scoped Teacher, who holds the same permission KEY)
 * gets back `[]` from the server regardless of whether conflicts exist (see
 * SchedulingController.scheduleConflicts's own comment). Gating on the
 * granted SCOPE rather than can() alone is what keeps that from rendering as
 * a false "no conflicts" for a caller the endpoint never actually checked.
 */
export function SchedulingCard({ yearState }: { yearState: AcademicYearState }) {
  const { permissions } = usePermissions();
  const applicable = permissionScope(permissions, 'academic.timetable:read') === 'tenant';
  const academicYearId = yearState.status === 'ready' ? yearState.academicYearId : undefined;

  const query = useQuery({
    queryKey: ['dashboard', 'academic', 'schedule-conflicts', academicYearId],
    queryFn: ({ signal }) => fetchScheduleConflicts(academicYearId as string, signal),
    enabled: applicable && typeof academicYearId === 'string',
  });

  if (!applicable) return null;

  const conflicts: ScheduleConflict[] = query.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scheduling conflicts</CardTitle>
        <CardDescription>Rooms and teachers double-booked this academic year.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {yearState.status === 'loading' ? (
          <CardSkeletonRows count={2} />
        ) : yearState.status === 'error' ? (
          <CardErrorState message={yearState.message} onRetry={yearState.retry} />
        ) : yearState.academicYearId === null ? (
          <p className="text-sm text-fg-muted">No current academic year is configured for this tenant.</p>
        ) : query.isPending ? (
          <CardSkeletonRows count={2} />
        ) : query.isError ? (
          <CardErrorState message={query.error.message} onRetry={() => void query.refetch()} />
        ) : conflicts.length === 0 ? (
          <div className="flex items-center gap-3 rounded-control border border-success/30 bg-success-soft px-3 py-2.5">
            <CheckCircle2 className="size-5 shrink-0 text-success" />
            <p className="text-sm font-medium text-success">No scheduling conflicts detected.</p>
          </div>
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {conflicts.slice(0, MAX_ROWS).map((conflict, index) => (
                <li
                  // Conflicts carry no id of their own (a derived pair, not a
                  // stored row) - the pair of meeting ids is the natural key.
                  key={`${conflict.sectionMeetingIdA}-${conflict.sectionMeetingIdB}-${index}`}
                  className="flex items-center justify-between gap-3 rounded-control border border-border bg-surface-sunken px-3 py-2.5"
                >
                  <span className="text-sm text-fg">on {WEEKDAY_NAMES[conflict.dayOfWeek] ?? 'an unknown day'}</span>
                  <Badge variant="danger">{CONFLICT_KIND_LABELS[conflict.kind]}</Badge>
                </li>
              ))}
            </ul>
            {conflicts.length > MAX_ROWS ? (
              <p className="text-xs text-fg-muted">and {conflicts.length - MAX_ROWS} more.</p>
            ) : null}
            <Link href={'/timetable' as Route} className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
              <CalendarRange className="size-3.5" />
              Open scheduling →
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  );
}
