'use client';

import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '../lib/cn';

export const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control text-sm font-medium',
    'transition-colors duration-150 ease-out motion-reduce:transition-none',
    'disabled:pointer-events-none disabled:opacity-50',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        primary: 'bg-primary text-fg-on-accent hover:bg-primary-hover',
        secondary: 'bg-surface-sunken text-fg border border-border hover:bg-surface-raised',
        outline: 'border border-border-strong bg-transparent text-fg hover:bg-surface-sunken',
        ghost: 'bg-transparent text-fg hover:bg-surface-sunken',
        danger: 'bg-danger text-fg-on-danger hover:opacity-90',
      },
      size: {
        sm: 'h-control-compact px-3 text-xs [&_svg]:size-3.5',
        default: 'h-control px-4 [&_svg]:size-4',
        lg: 'h-control-lg px-5 text-base [&_svg]:size-5',
        icon: 'h-control w-control p-0 [&_svg]:size-4',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, loading = false, disabled, children, ...props },
    ref,
  ) => {
    const Comp = asChild ? Slot.Root : 'button';

    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {asChild ? (
          children
        ) : (
          <>
            {loading ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : null}
            {children}
          </>
        )}
      </Comp>
    );
  },
);
Button.displayName = 'Button';
