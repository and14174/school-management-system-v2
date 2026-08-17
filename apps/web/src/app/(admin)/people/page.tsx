'use client';

import * as React from 'react';
import type { Route } from 'next';
import { useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Search, ShieldOff, Users, WifiOff, X } from 'lucide-react';
import {
  Button,
  EmptyState,
  Input,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@sms/ui';
import { fetchPeople, fetchScope, PERSON_ROLE_TYPES, type Person, type PersonRoleType } from '../../../lib/api';
import { ForbiddenError } from '../../../lib/http';
import { usePermissions } from '../../../lib/permissions';
import { ROLE_LABELS } from './format';
import { PeopleTable, PeopleTableSkeleton } from './people-table';
import { useDebouncedValue } from './use-debounced-value';

const PAGE_SIZE = 50;
const ALL_VALUE = 'all';

function readParam(searchParams: URLSearchParams, key: string): string {
  return searchParams.get(key) ?? '';
}

export default function PeopleDirectoryPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can, isLoading: permissionsLoading, isError: permissionsError } = usePermissions();

  const [searchInput, setSearchInput] = React.useState(() => readParam(searchParams, 'q'));
  const [role, setRole] = React.useState<PersonRoleType | ''>(
    () => (readParam(searchParams, 'role') as PersonRoleType) || '',
  );
  const [campusId, setCampusId] = React.useState(() => readParam(searchParams, 'campusId'));

  const debouncedQuery = useDebouncedValue(searchInput, 300);

  // Reflects the active filters in the URL (replace, not push - every
  // keystroke settling shouldn't spam browser history) so a filtered view is
  // linkable and survives a reload.
  React.useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedQuery) params.set('q', debouncedQuery);
    if (role) params.set('role', role);
    if (campusId) params.set('campusId', campusId);
    const query = params.toString();
    router.replace((query ? `/people?${query}` : '/people') as Route, { scroll: false });
  }, [debouncedQuery, role, campusId, router]);

  const scopeQuery = useQuery({
    queryKey: ['tenancy', 'scope'],
    queryFn: ({ signal }) => fetchScope(undefined, signal),
  });

  const peopleQuery = useInfiniteQuery({
    queryKey: ['people', 'search', { query: debouncedQuery, role, campusId }],
    queryFn: ({ pageParam, signal }) =>
      fetchPeople(
        {
          query: debouncedQuery || undefined,
          role: role || undefined,
          campusId: campusId || undefined,
          cursor: pageParam,
          limit: PAGE_SIZE,
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: can('people.person:read'),
  });

  const rows = React.useMemo<Person[]>(
    () => peopleQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [peopleQuery.data],
  );

  const hasActiveFilters = Boolean(debouncedQuery || role || campusId);

  function clearFilters() {
    setSearchInput('');
    setRole('');
    setCampusId('');
  }

  if (!permissionsLoading && !permissionsError && !can('people.person:read')) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="School" title="People" description="Every student, guardian, staff member and alum." />
        <EmptyState
          icon={<ShieldOff className="size-5" />}
          title="You don't have permission to view this"
          description="Viewing the people directory requires the people.person:read permission. Ask an administrator if you believe this is a mistake."
          className="min-h-[24rem] justify-center"
        />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-8.5rem)] flex-col gap-4">
      <PageHeader eyebrow="School" title="People" description="Every student, guardian, staff member and alum." />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search by name…"
            aria-label="Search people by name"
            className="ps-9"
          />
        </div>

        <Select value={role || ALL_VALUE} onValueChange={(value) => setRole(value === ALL_VALUE ? '' : (value as PersonRoleType))}>
          <SelectTrigger className="w-40" aria-label="Filter by role">
            <SelectValue placeholder="All roles" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All roles</SelectItem>
            {PERSON_ROLE_TYPES.map((roleType) => (
              <SelectItem key={roleType} value={roleType}>
                {ROLE_LABELS[roleType]}
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

        {hasActiveFilters ? (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="size-3.5" />
            Clear filters
          </Button>
        ) : null}

        <span className="ms-auto text-xs text-fg-subtle">
          {peopleQuery.isPending ? 'Loading…' : `${rows.length} loaded`}
        </span>
      </div>

      <div className="min-h-0 flex-1">
        {peopleQuery.isPending ? (
          <PeopleTableSkeleton />
        ) : peopleQuery.isError ? (
          <PeopleDirectoryError error={peopleQuery.error} onRetry={() => void peopleQuery.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Users className="size-5" />}
            title="No one matches these filters"
            description={
              hasActiveFilters
                ? 'Try a different name, or clear the role and campus filters.'
                : 'No people have been added to this school yet.'
            }
            action={
              hasActiveFilters ? (
                <Button variant="secondary" onClick={clearFilters}>
                  <X className="size-4" />
                  Clear filters
                </Button>
              ) : undefined
            }
            className="h-full min-h-[24rem] justify-center"
          />
        ) : (
          <PeopleTable
            rows={rows}
            onRowClick={(person) => router.push(`/people/${person.id}` as Route)}
            hasNextPage={Boolean(peopleQuery.hasNextPage)}
            isFetchingNextPage={peopleQuery.isFetchingNextPage}
            fetchNextPage={() => void peopleQuery.fetchNextPage()}
            className="h-full"
          />
        )}
      </div>
    </div>
  );
}

function PeopleDirectoryError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  if (error instanceof ForbiddenError) {
    return (
      <EmptyState
        icon={<ShieldOff className="size-5" />}
        title="You don't have permission to view this"
        description="Viewing the people directory requires the people.person:read permission. Ask an administrator if you believe this is a mistake."
        className="h-full min-h-[24rem] justify-center"
      />
    );
  }

  return (
    <EmptyState
      icon={<WifiOff className="size-5" />}
      title="Couldn't load people"
      description={error.message}
      action={<Button onClick={onRetry}>Retry</Button>}
      className="h-full min-h-[24rem] justify-center"
    />
  );
}
