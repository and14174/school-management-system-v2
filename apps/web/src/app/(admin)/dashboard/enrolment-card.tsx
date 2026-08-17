'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, UserRoundCheck } from 'lucide-react';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@sms/ui';
import { ENROLLMENT_STATUSES } from '../../../lib/api';
import { usePermissions } from '../../../lib/permissions';
import { fetchEnrollmentCounts, permissionScope, type AcademicYearState } from '../../../lib/dashboard-api';
import { CardErrorState, CardSkeletonRows } from './card-states';
import { ENROLLMENT_STATUS_BADGE_VARIANT, ENROLLMENT_STATUS_LABELS } from './format';

/**
 * Real enrolment counts by status. No dedicated stats endpoint exists (see
 * dashboard-api.ts's fetchEnrollmentCounts) - it pages through GET /enrollment/
 * enrollments, which is already server-scoped per caller
 * (EnrollmentsController.applyEnrollmentConstraint), so a campus-scoped
 * grant would correctly only ever see and count its own campus's rows.
 * `enrollment.enrollment:read` is granted `tenant`-scope-only in the current
 * seed, so `scopeLabel` below reads "across the school" for every account
 * that can see this card today, but is derived from the real granted scope
 * rather than assumed.
 */
export function EnrolmentCard({ yearState }: { yearState: AcademicYearState }) {
  const { can, permissions } = usePermissions();
  const applicable = can('enrollment.enrollment:read');
  const scope = permissionScope(permissions, 'enrollment.enrollment:read');
  const scopeLabel = scope === 'campus' ? 'at your campus' : 'across the school';
  const academicYearId = yearState.status === 'ready' ? yearState.academicYearId : undefined;

  const query = useQuery({
    queryKey: ['dashboard', 'enrollment', 'counts', academicYearId],
    queryFn: ({ signal }) => fetchEnrollmentCounts({ academicYearId: academicYearId ?? undefined }, signal),
    enabled: applicable && typeof academicYearId === 'string',
  });

  if (!applicable) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Enrolment</CardTitle>
        <CardDescription>Current academic year, {scopeLabel}.</CardDescription>
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
        ) : (
          <>
            <p className="text-2xl font-semibold tabular-nums text-fg" data-tabular>
              {query.data!.total.toLocaleString()}
              <span className="ms-2 text-sm font-normal text-fg-muted">
                enrolment record{query.data!.total === 1 ? '' : 's'}
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              {ENROLLMENT_STATUSES.map((status) => (
                <Badge key={status} variant={ENROLLMENT_STATUS_BADGE_VARIANT[status]}>
                  {ENROLLMENT_STATUS_LABELS[status]} · {query.data!.byStatus[status]}
                </Badge>
              ))}
            </div>
            {query.data!.truncated ? (
              <p className="flex items-center gap-1.5 text-xs text-warning">
                <AlertTriangle className="size-3.5 shrink-0" />
                Showing a partial count - there are more records than this dashboard paged through.
              </p>
            ) : null}
            <Link href={'/enrollment' as Route} className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
              <UserRoundCheck className="size-3.5" />
              View enrolment →
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  );
}
