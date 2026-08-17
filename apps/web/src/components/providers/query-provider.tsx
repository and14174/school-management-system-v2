'use client';

import * as React from 'react';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ForbiddenError, UnauthorizedError } from '../../lib/http';
import { redirectToSignIn } from '../../lib/safe-redirect';

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({
          onError: (error) => {
            // A session that expired mid-use should never leave the user
            // staring at a broken screen - send them back to sign-in. The
            // /auth/me check itself resolves to "signed out" instead of
            // throwing on 401 (see fetchMe), so this only fires for calls
            // made from screens that assumed an active session, e.g. the
            // tenancy scope switcher.
            if (error instanceof UnauthorizedError) {
              redirectToSignIn();
            }
          },
        }),
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            staleTime: 30_000,
            retry: (failureCount, error) =>
              error instanceof UnauthorizedError || error instanceof ForbiddenError
                ? false
                : failureCount < 1,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
