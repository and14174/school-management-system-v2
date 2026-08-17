'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Loader2 } from 'lucide-react';
import { AppShell } from '../../components/shell/app-shell';
import { useSession } from '../../components/providers/session-provider';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isPending } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  React.useEffect(() => {
    if (!isPending && !isAuthenticated) {
      router.replace(`/sign-in?next=${encodeURIComponent(pathname)}` as Route);
    }
  }, [isPending, isAuthenticated, pathname, router]);

  // Covers both "still checking" and "known signed-out, redirect under way" -
  // the dashboard shell must never render, even for a single frame, before
  // the session is confirmed.
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

  return <AppShell>{children}</AppShell>;
}
