'use client';

import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@sms/ui';
import { fetchPerson, personDetailQueryKey } from '../../../lib/api';

/**
 * The directory's critical-alert indicator. `GET /people` (the search/list
 * endpoint) never returns `hasMedicalAlerts`/`hasSafeguardingAlerts` - those
 * only exist on `GET /people/:id`. Each mounted row therefore does its own
 * small `GET /people/:id` fetch for exactly this flag; because only the
 * virtualized window of rows is ever mounted, this stays bounded (tens of
 * requests, not thousands) no matter how large the directory grows. It shares
 * a query key with the detail page's own fetch, so opening a profile the
 * directory already rendered is served from cache instead of refetching.
 *
 * Renders NOTHING for "false" and for "masked/unknown" alike - both cases
 * must never render as an assertion of "no alerts" (masked truly doesn't
 * know). Only a confirmed `true` ever shows the icon. This is deliberately
 * one-directional: it can under-warn (nothing shown while loading, or when
 * masked) but never over-asserts safety.
 */
export function AlertIndicator({ personId }: { personId: string }) {
  const { data } = useQuery({
    queryKey: personDetailQueryKey(personId),
    queryFn: ({ signal }) => fetchPerson(personId, signal),
    staleTime: 60_000,
  });

  const hasAlert = data?.hasMedicalAlerts === true || data?.hasSafeguardingAlerts === true;
  if (!hasAlert) {
    return <span className="sr-only">No alert flagged</span>;
  }

  const parts: string[] = [];
  if (data?.hasMedicalAlerts) parts.push('medical');
  if (data?.hasSafeguardingAlerts) parts.push('safeguarding');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex size-6 items-center justify-center rounded-full bg-danger-soft text-danger"
          role="img"
          aria-label={`Has ${parts.join(' and ')} alerts on file`}
        >
          <ShieldAlert className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent>Has {parts.join(' and ')} alerts on file — open profile for details</TooltipContent>
    </Tooltip>
  );
}
