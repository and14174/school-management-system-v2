'use client';

import * as React from 'react';
import { TooltipProvider } from '@sms/ui';
import { usePermissions } from '../../lib/permissions';
import { CommandPalette } from './command-palette';
import { ImpersonationBanner } from './impersonation-banner';
import { MobileNav, Sidebar } from './sidebar';
import { Topbar } from './topbar';

const COLLAPSED_STORAGE_KEY = 'sms:sidebar-collapsed';

export function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = React.useState(false);
  const [hydrated, setHydrated] = React.useState(false);
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const { impersonating } = usePermissions();

  React.useEffect(() => {
    const stored = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (stored !== null) setCollapsed(stored === 'true');
    setHydrated(true);
  }, []);

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  return (
    <TooltipProvider delayDuration={200}>
      <div className={hydrated ? undefined : 'invisible'}>
        <div className="flex min-h-dvh bg-canvas">
          <Sidebar collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
          <MobileNav open={mobileNavOpen} onOpenChange={setMobileNavOpen} />
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Banner + Topbar stick together as one unit so the banner is
                never covered by, and never overlaps, the top bar. */}
            <div className="sticky top-0 z-30 flex flex-col">
              {impersonating ? <ImpersonationBanner state={impersonating} /> : null}
              <Topbar
                onOpenMobileNav={() => setMobileNavOpen(true)}
                onOpenCommandPalette={() => setPaletteOpen(true)}
              />
            </div>
            <main className="flex-1 p-6">{children}</main>
          </div>
        </div>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </div>
    </TooltipProvider>
  );
}
