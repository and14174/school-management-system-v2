'use client';

import * as React from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck, CheckCircle2, ChevronRight, RefreshCw, ShieldOff, WifiOff } from 'lucide-react';
import { Badge, Button, EmptyState, Input, Label, PageHeader, Skeleton, cn } from '@sms/ui';
import {
  fetchMyTeacherTimetable,
  fetchUnmarkedSessions,
  type TimetableEntry,
  type UnmarkedSession,
} from '../../../lib/api';
import { ForbiddenError } from '../../../lib/http';
import { usePermissions } from '../../../lib/permissions';
import { formatTimeOfDay, todayIso } from './format';

interface SessionRow {
  sectionMeetingId: string;
  periodName: string;
  sectionCode: string;
  sectionName: string;
  startsAt: string | null;
  roomCode: string | null;
  isSubstituting: boolean;
}

function fromUnmarked(session: UnmarkedSession): SessionRow {
  return {
    sectionMeetingId: session.sectionMeetingId,
    periodName: session.periodName,
    sectionCode: session.sectionCode,
    sectionName: session.sectionName,
    startsAt: null,
    roomCode: null,
    isSubstituting: false,
  };
}

function fromTimetableEntry(entry: TimetableEntry): SessionRow {
  return {
    sectionMeetingId: entry.sectionMeetingId,
    periodName: entry.periodName,
    sectionCode: entry.sectionCode,
    sectionName: entry.sectionName,
    startsAt: entry.startsAt,
    roomCode: entry.roomCode,
    isSubstituting: entry.isSubstituting,
  };
}

function sortRows(rows: SessionRow[]): SessionRow[] {
  return [...rows].sort((a, b) => (a.startsAt ?? a.periodName).localeCompare(b.startsAt ?? b.periodName));
}

/**
 * The single most-used screen in the product answers one question first:
 * "what still needs marking?" - built from TWO calls, cross-referenced by
 * `sectionMeetingId`:
 *   1. `unmarked-sessions?date=` - sections meeting today with no submission
 *      yet, already scoped to the caller (the API's own primary "what needs
 *      marking" report).
 *   2. `timetables/teacher/mine` for the same single day - the caller's full
 *      day, used only to compute "already marked" (today's sessions minus
 *      the unmarked ones) and to enrich each row with a time/room. If this
 *      second call is unavailable (no `academic.timetable:read`, or it
 *      errors), the page still works from (1) alone - it just can't show the
 *      "already marked" section or per-row time/room.
 */
