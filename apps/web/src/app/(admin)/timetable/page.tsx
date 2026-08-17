'use client';

import * as React from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useQuery } from '@tanstack/react-query';
import { addDays, format, parse, startOfWeek } from 'date-fns';
import { CalendarRange, ChevronLeft, ChevronRight, RefreshCw, ShieldOff, WifiOff } from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  cn,
} from '@sms/ui';
import {
  fetchMyTeacherTimetable,
  fetchPeople,
  fetchRoomTimetable,
  fetchRooms,
  fetchTeacherTimetable,
  type TimetableEntry,
} from '../../../lib/api';
import { ForbiddenError } from '../../../lib/http';
import { usePermissions } from '../../../lib/permissions';

type ViewMode = 'mine' | 'teacher' | 'room';

function mondayOf(date: Date): Date {
  return startOfWeek(date, { weekStartsOn: 1 });
}

function isoDate(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

function formatTimeOfDay(value: string): string {
  return format(parse(value, 'HH:mm:ss', new Date()), 'h:mm a');
}

/**
 * A week grid: periods down the side, days across. Defaults to the
 * signed-in teacher's OWN timetable (`timetables/teacher/mine`, which
 * resolves `personId` server-side - nothing to pick). An admin whose
 * `academic.timetable:read` grant is `tenant`-scoped (read straight off
 * `usePermissions()`'s own `permissions` list, not guessed) additionally
 * gets a switcher to view a specific teacher's or room's timetable - a
 * section-scoped Teacher never sees it, since asking for someone else's
 * timetable would just come back empty (see SchedulingController's own
 * `applyTimetableScope` comment).
 */
export default function TimetablePage() {
  const { can, permissions, isLoading: permissionsLoading, isError: permissionsError } = usePermissions();

  const [weekStart, setWeekStart] = React.useState(() => mondayOf(new Date()));
  const [mode, setMode] = React.useState<ViewMode>('mine');
  const [teacherId, setTeacherId] = React.useState('');
  const [roomId, setRoomId] = React.useState('');

  const from = isoDate(weekStart);
  const to = isoDate(addDays(weekStart, 6));
  const todayIso = isoDate(new Date());

  const canSwitch = permissions.some((grant) => grant.key === 'academic.timetable:read' && grant.scope === 'tenant');

  const teachersQuery = useQuery({
    queryKey: ['people', 'staff-directory'],
    queryFn: ({ signal }) => fetchPeople({ role: 'staff', limit: 200 }, signal),
    enabled: canSwitch && mode === 'teacher' && can('people.person:read'),
  });

  const roomsQuery = useQuery({
    queryKey: ['academic', 'rooms'],
    queryFn: ({ signal }) => fetchRooms(signal),
    enabled: canSwitch && mode === 'room' && can('academic.room:read'),
  });

  const timetableQuery = useQuery({
    queryKey: ['academic', 'timetable', mode, mode === 'teacher' ? teacherId : mode === 'room' ? roomId : 'mine', from, to],
    queryFn: ({ signal }) => {
      if (mode === 'teacher') return fetchTeacherTimetable(teacherId, { from, to }, signal);
      if (mode === 'room') return fetchRoomTimetable(roomId, { from, to }, signal);
      return fetchMyTeacherTimetable({ from, to }, signal);
    },
    enabled:
      can('academic.timetable:read') &&
      (mode === 'mine' || (mode === 'teacher' && Boolean(teacherId)) || (mode === 'room' && Boolean(roomId))),
  });

  if (!permissionsLoading && !permissionsError && !can('academic.timetable:read')) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="School" title="Timetable" description="Weekly schedule by period and day." />
        <EmptyState
          icon={<ShieldOff className="size-5" />}
          title="You don't have permission to view this"
          description="Viewing the timetable requires the academic.timetable:read permission."
          className="min-h-[24rem] justify-center"
        />
      </div>
    );
  }

  const entries = timetableQuery.data ?? [];

  const periodRows = React.useMemo(() => {
    const byId = new Map<string, { periodId: string; periodName: string; startsAt: string }>();
    for (const entry of entries) {
      if (!byId.has(entry.periodId)) {
        byId.set(entry.periodId, { periodId: entry.periodId, periodName: entry.periodName, startsAt: entry.startsAt });
      }
    }
    return [...byId.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }, [entries]);

  const entryByCell = React.useMemo(() => {
    const map = new Map<string, TimetableEntry>();
    for (const entry of entries) map.set(`${entry.periodId}:${entry.dayOfWeek}`, entry);
    return map;
  }, [entries]);

  const days = React.useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);
  const isCurrentWeek = from === isoDate(mondayOf(new Date()));
  const needsSelection = (mode === 'teacher' && !teacherId) || (mode === 'room' && !roomId);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="School"
        title="Timetable"
        description={
          mode === 'mine' ? 'Your weekly schedule.' : mode === 'teacher' ? "A teacher's weekly schedule." : "A room's weekly schedule."
        }
        actions={
          <Button variant="secondary" size="sm" onClick={() => void timetableQuery.refetch()}>
            <RefreshCw className="size-3.5" />
            Refresh
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" aria-label="Previous week" onClick={() => setWeekStart((d) => addDays(d, -7))}>
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-40 text-center text-sm font-medium text-fg">
            {format(weekStart, 'MMM d')} – {format(addDays(weekStart, 6), 'MMM d, yyyy')}
          </span>
          <Button variant="outline" size="icon" aria-label="Next week" onClick={() => setWeekStart((d) => addDays(d, 7))}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
        {!isCurrentWeek ? (
          <Button variant="ghost" size="sm" onClick={() => setWeekStart(mondayOf(new Date()))}>
            This week
          </Button>
        ) : null}

        {canSwitch ? (
          <>
            <Select
              value={mode}
              onValueChange={(value) => {
                setMode(value as ViewMode);
                setTeacherId('');
                setRoomId('');
              }}
            >
              <SelectTrigger className="w-40" aria-label="Whose timetable">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mine">My timetable</SelectItem>
                <SelectItem value="teacher">By teacher</SelectItem>
                <SelectItem value="room">By room</SelectItem>
              </SelectContent>
            </Select>

            {mode === 'teacher' ? (
              <Select value={teacherId} onValueChange={setTeacherId}>
                <SelectTrigger className="w-52" aria-label="Choose a teacher">
                  <SelectValue placeholder="Choose a teacher…" />
                </SelectTrigger>
                <SelectContent>
                  {(teachersQuery.data?.items ?? []).map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.givenName} {person.familyName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}

            {mode === 'room' ? (
              <Select value={roomId} onValueChange={setRoomId}>
                <SelectTrigger className="w-52" aria-label="Choose a room">
                  <SelectValue placeholder="Choose a room…" />
                </SelectTrigger>
                <SelectContent>
                  {(roomsQuery.data ?? []).map((room) => (
                    <SelectItem key={room.id} value={room.id}>
                      {room.name} ({room.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </>
        ) : null}
      </div>

      {needsSelection ? (
        <EmptyState
          icon={<CalendarRange className="size-5" />}
          title={mode === 'teacher' ? 'Choose a teacher' : 'Choose a room'}
          description={`Pick a ${mode === 'teacher' ? 'teacher' : 'room'} above to see their weekly schedule.`}
          className="min-h-[16rem] justify-center"
        />
      ) : timetableQuery.isPending ? (
        <Skeleton className="h-96 w-full rounded-card" />
      ) : timetableQuery.isError ? (
        <TimetableError error={timetableQuery.error} onRetry={() => void timetableQuery.refetch()} />
      ) : (
        <div className="overflow-x-auto rounded-card border border-border">
          <div className="grid min-w-[56rem]" style={{ gridTemplateColumns: '9rem repeat(7, minmax(7rem, 1fr))' }}>
            <div className="sticky start-0 z-10 border-b border-e border-border bg-surface-sunken p-2 text-xs font-medium text-fg-subtle">
              Period
            </div>
            {days.map((day) => {
              const dateIso = isoDate(day);
              return (
                <div
                  key={dateIso}
                  className={cn(
                    'border-b border-e border-border p-2 text-center text-xs font-medium text-fg',
                    dateIso === todayIso && 'bg-primary-soft text-primary-soft-fg',
                  )}
                >
                  <div>{format(day, 'EEE')}</div>
                  <div className="font-normal text-fg-subtle">{format(day, 'MMM d')}</div>
                </div>
              );
            })}

            {periodRows.length === 0 ? (
              <div className="col-span-8 p-6 text-center text-sm text-fg-muted">No scheduled classes this week.</div>
            ) : (
              periodRows.map((period) => (
                <React.Fragment key={period.periodId}>
                  <div className="sticky start-0 z-10 border-b border-e border-border bg-surface-sunken p-2 text-xs">
                    <div className="font-medium text-fg">{period.periodName}</div>
                    <div className="text-fg-subtle">{formatTimeOfDay(period.startsAt)}</div>
                  </div>
                  {days.map((day, index) => {
                    const dayOfWeek = index + 1;
                    const dateIso = isoDate(day);
                    const entry = entryByCell.get(`${period.periodId}:${dayOfWeek}`);
                    const cellIsToday = dateIso === todayIso;
                    const content = entry ? (
                      <div className="flex flex-col gap-1">
                        <span className="font-medium text-fg">{entry.sectionCode}</span>
                        <span className="text-fg-subtle">{entry.roomCode ?? '—'}</span>
                        {entry.isSubstituting ? (
                          <Badge variant="info" className="w-fit">
                            Covering
                          </Badge>
                        ) : null}
                        {entry.isSubstituted ? (
                          <Badge variant="warning" className="w-fit">
                            Substituted
                          </Badge>
                        ) : null}
                      </div>
                    ) : null;

                    return (
                      <div
                        key={dateIso}
                        className={cn('border-b border-e border-border p-2 text-xs', cellIsToday && 'bg-primary-soft/30')}
                      >
                        {entry ? (
                          cellIsToday ? (
                            <Link
                              href={`/attendance/${entry.sectionMeetingId}?date=${dateIso}` as Route}
                              className="block rounded-[--radius-control] p-1 transition-colors duration-150 ease-out hover:bg-primary-soft motion-reduce:transition-none"
                            >
                              {content}
                            </Link>
                          ) : (
                            content
                          )
                        ) : (
                          <span className="text-fg-subtle">—</span>
                        )}
                      </div>
                    );
                  })}
                </React.Fragment>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TimetableError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  if (error instanceof ForbiddenError) {
    return (
      <EmptyState
        icon={<ShieldOff className="size-5" />}
        title="You don't have permission to view this"
        description="Viewing this timetable requires the academic.timetable:read permission."
        className="min-h-[24rem] justify-center"
      />
    );
  }
  return (
    <EmptyState
      icon={<WifiOff className="size-5" />}
      title="Couldn't load the timetable"
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
