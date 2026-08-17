'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { LogOut, Settings, User } from 'lucide-react';
import {
  Avatar,
  AvatarFallback,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@sms/ui';
import { authClient } from '../../lib/auth-client';
import { useSession } from '../providers/session-provider';

function initialsFor(name: string, email: string): string {
  const source = name.trim() || email;
  const parts = source.split(/\s+/).filter(Boolean);
  const first = parts[0];
  const second = parts[1];
  if (first && second) {
    return `${first[0] ?? ''}${second[0] ?? ''}`.toUpperCase();
  }
  return (first ?? source).slice(0, 2).toUpperCase();
}

export function UserMenu() {
  const { user } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [signingOut, setSigningOut] = React.useState(false);

  const handleSignOut = async () => {
    setSigningOut(true);
    await authClient.signOut();
    // Re-check the session rather than assuming success - it will now
    // correctly resolve to "signed out", and the (admin) layout's own guard
    // is the backstop if this redirect races anything.
    await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
    router.push('/sign-in');
  };

  // AppShell (and therefore UserMenu) only ever renders once the (admin)
  // layout has confirmed a session, so this is defensive rather than a real
  // loading state.
  if (!user) return null;

  const initials = initialsFor(user.name, user.email);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-full transition-opacity duration-150 hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-label="Open user menu"
          disabled={signingOut}
        >
          <Avatar>
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5 px-2 py-1.5">
          <span className="text-sm font-medium text-fg">{user.name}</span>
          <span className="text-xs font-normal text-fg-subtle">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <User className="size-4" />
          Profile
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Settings className="size-4" />
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => void handleSignOut()}
          disabled={signingOut}
          className="text-danger data-[highlighted]:bg-danger-soft data-[highlighted]:text-danger"
        >
          <LogOut className="size-4" />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
