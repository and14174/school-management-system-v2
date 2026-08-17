'use client';

import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@sms/ui';
import { fetchPerson, personDetailQueryKey } from '../../../lib/api';

/**
 * `Enrollment` (and `RolloverOutcome`) carry only a `personId`, never a
 * name - same gap `AlertIndicator` documents for the people directory. Each
 * mounted row does its own small `GET /people/:id`, sharing a query key with
 * the person's own profile page so opening it afterwards is warm from
 * cache.
 */
export function PersonNameCell({ personId }: { personId: string }) {
  const { data, isPending, isError } = useQuery({
    queryKey: personDetailQueryKey(personId),
    queryFn: ({ signal }) => fetchPerson(personId, signal),
    staleTime: 60_000,
  });

  if (isPending) return <Skeleton className="h-4 w-32" />;
  if (isError || !data) return <span className="text-sm text-fg-subtle">Unknown person</span>;

  const shownName = data.preferredName?.trim() || `${data.givenName} ${data.familyName}`;
  return <span className="text-sm font-medium text-fg">{shownName}</span>;
}
