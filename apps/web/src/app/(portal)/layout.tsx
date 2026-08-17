'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Loader2 } from 'lucide-react';
import { useSession } from '../../components/providers/session-provider';
import { PortalShell } from './_components/portal-shell';

/**
 * Requires an authenticated session exactly like `(admin)/layout.tsx` -
 * same guard, same "never render the shell before the session is confirmed"
 * rule - but renders `PortalShell`, not the admin `AppShell`. A parent must
 * never see even a flash of the admin nav rail, and vice versa.
 */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isPending } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  React.useEffect(() => {
    if (!isPending && !isAuthenticated) {
      router.replace(`/sign-in?next=${encodeURIComponent(pathname)}` as Route);
    }
  }, [isPending, isAuthenticated, pathname, router]);

  if (isPending || !isAuthenticated) {
    return (
      <div
        className="flex min-h-dvh items-center justify-center bg-canvas"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="size-5 animate-spin text-fg-subtle motion-reduce:animate-none" />
        <span className="sr-only">Checking your session…</span>
      </div>
    );
  }

  return <PortalShell>{children}</PortalShell>;
}
