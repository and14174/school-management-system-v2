'use client';

import { RefreshCw, WifiOff } from 'lucide-react';
import { Button, EmptyState, Skeleton } from '@sms/ui';

/** Shared inline loading rows for a dashboard card's body - distinct from the skeleton greeting/grid, sized for a card rather than a full page. */
export function CardSkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: count }).map((_, index) => (
        <Skeleton key={index} className="h-11 w-full rounded-control" />
      ))}
    </div>
  );
}

/**
 * Shared inline error state for a dashboard card. Deliberately NOT the same
 * component as a full-page EmptyState error (see attendance/page.tsx's
 * AttendanceLandingError) - a single card failing to load must never look
 * like the whole dashboard is down, and must never render as a "0" that a
 * genuine empty result would also show.
 */
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
