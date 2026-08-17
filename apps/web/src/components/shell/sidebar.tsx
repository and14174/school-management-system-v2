'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronsLeft, ChevronsRight, GraduationCap } from 'lucide-react';
import {
  Button,
  ScrollArea,
  Sheet,
  SheetContent,
  SheetTitle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from '@sms/ui';
import { usePermissions } from '../../lib/permissions';
import { navGroups, type NavItem } from './nav-config';

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * An item with no `permission` is always shown - most of the app doesn't
 * have access-controlled backing yet. An item that declares one is hidden
 * (never disabled - there's nothing useful behind it for this user) until
 * permissions are known, and hidden again if they're unknown-on-error or
 * absent. Keeping gated items hidden while loading, rather than showing them
 * optimistically, is what avoids the "flash of an item that then vanishes"
 * the moment the real permission set arrives.
 */
function isNavItemVisible(
  item: NavItem,
  can: (key: string) => boolean,
  isLoading: boolean,
  isError: boolean,
): boolean {
  if (!item.permission) return true;
  if (isLoading || isError) return false;
  return can(item.permission);
}

function NavList({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const { can, isLoading, isError } = usePermissions();

  return (
    <nav className="flex flex-col gap-4">
      {navGroups.map((group) => {
        const visibleItems = group.items.filter((item) =>
          isNavItemVisible(item, can, isLoading, isError),
        );
        if (visibleItems.length === 0) return null;

        return (
          <div key={group.label} className="flex flex-col gap-1">
            {!collapsed ? (
              <p className="px-2.5 text-xs font-medium uppercase tracking-wide text-fg-subtle">
                {group.label}
              </p>
            ) : null}
            {visibleItems.map((item) => {
              const active = isActive(pathname, item.href);
              const link = (
                <Link
                  key={item.href}
                  href={item.href as Parameters<typeof Link>[0]['href']}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex h-control items-center gap-2.5 rounded-control px-2.5 text-sm font-medium',
                    'transition-colors duration-150 ease-out motion-reduce:transition-none',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                    collapsed && 'justify-center px-0',
                    active
                      ? 'bg-primary-soft text-primary-soft-fg'
                      : 'text-fg-muted hover:bg-surface-sunken hover:text-fg',
                  )}
                >
                  <item.icon className="size-4 shrink-0" />
                  {!collapsed ? <span className="truncate">{item.label}</span> : null}
                </Link>
              );

              if (!collapsed) return link;

              return (
                <Tooltip key={item.href}>
                  <TooltipTrigger asChild>{link}</TooltipTrigger>
                  {/* Radix's `side` is physical only (no RTL-aware variant upstream). */}
                  <TooltipContent side="right">{item.label}</TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

function BrandMark({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={cn('flex h-control-lg items-center gap-2 px-2.5', collapsed && 'justify-center px-0')}>
      <div className="flex size-7 shrink-0 items-center justify-center rounded-control bg-primary text-fg-on-accent">
        <GraduationCap className="size-4" />
      </div>
      {!collapsed ? <span className="truncate text-sm font-semibold text-fg">Greenwood SMS</span> : null}
    </div>
  );
}

export interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function Sidebar({ collapsed, onToggleCollapsed }: SidebarProps) {
  return (
    <aside
      className={cn(
        'sticky top-0 hidden h-dvh shrink-0 flex-col border-e border-border bg-surface lg:flex',
        'transition-[width] duration-180 ease-out motion-reduce:transition-none',
        collapsed ? 'w-16' : 'w-64',
      )}
    >
      <div className="flex flex-col gap-4 p-3">
        <BrandMark collapsed={collapsed} />
      </div>
      <ScrollArea className="flex-1 px-3">
        <NavList collapsed={collapsed} />
      </ScrollArea>
      <div className="border-t border-border p-3">
        <Button
          variant="ghost"
          size="icon"
          className="w-full"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronsRight className="rtl:rotate-180" /> : <ChevronsLeft className="rtl:rotate-180" />}
        </Button>
      </div>
    </aside>
  );
}

export interface MobileNavProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MobileNav({ open, onOpenChange }: MobileNavProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="start" className="w-72 p-0">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <div className="flex flex-col gap-4 p-3">
          <BrandMark collapsed={false} />
        </div>
        <ScrollArea className="h-[calc(100dvh-4rem)] px-3">
          <NavList collapsed={false} />
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
