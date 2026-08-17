'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Loader2 } from 'lucide-react';
import { useSession } from '../components/providers/session-provider';
import { usePermissions } from '../lib/permissions';

/**
 * Scopes that only ever apply to STAFF acting on other people's records
 * ('tenant'/'campus'/'section' - see `@sms/access`'s `PermissionScope`).
 * 'own' and 'dependants' are what a parent/student holds and never imply
 * admin capability, so they are deliberately excluded here.
 *
 * Never a role-name check (roles are tenant-configurable rows a school can
 * rename freely - see this task's own routing rule) - holding ANY permission
 * at one of these scopes is what "is staff" means.
 */
const STAFF_SCOPES = new Set(['tenant', 'campus', 'section']);

function FullScreenSpinner() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas" role="status" aria-live="polite">
      <Loader2 className="size-5 animate-spin text-fg-subtle motion-reduce:animate-none" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/**
 * Mounted only once a session is confirmed authenticated (see `RootPage`
 * below) - `usePermissions()` calls `GET /access/me`, which needs a real
 * session to answer meaningfully, so this never fires while signed out.
 */
function AuthenticatedRouter() {
  const router = useRouter();
  const { permissions, isLoading, isError } = usePermissions();

  React.useEffect(() => {
    if (isLoading) return;
    // A permissions fetch failure fails CLOSED to the portal - the
    // least-privileged destination - rather than guessing at admin access.
    const isStaff = !isError && permissions.some((permission) => STAFF_SCOPES.has(permission.scope));
    router.replace((isStaff ? '/dashboard' : '/portal') as Route);
  }, [isLoading, isError, permissions, router]);

  return <FullScreenSpinner />;
}

export default function RootPage() {
  const { isAuthenticated, isPending } = useSession();
  const router = useRouter();

  React.useEffect(() => {
    if (!isPending && !isAuthenticated) {
      router.replace('/sign-in' as Route);
    }
  }, [isPending, isAuthenticated, router]);

  // Never render (or pick) a destination for a single frame before the
  // session is confirmed - same "no flash" rule (admin)/layout.tsx follows.
  if (isPending || !isAuthenticated) {
    return <FullScreenSpinner />;
  }

  return <AuthenticatedRouter />;
}
