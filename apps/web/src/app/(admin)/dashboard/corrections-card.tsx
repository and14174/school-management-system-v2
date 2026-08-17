'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ClipboardEdit } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@sms/ui';
import { usePermissions } from '../../../lib/permissions';
import { fetchPendingCorrections } from '../../../lib/dashboard-api';
import { CardErrorState, CardSkeletonRows } from './card-states';

/**
 * Attendance corrections awaiting approval - not one of the bullet-pointed
 * cards in the task brief, but a real endpoint (`GET /attendance/
 * corrections?status=pending`) gated on a real, distinct permission
 * (`attendance.correction:approve`, never granted to Teacher - see
 * @sms/access's seed.ts) that otherwise has no home anywhere in the admin
 * shell yet. Exactly the "anything else you find a real endpoint for" case
 * the brief calls out.
 */
export function CorrectionsCard() {
  const { can } = usePermissions();
  const applicable = can('attendance.correction:approve');

  const query = useQuery({
    queryKey: ['dashboard', 'attendance', 'corrections', 'pending'],
    queryFn: ({ signal }) => fetchPendingCorrections(signal),
    enabled: applicable,
  });

  if (!applicable) return null;

  const pending = query.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Attendance corrections</CardTitle>
        <CardDescription>Requests awaiting your approval.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {query.isPending ? (
          <CardSkeletonRows count={1} />
        ) : query.isError ? (
          <CardErrorState message={query.error.message} onRetry={() => void query.refetch()} />
        ) : pending.length === 0 ? (
          <div className="flex items-center gap-3 rounded-control border border-success/30 bg-success-soft px-3 py-2.5">
            <CheckCircle2 className="size-5 shrink-0 text-success" />
            <p className="text-sm font-medium text-success">No corrections awaiting approval.</p>
          </div>
        ) : (
          <div className="flex items-center gap-4">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-warning-soft text-warning">
              <ClipboardEdit className="size-4" />
            </div>
            <p className="text-sm text-fg">
              <span className="font-semibold tabular-nums" data-tabular>
                {pending.length}
              </span>{' '}
              correction{pending.length === 1 ? '' : 's'} waiting on a decision.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
