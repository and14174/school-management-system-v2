import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { cn } from '../lib/cn';

export const alertVariants = cva('flex items-start gap-3 rounded-card border px-4 py-3 text-sm', {
  variants: {
    variant: {
      info: 'border-transparent bg-info-soft',
      success: 'border-transparent bg-success-soft',
      warning: 'border-transparent bg-warning-soft',
      danger: 'border-transparent bg-danger-soft',
    },
  },
  defaultVariants: {
    variant: 'info',
  },
});

const ALERT_ICONS = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
} as const;

const ALERT_ICON_TONES = {
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
} as const;

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {
  /** Pass `false` to omit the leading icon, or a node to override it. */
  icon?: React.ReactNode | false;
}

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant, icon, children, ...props }, ref) => {
    const tone = variant ?? 'info';
    const Icon = ALERT_ICONS[tone];

    return (
      <div
        ref={ref}
        role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
        className={cn(alertVariants({ variant: tone }), className)}
        {...props}
      >
        {icon === false ? null : (
          (icon ?? <Icon className={cn('mt-0.5 size-4 shrink-0', ALERT_ICON_TONES[tone])} />)
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</div>
      </div>
    );
  },
);
Alert.displayName = 'Alert';

export const AlertTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn('font-medium text-fg', className)} {...props} />
));
AlertTitle.displayName = 'AlertTitle';

export const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn('text-fg-muted', className)} {...props} />
));
AlertDescription.displayName = 'AlertDescription';
