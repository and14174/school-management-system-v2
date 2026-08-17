import * as React from 'react';
import { cn } from '../lib/cn';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(
          'flex h-control w-full rounded-control border border-border-strong bg-surface px-3 text-sm text-fg',
          'transition-colors duration-150 ease-out motion-reduce:transition-none',
          'placeholder:text-fg-subtle',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium',
          'aria-invalid:border-danger',
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';
