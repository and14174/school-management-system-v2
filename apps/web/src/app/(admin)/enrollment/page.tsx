'use client';

import * as React from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { RefreshCw, Repeat, Search, ShieldOff, UserRoundX, WifiOff, X } from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@sms/ui';
import {
  ENROLLMENT_STATUSES,
  fetchEnrollments,
  fetchGradeLevels,
  fetchScope,
  type Enrollment,
  type EnrollmentStatus,
} from '../../../lib/api';
import { ForbiddenError } from '../../../lib/http';
import { usePermissions } from '../../../lib/permissions';
import { ENROLLMENT_STATUS_BADGE_VARIANT, ENROLLMENT_STATUS_LABELS, formatDateOnly } from './format';
import { PersonNameCell } from './person-name-cell';

const PAGE_SIZE = 50;
const ALL_VALUE = 'all';

function readParam(searchParams: URLSearchParams, key: string): string {
  return searchParams.get(key) ?? '';
}

export default function EnrollmentListPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can, isLoading: permissionsLoading, isError: permissionsError } = usePermissions();

  const [searchInput, setSearchInput] = React.useState(() => readParam(searchParams, 'q'));
  const [academicYearId, setAcademicYearId] = React.useState(() => readParam(searchParams, 'academicYearId'));
  const [campusId, setCampusId] = React.useState(() => readParam(searchParams, 'campusId'));
  const [gradeLevelId, setGradeLevelId] = React.useState(() => readParam(searchParams, 'gradeLevelId'));
  const [status, setStatus] = React.useState<EnrollmentStatus | ''>(
    () => (readParam(searchParams, 'status') as EnrollmentStatus) || '',
  );

  React.useEffect(() => {
    const params = new URLSearchParams();
    if (searchInput) params.set('q', searchInput);
    if (academicYearId) params.set('academicYearId', academicYearId);
    if (campusId) params.set('campusId', campusId);
    if (gradeLevelId) params.set('gradeLevelId', gradeLevelId);
    if (status) params.set('status', status);
    const query = params.toString();
    router.replace((query ? `/enrollment?${query}` : '/enrollment') as Route, { scroll: false });
    // `router` is stable across renders (Next's useRouter identity), so it's
    // deliberately left out of the dependency list here.
  }, [searchInput, academicYearId, campusId, gradeLevelId, status]);

  const scopeQuery = useQuery({ queryKey: ['tenancy', 'scope'], queryFn: ({ signal }) => fetchScope(undefined, signal) });
  const gradeLevelsQuery = useQuery({
    queryKey: ['academic', 'grade-levels'],
    queryFn: ({ signal }) => fetchGradeLevels(signal),
    retry: false,
  });

  const gradeLevels = React.useMemo(
    () => [...(gradeLevelsQuery.data ?? [])].sort((a, b) => a.sequence - b.sequence),
    [gradeLevelsQuery.data],
  );
  const gradeLevelNameById = React.useMemo(
    () => new Map(gradeLevels.map((gradeLevel) => [gradeLevel.id, gradeLevel.name])),
    [gradeLevels],
  );
  const campusNameById = React.useMemo(
    () => new Map((scopeQuery.data?.campuses ?? []).map((campus) => [campus.id, campus.name])),
    [scopeQuery.data],
  );
  const academicYearNameById = React.useMemo(
    () => new Map((scopeQuery.data?.academicYears ?? []).map((year) => [year.id, year.name])),
    [scopeQuery.data],
  );

  const enrollmentsQuery = useInfiniteQuery({
    queryKey: ['enrollment', 'list', { query: searchInput, academicYearId, campusId, gradeLevelId, status }],
    queryFn: ({ pageParam, signal }) =>
      fetchEnrollments(
        {
          query: searchInput || undefined,
          academicYearId: academicYearId || undefined,
          campusId: campusId || undefined,
          gradeLevelId: gradeLevelId || undefined,
          status: status || undefined,
          cursor: pageParam,
          limit: PAGE_SIZE,
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: can('enrollment.enrollment:read'),
  });

  const rows = React.useMemo<Enrollment[]>(
    () => enrollmentsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [enrollmentsQuery.data],
  );

  const hasActiveFilters = Boolean(searchInput || academicYearId || campusId || gradeLevelId || status);

  function clearFilters() {
    setSearchInput('');
    setAcademicYearId('');
    setCampusId('');
    setGradeLevelId('');
    setStatus('');
  }

  if (!permissionsLoading && !permissionsError && !can('enrollment.enrollment:read')) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="School" title="Enrollment" description="Every student's enrolment record, by academic year and campus." />
        <EmptyState
          icon={<ShieldOff className="size-5" />}
          title="You don't have permission to view this"
          description="Viewing enrollment requires the enrollment.enrollment:read permission. Ask an administrator if you believe this is a mistake."
          className="min-h-[24rem] justify-center"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="School"
        title="Enrollment"
        description="Every student's enrolment record, by academic year and campus."
        actions={
          can('enrollment.rollover:run') ? (
            <Button variant="secondary" asChild>
              <Link href={'/enrollment/rollover' as Route}>
                <Repeat className="size-4" />
                Year rollover
              </Link>
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search by student name or number…"
            aria-label="Search enrollments"
            className="ps-9"
          />
        </div>

        <Select
          value={academicYearId || ALL_VALUE}
          onValueChange={(value) => setAcademicYearId(value === ALL_VALUE ? '' : value)}
        >
          <SelectTrigger className="w-44" aria-label="Filter by academic year">
            <SelectValue placeholder="All years" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All years</SelectItem>
            {(scopeQuery.data?.academicYears ?? []).map((year) => (
              <SelectItem key={year.id} value={year.id}>
                {year.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={campusId || ALL_VALUE} onValueChange={(value) => setCampusId(value === ALL_VALUE ? '' : value)}>
          <SelectTrigger className="w-44" aria-label="Filter by campus">
            <SelectValue placeholder="All campuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All campuses</SelectItem>
            {(scopeQuery.data?.campuses ?? []).map((campus) => (
              <SelectItem key={campus.id} value={campus.id}>
                {campus.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {!gradeLevelsQuery.isError ? (
          <Select
            value={gradeLevelId || ALL_VALUE}
            onValueChange={(value) => setGradeLevelId(value === ALL_VALUE ? '' : value)}
          >
            <SelectTrigger className="w-40" aria-label="Filter by grade level">
              <SelectValue placeholder="All grades" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_VALUE}>All grades</SelectItem>
              {gradeLevels.map((gradeLevel) => (
                <SelectItem key={gradeLevel.id} value={gradeLevel.id}>
                  {gradeLevel.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <Select value={status || ALL_VALUE} onValueChange={(value) => setStatus(value === ALL_VALUE ? '' : (value as EnrollmentStatus))}>
          <SelectTrigger className="w-40" aria-label="Filter by status">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All statuses</SelectItem>
            {ENROLLMENT_STATUSES.map((value) => (
              <SelectItem key={value} value={value}>
                {ENROLLMENT_STATUS_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {hasActiveFilters ? (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="size-3.5" />
            Clear filters
          </Button>
        ) : null}
      </div>

      {enrollmentsQuery.isPending ? (
        <EnrollmentListSkeleton />
      ) : enrollmentsQuery.isError ? (
        <EnrollmentListError error={enrollmentsQuery.error} onRetry={() => void enrollmentsQuery.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<UserRoundX className="size-5" />}
          title="No enrollments match these filters"
          description={
            hasActiveFilters ? 'Try a different name or number, or clear the filters.' : 'No one is enrolled yet.'
          }
          action={
            hasActiveFilters ? (
              <Button variant="secondary" onClick={clearFilters}>
                <X className="size-4" />
                Clear filters
              </Button>
            ) : undefined
          }
          className="min-h-[24rem] justify-center"
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Student</TableHead>
                <TableHead>Student #</TableHead>
                <TableHead>Grade level</TableHead>
                <TableHead>Campus</TableHead>
                <TableHead>Academic year</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Enrolled on</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((enrollment) => (
                <TableRow
                  key={enrollment.id}
                  className="cursor-pointer"
                  onClick={() => router.push(`/enrollment/${enrollment.id}` as Route)}
                >
                  <TableCell>
                    <PersonNameCell personId={enrollment.personId} />
                  </TableCell>
                  <TableCell data-tabular className="text-fg-muted">
                    {enrollment.studentNumber ?? '—'}
                  </TableCell>
                  <TableCell className="text-fg-muted">
                    {gradeLevelNameById.get(enrollment.gradeLevelId) ?? enrollment.gradeLevelId}
                  </TableCell>
                  <TableCell className="text-fg-muted">
                    {campusNameById.get(enrollment.campusId) ?? enrollment.campusId}
                  </TableCell>
                  <TableCell className="text-fg-muted">
                    {academicYearNameById.get(enrollment.academicYearId) ?? enrollment.academicYearId}
                  </TableCell>
                  <TableCell>
                    <Badge variant={ENROLLMENT_STATUS_BADGE_VARIANT[enrollment.status]}>
                      {ENROLLMENT_STATUS_LABELS[enrollment.status]}
                    </Badge>
                  </TableCell>
                  <TableCell data-tabular className="text-fg-muted">
                    {formatDateOnly(enrollment.enrolledOn)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {enrollmentsQuery.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                onClick={() => void enrollmentsQuery.fetchNextPage()}
                loading={enrollmentsQuery.isFetchingNextPage}
              >
                Load more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function EnrollmentListSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-card border border-border p-4">
      {Array.from({ length: 8 }).map((_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}

function EnrollmentListError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  if (error instanceof ForbiddenError) {
    return (
      <EmptyState
        icon={<ShieldOff className="size-5" />}
        title="You don't have permission to view this"
        description="Viewing enrollment requires the enrollment.enrollment:read permission."
        className="min-h-[24rem] justify-center"
      />
    );
  }
  return (
    <EmptyState
      icon={<WifiOff className="size-5" />}
      title="Couldn't load enrollments"
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
