'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import { Search } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, cn } from '@sms/ui';
import { navGroups } from './nav-config';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter();

  React.useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onOpenChange(!open);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onOpenChange]);

  function go(href: string) {
    router.push(href as Parameters<typeof router.push>[0]);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showClose={false}
        className="max-w-lg gap-0 overflow-hidden p-0"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command
          label="Command palette"
          className="flex flex-col overflow-hidden bg-transparent text-fg"
        >
          <div className="flex items-center gap-2 border-b border-border px-4">
            <Search className="size-4 shrink-0 text-fg-subtle" />
            <Command.Input
              autoFocus
              placeholder="Search actions and destinations..."
              className={cn(
                'h-control-lg w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle',
              )}
            />
          </div>
          <Command.List className="max-h-80 overflow-y-auto p-2">
            <Command.Empty className="px-2 py-6 text-center text-sm text-fg-muted">
              No results found.
            </Command.Empty>
            {navGroups.map((group) => (
              <Command.Group
                key={group.label}
                heading={group.label}
                className={cn(
                  'px-2 py-1.5 text-xs font-medium text-fg-subtle',
                  '[&_[cmdk-group-items]]:mt-1 [&_[cmdk-group-items]]:text-sm [&_[cmdk-group-items]]:font-normal [&_[cmdk-group-items]]:text-fg',
                )}
              >
                {group.items.map((item) => (
                  <Command.Item
                    key={item.href}
                    value={item.label}
                    onSelect={() => go(item.href)}
                    className={cn(
                      'flex cursor-default items-center gap-2 rounded-[--radius-control] px-2 py-2',
                      'data-[selected=true]:bg-primary-soft data-[selected=true]:text-primary-soft-fg',
                    )}
                  >
                    <item.icon className="size-4 text-fg-subtle" />
                    {item.label}
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>
        </Command>
        <div className="flex items-center justify-end gap-1 border-t border-border px-4 py-2 text-xs text-fg-subtle">
          <kbd className="rounded-[--radius-control] border border-border bg-surface-sunken px-1.5 py-0.5">
            Esc
          </kbd>
          to close
        </div>
      </DialogContent>
    </Dialog>
  );
}
