'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck2, CheckCircle2 } from 'lucide-react';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState } from '@sms/ui';
import { fetchUnmarkedSessions, type ScopeCampus } from '../../../lib/api';
import { usePermissions } from '../../../lib/permissions';
import { permissionScope } from '../../../lib/dashboard-api';
import { CardErrorState, CardSkeletonRows } from './card-states';
import { isSectionMeetingDay, todayIso } from './format';

/**
 * Unmarked sessions ACROSS THE CAMPUS(ES), for whoever can read attendance
 * tenant-wide - the oversight counterpart to TeachingCard's "mine only"
 * view. Same `GET /attendance/unmarked-sessions` endpoint as TeachingCard
 * and the /attendance page use, but gated on the caller's `attendance.
 * record:read` grant being `tenant`-scoped (School Administrator/Registrar
 * in the current seed) rather than `section` (Teacher) - a `section`-scoped
 * caller already gets their own version of this same data from TeachingCard,
 * and the server itself narrows this same endpoint down to just their
 * sections for them (AttendanceController.applyUnmarkedSessionsConstraint),
 * so showing both cards to a Teacher would just duplicate one list under two
 * headings.
 */
export function AttendanceOversightCard({ campuses }: { campuses: ScopeCampus[] }) {
  const { permissions } = usePermissions();
  const applicable = permissionScope(permissions, 'attendance.record:read') === 'tenant';
  const date = todayIso();

  const query = useQuery({
    queryKey: ['dashboard', 'attendance', 'unmarked', 'all', date],
    queryFn: ({ signal }) => fetchUnmarkedSessions({ date }, signal),
    enabled: applicable,
  });

  if (!applicable) return null;

  const campusName = (campusId: string) => campuses.find((c) => c.id === campusId)?.name ?? 'Unknown campus';
  const sessions = query.data ?? [];
  const byCampus = new Map<string, number>();
  for (const session of sessions) {
    byCampus.set(session.campusId, (byCampus.get(session.campusId) ?? 0) + 1);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Attendance oversight</CardTitle>
        <CardDescription>Sessions not yet marked today, across the school.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {query.isPending ? (
          <CardSkeletonRows count={3} />
        ) : query.isError ? (
          <CardErrorState message={query.error.message} onRetry={() => void query.refetch()} />
        ) : sessions.length === 0 ? (
          isSectionMeetingDay() ? (
            <div className="flex items-center gap-3 rounded-control border border-success/30 bg-success-soft px-3 py-2.5">
              <CheckCircle2 className="size-5 shrink-0 text-success" />
              <p className="text-sm font-medium text-success">Every session is marked for today.</p>
            </div>
          ) : (
            <EmptyState
              icon={<CalendarCheck2 className="size-5" />}
              title="No sessions scheduled today"
              description="Sections meet Monday, Wednesday and Friday - nothing is scheduled on other days."
              className="min-h-40 justify-center py-8"
            />
          )
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {[...byCampus.entries()].map(([campusId, count]) => (
                <Badge key={campusId} variant="warning">
                  {campusName(campusId)} · {count}
                </Badge>
              ))}
            </div>
            <p className="text-sm text-fg-muted">
              {sessions.length} session{sessions.length === 1 ? '' : 's'} still need
              {sessions.length === 1 ? 's' : ''} marking.
            </p>
            <Link href={'/attendance' as Route} className="text-xs font-medium text-primary hover:underline">
              Go to attendance →
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  );
}
