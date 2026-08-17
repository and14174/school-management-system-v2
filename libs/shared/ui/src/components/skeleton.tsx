import * as React from 'react';
import { cn } from '../lib/cn';

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-[--radius-control] bg-surface-sunken motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  );
}
