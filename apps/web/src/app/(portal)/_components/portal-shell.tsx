'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Route } from 'next';
import { GraduationCap, Home, MessageSquare, Settings as SettingsIcon } from 'lucide-react';
import { Badge, cn } from '@sms/ui';
import { ThemeToggle } from '../../../components/shell/theme-toggle';
import { UserMenu } from '../../../components/shell/user-menu';
import { usePortalUnreadCounts } from '../_lib/queries';

interface PortalNavItem {
  label: string;
  /** Kept as plain `string` (not `Route`) so it can be compared/iterated freely - only cast to `Route` at the `<Link>` usage site below, same as `Sidebar`'s `NavItem` in the admin shell. */
  href: string;
  icon: typeof Home;
}

const NAV_ITEMS: PortalNavItem[] = [
  { label: 'Home', href: '/portal', icon: Home },
  { label: 'Messages', href: '/portal/messages', icon: MessageSquare },
  { label: 'Settings', href: '/portal/settings', icon: SettingsIcon },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/portal') return pathname === '/portal';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Total unread (announcements + threads) - a single calm number on the Messages tab rather than two separate badges, matching this shell's "calm and obvious" brief. */
function MessagesBadge() {
  const { data, isError } = usePortalUnreadCounts();
  if (isError || !data) return null;
  const total = data.unreadAnnouncements + data.unreadThreads;
  if (total === 0) return null;
  return (
    <Badge variant="info" className="ms-0.5">
      {total}
    </Badge>
  );
}

/**
 * The parent/student portal's own top-level chrome - deliberately NOT the
 * admin `AppShell`/`Sidebar` (a parent has three destinations total, not a
 * dense admin nav rail). A single sticky top bar, centred content column,
 * and the same `UserMenu`/`ThemeToggle` the admin shell uses so sign-out and
 * theme behave identically everywhere in the app.
 */
export function PortalShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur-sm">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-1 px-4">
          <Link
            href={'/portal' as Route}
            className="me-2 flex shrink-0 items-center gap-2 rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-control bg-primary text-fg-on-accent">
              <GraduationCap className="size-4" />
            </span>
            <span className="hidden text-sm font-semibold text-fg sm:inline">Greenwood SMS</span>
          </Link>

          <nav className="flex items-center gap-1 overflow-x-auto" aria-label="Portal">
            {NAV_ITEMS.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href as Route}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex h-control shrink-0 items-center gap-1.5 rounded-control px-3 text-sm font-medium',
                    'transition-colors duration-150 ease-out motion-reduce:transition-none',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                    active ? 'bg-primary-soft text-primary-soft-fg' : 'text-fg-muted hover:bg-surface-sunken hover:text-fg',
                  )}
                >
                  <item.icon className="size-4" />
                  <span>{item.label}</span>
                  {item.href === '/portal/messages' ? <MessagesBadge /> : null}
                </Link>
              );
            })}
          </nav>

          <div className="ms-auto flex shrink-0 items-center gap-1.5">
            <ThemeToggle />
            <UserMenu />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:py-8">{children}</main>
    </div>
  );
}
