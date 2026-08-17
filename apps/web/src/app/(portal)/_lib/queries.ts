'use client';

import { useQuery } from '@tanstack/react-query';
import type { Person } from '../../../lib/api';
import { ForbiddenError } from '../../../lib/http';
import { fetchMyDependants, fetchMyPerson, fetchUnreadCounts, type Dependant, type UnreadCounts } from '../../../lib/portal-api';

/** GET /people/me - the caller's own linked person record. Shared by every portal screen that needs "who am I". */
export function useMyPerson() {
  return useQuery<Person, Error>({
    queryKey: ['portal', 'people', 'me'],
    queryFn: ({ signal }) => fetchMyPerson(signal),
    staleTime: 60_000,
  });
}

/** GET /people/me/dependants - the caller's children, if any. Empty (not an error) for a caller with no dependants, e.g. a student account. */
export function useMyDependants() {
  return useQuery<Dependant[], Error>({
    queryKey: ['portal', 'people', 'me', 'dependants'],
    queryFn: ({ signal }) => fetchMyDependants(signal),
    staleTime: 60_000,
  });
}

/**
 * GET /communications/unread-counts. Throws `ForbiddenError` for a caller
 * with no linked person at all - a real, distinct outcome from "zero
 * unread" (see portal-api.ts's own comment on `fetchUnreadCounts`), so this
 * stops retrying on that specific failure rather than hammering an endpoint
 * that will never succeed for this account.
 */
export function usePortalUnreadCounts() {
  return useQuery<UnreadCounts, Error>({
    queryKey: ['portal', 'communications', 'unread-counts'],
    queryFn: ({ signal }) => fetchUnreadCounts(signal),
    staleTime: 15_000,
    retry: (failureCount, error) => !(error instanceof ForbiddenError) && failureCount < 2,
  });
}
