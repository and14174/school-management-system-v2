import * as React from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { cn } from '../lib/cn';
import { Card } from './card';

export interface StatTileProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Positive numbers render as a rising, favourable delta; negative as falling. */
  delta?: number;
  deltaLabel?: string;
  /** Set when a rising delta is actually unfavourable (e.g. "absences"). */
  invertDeltaTone?: boolean;
  icon?: React.ReactNode;
  sparkline?: React.ReactNode;
}

export function StatTile({
  label,
  value,
  delta,
  deltaLabel,
  invertDeltaTone = false,
  icon,
  sparkline,
  className,
  ...props
}: StatTileProps) {
  const hasDelta = typeof delta === 'number' && Number.isFinite(delta);
  const isRising = hasDelta && delta > 0;
  const isFalling = hasDelta && delta < 0;
  const favourable = invertDeltaTone ? isFalling : isRising;
  const unfavourable = invertDeltaTone ? isRising : isFalling;

  return (
    <Card className={cn('flex flex-col gap-3 p-5', className)} {...props}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-fg-muted">{label}</p>
        {icon ? <div className="text-fg-subtle">{icon}</div> : null}
      </div>
      <p className="text-2xl font-semibold tabular-nums text-fg" data-tabular>
        {value}
      </p>
      {hasDelta || sparkline ? (
        <div className="flex items-center justify-between gap-2">
          {hasDelta ? (
            <span
              className={cn(
                'inline-flex items-center gap-1 text-xs font-medium',
                favourable && 'text-success',
                unfavourable && 'text-danger',
                !favourable && !unfavourable && 'text-fg-muted',
              )}
            >
              {isRising ? <ArrowUp className="size-3" aria-hidden /> : null}
              {isFalling ? <ArrowDown className="size-3" aria-hidden /> : null}
              {/* Wrapped in an element rather than left as a bare text node:
                  flex `gap` is unreliable around anonymous text items. */}
              <span data-tabular>{Math.abs(delta).toString()}</span>
              {deltaLabel ? <span className="text-fg-subtle">{deltaLabel}</span> : null}
            </span>
          ) : (
            <span />
          )}
          {sparkline ? <div className="text-primary">{sparkline}</div> : null}
        </div>
      ) : null}
    </Card>
  );
}
