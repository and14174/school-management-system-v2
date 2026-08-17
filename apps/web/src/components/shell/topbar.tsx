'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { Menu, School, Search } from 'lucide-react';
import { Button } from '@sms/ui';
import { usePermissions } from '../../lib/permissions';
import { ScopeSwitcher } from './scope-switcher';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';

export interface TopbarProps {
  onOpenMobileNav: () => void;
  onOpenCommandPalette: () => void;
}

/**
 * `own`/`dependants` are the two scopes a parent or student holds
 * `people.student:read` at (see `@sms/access`'s seed.ts) - never `tenant`/
 * `campus`/`section`, which a plain staff grant uses. Checking for these
 * (rather than any role name) is what lets a teacher who is ALSO a parent
 * see this link: their `people.student:read` grant from the Teacher role is
 * `section`-scoped, but a second grant from holding a guardian link would
 * add a `dependants`-scoped one alongside it - this only needs to find ONE
 * such grant among however many the account holds.
 */
const PORTAL_ELIGIBLE_SCOPES = new Set(['own', 'dependants']);

function useHasFamilyPortal(): boolean {
  const { permissions } = usePermissions();
  return permissions.some(
    (permission) => permission.key === 'people.student:read' && PORTAL_ELIGIBLE_SCOPES.has(permission.scope),
  );
}

export function Topbar({ onOpenMobileNav, onOpenCommandPalette }: TopbarProps) {
  const hasFamilyPortal = useHasFamilyPortal();

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur-sm">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={onOpenMobileNav}
        aria-label="Open navigation"
      >
        <Menu />
      </Button>

      <ScopeSwitcher />

      <button
        type="button"
        onClick={onOpenCommandPalette}
        className="ms-2 hidden h-control flex-1 max-w-sm items-center gap-2 rounded-control border border-border bg-surface-sunken px-3 text-sm text-fg-subtle transition-colors duration-150 ease-out hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:flex"
      >
        <Search className="size-4 shrink-0" />
        <span className="flex-1 text-start">Search...</span>
        <kbd className="rounded-[--radius-control] border border-border bg-surface px-1.5 py-0.5 text-xs text-fg-subtle">
          ⌘K
        </kbd>
      </button>

      <div className="ms-auto flex items-center gap-1.5">
        {hasFamilyPortal ? (
          <Button asChild variant="ghost" size="sm" className="hidden lg:inline-flex">
            <Link href={'/portal' as Route}>
              <School className="size-4" />
              Family portal
            </Link>
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="sm:hidden"
          onClick={onOpenCommandPalette}
          aria-label="Open command palette"
        >
          <Search />
        </Button>
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
