'use client';

import { RefreshCw, WifiOff } from 'lucide-react';
import { Button, EmptyState, Skeleton } from '@sms/ui';

/** Shared inline loading rows for a portal card's body. Same convention as (admin)/dashboard/card-states.tsx, duplicated locally rather than imported across the route-group boundary - see this repo's own established pattern for small per-route helpers. */
export function CardSkeletonRows({ count = 2 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: count }).map((_, index) => (
        <Skeleton key={index} className="h-11 w-full rounded-control" />
      ))}
    </div>
  );
}

/** Shared inline error state for a portal card - never a fabricated "0" standing in for a failed load. */
export function CardErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <EmptyState
      icon={<WifiOff className="size-5" />}
      title="Couldn't load this"
      description={message}
      action={
        <Button size="sm" variant="secondary" onClick={onRetry}>
          <RefreshCw className="size-3.5" />
          Retry
        </Button>
      }
      className="min-h-40 justify-center py-8"
    />
  );
}