export default function AttendanceLandingPage() {
  const { can, isLoading: permissionsLoading, isError: permissionsError } = usePermissions();
  const [date, setDate] = React.useState(todayIso);

  const range = React.useMemo(() => ({ from: date, to: date }), [date]);

  const unmarkedQuery = useQuery({
    queryKey: ['attendance', 'unmarked', date],
    queryFn: ({ signal }) => fetchUnmarkedSessions({ date }, signal),
    enabled: can('attendance.record:read'),
  });

  const timetableQuery = useQuery({
    queryKey: ['academic', 'timetable', 'mine', date],
    queryFn: ({ signal }) => fetchMyTeacherTimetable(range, signal),
    enabled: can('academic.timetable:read'),
  });

  const isToday = date === todayIso();

  if (!permissionsLoading && !permissionsError && !can('attendance.record:read')) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="School" title="Attendance" description="Take the register for your classes." />
        <EmptyState
          icon={<ShieldOff className="size-5" />}
          title="You don't have permission to view this"
          description="Viewing attendance requires the attendance.record:read permission. Ask an administrator if you believe this is a mistake."
          className="min-h-[24rem] justify-center"
        />
      </div>
    );
  }

  const unmarkedIds = new Set((unmarkedQuery.data ?? []).map((session) => session.sectionMeetingId));
  const timetableAvailable = can('academic.timetable:read') && !timetableQuery.isError && Boolean(timetableQuery.data);

  let outstanding: SessionRow[];
  let marked: SessionRow[];
  if (timetableAvailable) {
    const rows = (timetableQuery.data ?? []).map(fromTimetableEntry);
    outstanding = sortRows(rows.filter((row) => unmarkedIds.has(row.sectionMeetingId)));
    marked = sortRows(rows.filter((row) => !unmarkedIds.has(row.sectionMeetingId)));
  } else {
    outstanding = sortRows((unmarkedQuery.data ?? []).map(fromUnmarked));
    marked = [];
  }

  const totalToday = outstanding.length + marked.length;
  const loading = unmarkedQuery.isPending || (can('academic.timetable:read') && timetableQuery.isPending);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="School"
        title="Attendance"
        description="Take the register for your classes."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void unmarkedQuery.refetch();
              void timetableQuery.refetch();
            }}
          >
            <RefreshCw className="size-3.5" />
            Refresh
          </Button>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="attendance-date">Date</Label>
          <Input
            id="attendance-date"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value || todayIso())}
            className="w-44"
          />
        </div>
        {!isToday ? (
          <Button variant="ghost" size="sm" onClick={() => setDate(todayIso())}>
            Jump to today
          </Button>
        ) : null}
      </div>

      {loading ? (
        <AttendanceLandingSkeleton />
      ) : unmarkedQuery.isError ? (
        <AttendanceLandingError error={unmarkedQuery.error} onRetry={() => void unmarkedQuery.refetch()} />
      ) : (
        <>
          <StatusBanner outstandingCount={outstanding.length} totalToday={totalToday} isToday={isToday} />

          {outstanding.length > 0 ? (
            <div className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold text-fg">Still needs marking ({outstanding.length})</h2>
              <ul className="flex flex-col gap-2">
                {outstanding.map((row) => (
                  <SessionRowCard key={row.sectionMeetingId} row={row} date={date} tone="outstanding" />
                ))}
              </ul>
            </div>
          ) : null}

          {marked.length > 0 ? (
            <div className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-fg-muted">Already marked ({marked.length})</h2>
              <ul className="flex flex-col gap-2">
                {marked.map((row) => (
                  <SessionRowCard key={row.sectionMeetingId} row={row} date={date} tone="marked" />
                ))}
              </ul>
            </div>
          ) : null}

          {totalToday === 0 ? (
            <EmptyState
              icon={<CalendarCheck className="size-5" />}
              title="No classes on this date"
              description="You have no sections scheduled to meet on this date."
              className="min-h-[16rem] justify-center"
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function StatusBanner({
  outstandingCount,
  totalToday,
  isToday,
}: {
  outstandingCount: number;
  totalToday: number;
  isToday: boolean;
}) {
  if (totalToday === 0) return null;
  const when = isToday ? 'today' : 'this date';

  if (outstandingCount === 0) {
    return (
      <div className="flex items-center gap-3 rounded-card border border-success/30 bg-success-soft px-4 py-3">
        <CheckCircle2 className="size-5 shrink-0 text-success" />
        <p className="text-sm font-medium text-success">All {totalToday} registers are marked for {when}.</p>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-card border border-warning/30 bg-warning-soft px-4 py-3">
      <CalendarCheck className="size-5 shrink-0 text-warning" />
      <p className="text-sm font-medium text-warning">
        {outstandingCount} of {totalToday} register{totalToday === 1 ? '' : 's'} still need
        {outstandingCount === 1 ? 's' : ''} marking {when}.
      </p>
    </div>
  );
}

function SessionRowCard({ row, date, tone }: { row: SessionRow; date: string; tone: 'outstanding' | 'marked' }) {
  return (
    <li>
      <Link
        href={`/attendance/${row.sectionMeetingId}?date=${date}` as Route}
        className={cn(
          'flex min-h-16 items-center justify-between gap-3 rounded-card border px-4 py-3',
          'transition-colors duration-150 ease-out motion-reduce:transition-none',
          tone === 'outstanding'
            ? 'border-warning/40 bg-warning-soft hover:border-warning/70'
            : 'border-border bg-surface hover:bg-surface-sunken',
        )}
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-semibold text-fg">
            {row.sectionCode} · {row.periodName}
          </span>
          <span className="truncate text-xs text-fg-muted">
            {row.sectionName}
            {row.roomCode ? ` · Room ${row.roomCode}` : ''}
            {row.startsAt ? ` · ${formatTimeOfDay(row.startsAt)}` : ''}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {row.isSubstituting ? <Badge variant="info">Covering</Badge> : null}
          {tone === 'marked' ? <Badge variant="success">Marked</Badge> : null}
          <ChevronRight className="size-4 text-fg-subtle" />
        </div>
      </Link>
    </li>
  );
}

function AttendanceLandingSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 4 }).map((_, index) => (
        <Skeleton key={index} className="h-16 w-full rounded-card" />
      ))}
    </div>
  );
}

function AttendanceLandingError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  if (error instanceof ForbiddenError) {
    return (
      <EmptyState
        icon={<ShieldOff className="size-5" />}
        title="You don't have permission to view this"
        description="Viewing attendance requires the attendance.record:read permission."
        className="min-h-[24rem] justify-center"
      />
    );
  }
  return (
    <EmptyState
      icon={<WifiOff className="size-5" />}
      title="Couldn't load today's sessions"
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
