'use client';

import * as React from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  fetchMe,
  type AuthMembership,
  type AuthMeResponse,
  type AuthTenant,
  type AuthUser,
} from '../../lib/auth-client';

export interface SessionContextValue {
  user: AuthUser | null;
  activeTenant: AuthTenant | null;
  memberships: AuthMembership[];
  twoFactorEnabled: boolean;
  /** True until the first /auth/me check resolves - the loading state route guards wait on. */
  isPending: boolean;
  isAuthenticated: boolean;
  /** Set only for unexpected failures (API unreachable, 5xx) - never for "signed out". */
  error: Error | null;
  refetch: UseQueryResult<AuthMeResponse | null, Error>['refetch'];
}

const SessionContext = React.createContext<SessionContextValue | undefined>(undefined);

/**
 * Fetches GET /api/v1/auth/me once and exposes the result - current user,
 * active tenant, tenant memberships - through context. Mounted at the root
 * layout so both the public auth screens and the protected admin shell share
 * one query rather than each re-fetching the session independently.
 */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: ({ signal }) => fetchMe(signal),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  const value = React.useMemo<SessionContextValue>(
    () => ({
      user: data?.user ?? null,
      activeTenant: data?.activeTenant ?? null,
      memberships: data?.memberships ?? [],
      twoFactorEnabled: data?.twoFactorEnabled ?? false,
      isPending,
      isAuthenticated: Boolean(data?.user),
      error: error as Error | null,
      refetch,
    }),
    [data, isPending, error, refetch],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = React.useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return ctx;
}
