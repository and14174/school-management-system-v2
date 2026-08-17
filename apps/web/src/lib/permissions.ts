'use client';

import * as React from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { fetchAccessMe, type AccessImpersonationState, type AccessMeResponse } from './api';

export const ACCESS_ME_QUERY_KEY = ['access', 'me'] as const;

/**
 * Fetches GET /api/v1/access/me. Kept separate from usePermissions() so
 * components that only care about, say, `impersonating` (the shell banner)
 * don't have to know about the `can()` helper - they still share one
 * underlying request/cache entry via the query key.
 */
export function useAccessMe(): UseQueryResult<AccessMeResponse, Error> {
  return useQuery({
    queryKey: ACCESS_ME_QUERY_KEY,
    queryFn: ({ signal }) => fetchAccessMe(signal),
    staleTime: 30_000,
  });
}

export interface UsePermissionsResult {
  permissions: AccessMeResponse['permissions'];
  roles: AccessMeResponse['roles'];
  impersonating: AccessImpersonationState | null;
  /** True once /access/me has resolved, successfully or not - see isError for which. */
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: UseQueryResult<AccessMeResponse, Error>['refetch'];
  /**
   * Whether the current user holds a permission key (e.g. "people.student:read").
   * This is a UX convenience only, NOT the security boundary: it decides what
   * this client bothers to render, nothing more. The API re-checks every
   * permission on every request server-side, so a user who forces hidden UI
   * back open (or calls the API directly) still gets exactly what the server
   * allows - never more.
   */
  can: (key: string) => boolean;
}

export function usePermissions(): UsePermissionsResult {
  const query = useAccessMe();
  const { data, isLoading, isError, error, refetch } = query;

  const permissionSet = React.useMemo(
    () => new Set((data?.permissions ?? []).map((permission) => permission.key)),
    [data],
  );

  const can = React.useCallback((key: string) => permissionSet.has(key), [permissionSet]);

  return {
    permissions: data?.permissions ?? [],
    roles: data?.roles ?? [],
    impersonating: data?.impersonating ?? null,
    isLoading,
    isError,
    error: error ?? null,
    refetch,
    can,
  };
}
