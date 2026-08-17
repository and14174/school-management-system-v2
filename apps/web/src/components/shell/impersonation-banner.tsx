'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@sms/ui';
import { stopImpersonation, type AccessImpersonationState } from '../../lib/api';
import { ACCESS_ME_QUERY_KEY } from '../../lib/permissions';
import { useSession } from '../providers/session-provider';

/**
 * Persistent, unmissable strip across the top of the app shell whenever
 * /access/me reports an active impersonation - acting as someone else is a
 * privileged, audited action, and it must never be mistakable for normal
 * chrome or something the user could forget they're in the middle of.
 *
 * Mounted by AppShell inside the same sticky wrapper as Topbar, above it, so
 * it stays visible while scrolling without overlapping the top bar.
 */
export function ImpersonationBanner({ state }: { state: AccessImpersonationState }) {
  const { user } = useSession();
  const queryClient = useQueryClient();

  const stopMutation = useMutation({
    mutationFn: () => stopImpersonation(),
    onSettled: () => {
      // Refetch rather than clearing the banner optimistically - the server
      // is the source of truth for whether impersonation actually ended.
      void queryClient.invalidateQueries({ queryKey: ACCESS_ME_QUERY_KEY });
    },
  });

  const startedLabel = React.useMemo(() => {
    const startedAt = new Date(state.startedAt);
    if (Number.isNaN(startedAt.getTime())) return null;
    return formatDistanceToNowStrict(startedAt, { addSuffix: true });
  }, [state.startedAt]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-danger bg-danger-soft px-4 py-2.5 text-sm"
    >
      <ShieldAlert className="size-4 shrink-0 text-danger" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold text-fg">Impersonating {state.targetName}</span>
        <span className="text-fg-muted">
          {' '}
          — started by {user?.name ?? 'you'}
          {startedLabel ? ` ${startedLabel}` : ''}. Reason: {state.reason}
        </span>
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => stopMutation.mutate()}
        loading={stopMutation.isPending}
      >
        Stop impersonating
      </Button>
      {stopMutation.isError ? (
        <span className="basis-full text-xs text-danger">
          Couldn't stop impersonating. Please try again.
        </span>
      ) : null}
    </div>
  );
}
