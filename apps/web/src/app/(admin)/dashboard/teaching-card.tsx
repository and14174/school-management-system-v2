'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck2, ChevronRight } from 'lucide-react';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState } from '@sms/ui';
import { fetchMyTeacherTimetable, fetchUnmarkedSessions, type TimetableEntry } from '../../../lib/api';
import { usePermissions } from '../../../lib/permissions';
import { permissionScope } from '../../../lib/dashboard-api';
import { CardErrorState, CardSkeletonRows } from './card-states';
import { formatTimeOfDay, isSectionMeetingDay, todayIso } from './format';

const MAX_ROWS = 5;

function sortByStart(entries: TimetableEntry[]): TimetableEntry[] {
  return [...entries].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/**
 * "My sections today" + "sessions I have not marked yet" - the teaching
 * half of the dashboard. Shown only for a caller whose `academic.timetable:
 * read` grant is `section`-scoped (a real teaching assignment) - see
 * permissionScope's own comment for why scope, not just can(), decides this:
 * a tenant-scoped Administrator/Registrar holding the same permission key
 * teaches nothing, and an empty "my sections" card for them would read as a
 * bug rather than a true fact about their role.
 *
 * Built from the SAME two-call cross-reference as attendance/page.tsx (see
 * that file's own top comment): timetables/teacher/mine for today (already
 * day-of-week aware - a section meeting only exists Mon/Wed/Fri in this
 * seed) plus unmarked-sessions for today, joined by sectionMeetingId. The
 * "not marked" half degrades gracefully if the caller lacks attendance.
 * record:read - the card still shows today's sections, just without marked/
 * unmarked badges.
 */
export function TeachingCard() {
  const { can, permissions } = usePermissions();
  const applicable = permissionScope(permissions, 'academic.timetable:read') === 'section';
  const date = todayIso();
  const canReadAttendance = can('attendance.record:read');

  const timetableQuery = useQuery({
    queryKey: ['dashboard', 'timetable', 'mine', date],
    queryFn: ({ signal }) => fetchMyTeacherTimetable({ from: date, to: date }, signal),
    enabled: applicable,
  });

  const unmarkedQuery = useQuery({
    queryKey: ['dashboard', 'attendance', 'unmarked', 'mine', date],
    queryFn: ({ signal }) => fetchUnmarkedSessions({ date }, signal),
    enabled: applicable && canReadAttendance,
  });

  if (!applicable) return null;

  const loading = timetableQuery.isPending || (canReadAttendance && unmarkedQuery.isPending);
  const unmarkedIds = new Set((unmarkedQuery.data ?? []).map((session) => session.sectionMeetingId));
  const unmarkedKnown = canReadAttendance && !unmarkedQuery.isError;
  const entries = sortByStart(timetableQuery.data ?? []);
  const outstandingCount = unmarkedKnown ? entries.filter((e) => unmarkedIds.has(e.sectionMeetingId)).length : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>My teaching today</CardTitle>
        <CardDescription>
          {unmarkedKnown && entries.length > 0
            ? `${entries.length} section${entries.length === 1 ? '' : 's'} · ${outstandingCount} still need${outstandingCount === 1 ? 's' : ''} marking`
            : 'Your sections meeting today.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {loading ? (
          <CardSkeletonRows count={3} />
        ) : timetableQuery.isError ? (
          <CardErrorState
            message={timetableQuery.error.message}
            onRetry={() => void timetableQuery.refetch()}
          />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={<CalendarCheck2 className="size-5" />}
            title={isSectionMeetingDay() ? 'No sections today' : 'No sessions scheduled today'}
            description={
              isSectionMeetingDay()
                ? 'You have no sections scheduled to meet today.'
                : 'Sections meet Monday, Wednesday and Friday - nothing is scheduled on other days.'
            }
            className="min-h-40 justify-center py-8"
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {entries.slice(0, MAX_ROWS).map((entry) => {
              const needsMarking = unmarkedKnown && unmarkedIds.has(entry.sectionMeetingId);
              return (
                <li key={entry.sectionMeetingId}>
                  <Link
                    href={`/attendance/${entry.sectionMeetingId}?date=${date}` as Route}
                    className="flex items-center justify-between gap-3 rounded-control border border-border bg-surface-sunken px-3 py-2.5 transition-colors duration-150 ease-out hover:bg-surface motion-reduce:transition-none"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium text-fg">
                        {entry.sectionCode} · {entry.periodName}
                      </span>
                      <span className="truncate text-xs text-fg-muted">
                        {formatTimeOfDay(entry.startsAt)}
                        {entry.roomCode ? ` · Room ${entry.roomCode}` : ''}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {unmarkedKnown ? (
                        <Badge variant={needsMarking ? 'warning' : 'success'}>
                          {needsMarking ? 'Needs marking' : 'Marked'}
                        </Badge>
                      ) : null}
                      <ChevronRight className="size-4 text-fg-subtle" />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {!loading && !timetableQuery.isError && entries.length > 0 ? (
          <Link href={'/attendance' as Route} className="text-xs font-medium text-primary hover:underline">
            Go to attendance →
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}
