'use client';

import * as React from 'react';
import { Toaster as SonnerToaster, type ToasterProps as SonnerToasterProps } from 'sonner';
import { cn } from '../lib/cn';

export type ToasterProps = SonnerToasterProps;

/**
 * Sonner toaster themed to the design tokens. Styled through classNames
 * (rather than sonner's built-in light/dark palette) so it stays in sync
 * with the token system automatically, in both themes.
 */
export function Toaster({ toastOptions, ...props }: ToasterProps) {
  return (
    <SonnerToaster
      // sonner's `position` is a physical corner (no logical variant exists upstream);
      // `dir="auto"` still lets it read text direction from the document for RTL locales.
      position="bottom-right"
      dir="auto"
      gap={8}
      toastOptions={{
        ...toastOptions,
        unstyled: true,
        classNames: {
          toast: cn(
            'flex w-full items-center gap-3 rounded-card border border-border bg-surface-raised p-4 text-sm text-fg shadow-overlay',
          ),
          title: 'font-medium text-fg',
          description: 'text-fg-muted',
          actionButton: 'rounded-[--radius-control] bg-primary px-2.5 py-1 text-xs font-medium text-fg-on-accent',
          cancelButton: 'rounded-[--radius-control] bg-surface-sunken px-2.5 py-1 text-xs font-medium text-fg-muted',
          closeButton:
            'border-border bg-surface text-fg-subtle hover:text-fg',
          success: 'data-[type=success]:border-success/30',
          error: 'data-[type=error]:border-danger/30',
          warning: 'data-[type=warning]:border-warning/30',
          info: 'data-[type=info]:border-info/30',
          icon: 'text-fg-muted',
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />
  );
}
