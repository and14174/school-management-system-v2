'use client';

import { useQuery } from '@tanstack/react-query';
import { LayoutDashboard, RefreshCw, WifiOff } from 'lucide-react';
import { Button, EmptyState, Skeleton } from '@sms/ui';
import { fetchScope } from '../../../lib/api';
import { usePermissions } from '../../../lib/permissions';
import { permissionScope, type AcademicYearState } from '../../../lib/dashboard-api';
import { DashboardGreeting } from '../../../components/shell/greeting';
import { TeachingCard } from './teaching-card';
import { EnrolmentCard } from './enrolment-card';
import { SchedulingCard } from './scheduling-card';
import { AttendanceOversightCard } from './attendance-oversight-card';
import { CommunicationsCard } from './communications-card';
import { CorrectionsCard } from './corrections-card';
import { BillingCard } from './billing-card';

/**
 * The dashboard has no fixed shape. Every card below is gated on a real
 * `@sms/access` permission (and, where the underlying endpoint itself only
 * resolves for one particular scope, on that granted SCOPE - see
 * dashboard-api.ts's `permissionScope`) rather than on any role's name, so a
 * tenant that renames or invents roles gets a dashboard that still makes
 * sense: whatever a signed-in user can actually do determines what they see.
 *
 * Every figure rendered here comes from a real endpoint, read from its
 * controller under libs/*\/*\/src/api/*.controller.ts - see each card's own
 * top comment for which one. Nothing here is illustrative or approximated.
 * Cards this dashboard does NOT build, because no real endpoint backs them:
 *   - Attendance RATE / percentage present - `attendance.summary` reports
 *     one person's attendance, not a school- or campus-wide rate; no
 *     endpoint aggregates one.
 *   - "At-risk students" - no risk-model endpoint exists anywhere in the API.
 * The original page hardcoded these, plus "$48,210" of outstanding
 * balances; all three were omitted rather than replaced with a differently-
 * shaped guess. Outstanding balances now has a real endpoint behind it
 * (`GET /billing/summary` - see `BillingCard`) and is built below.
 */
export default function DashboardPage() {
  const { can, permissions, isLoading, isError, error, refetch } = usePermissions();

  const scopeQuery = useQuery({
    queryKey: ['tenancy', 'scope'],
    queryFn: ({ signal }) => fetchScope(undefined, signal),
    // The scope call itself needs no particular permission (see
    // ScopeController) - only fetched once we know who's asking is pointless
    // to gate further, but there is no point starting it before we at least
    // know permissions resolved without erroring.
    enabled: !isLoading && !isError,
  });

  const yearState: AcademicYearState = scopeQuery.isPending
    ? { status: 'loading' }
    : scopeQuery.isError
      ? { status: 'error', message: scopeQuery.error.message, retry: () => void scopeQuery.refetch() }
      : { status: 'ready', academicYearId: scopeQuery.data.current.academicYearId };
  const campuses = scopeQuery.data?.campuses ?? [];

  const cardApplicability = [
    permissionScope(permissions, 'academic.timetable:read') === 'section',
    can('enrollment.enrollment:read'),
    permissionScope(permissions, 'academic.timetable:read') === 'tenant',
    permissionScope(permissions, 'attendance.record:read') === 'tenant',
    can('people.student:read'),
    can('attendance.correction:approve'),
    permissionScope(permissions, 'billing.invoice:read') === 'tenant',
  ];
  const anyCardApplicable = cardApplicability.some(Boolean);

  return (
    <div className="flex flex-col gap-6">
      <DashboardGreeting />

      {isLoading ? (
        <DashboardCardsSkeleton />
      ) : isError ? (
        <EmptyState
          icon={<WifiOff className="size-5" />}
          title="Couldn't load your permissions"
          description={error?.message ?? 'Something went wrong loading what you can see here.'}
          action={
            <Button onClick={() => void refetch()}>
              <RefreshCw className="size-4" />
              Retry
            </Button>
          }
          className="min-h-[24rem] justify-center"
        />
      ) : !anyCardApplicable ? (
        <EmptyState
          icon={<LayoutDashboard className="size-5" />}
          title="Nothing to show here yet"
          description="Your role doesn't currently hold a permission this dashboard has a card for."
          className="min-h-[24rem] justify-center"
        />
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <TeachingCard />
          <EnrolmentCard yearState={yearState} />
          <SchedulingCard yearState={yearState} />
          <AttendanceOversightCard campuses={campuses} />
          <CommunicationsCard />
          <CorrectionsCard />
          <BillingCard />
        </div>
      )}
    </div>
  );
}

function DashboardCardsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="flex flex-col gap-3 rounded-card border border-border bg-surface p-5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-48" />
          <Skeleton className="h-11 w-full rounded-control" />
          <Skeleton className="h-11 w-full rounded-control" />
        </div>
      ))}
    </div>
  );
}
