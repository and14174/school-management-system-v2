import { Check } from 'lucide-react';
import { cn } from '@sms/ui';

export type ImportWizardStep = 'upload' | 'map' | 'preview' | 'commit';

const STEPS: Array<{ key: ImportWizardStep; label: string }> = [
  { key: 'upload', label: 'Upload' },
  { key: 'map', label: 'Map columns' },
  { key: 'preview', label: 'Preview' },
  { key: 'commit', label: 'Commit' },
];

/** A linear 4-step progress indicator. `current` marks the active step; every step before it in `STEPS` order is shown complete. */
export function StepIndicator({ current }: { current: ImportWizardStep }) {
  const currentIndex = STEPS.findIndex((step) => step.key === current);

  return (
    <ol className="flex items-center gap-1.5" aria-label="Import steps">
      {STEPS.map((step, index) => {
        const isDone = index < currentIndex;
        const isCurrent = index === currentIndex;
        return (
          <li key={step.key} className="flex items-center gap-1.5">
            <div
              className={cn(
                'flex items-center gap-2 rounded-control px-2.5 py-1 text-xs font-medium transition-colors duration-150 motion-reduce:transition-none',
                isCurrent && 'bg-primary-soft text-primary-soft-fg',
                isDone && !isCurrent && 'text-fg-muted',
                !isDone && !isCurrent && 'text-fg-subtle',
              )}
              aria-current={isCurrent ? 'step' : undefined}
            >
              <span
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px]',
                  isDone && 'border-transparent bg-success text-fg-on-success',
                  isCurrent && 'border-primary text-primary',
                  !isDone && !isCurrent && 'border-border-strong',
                )}
              >
                {isDone ? <Check className="size-2.5" /> : index + 1}
              </span>
              {step.label}
            </div>
            {index < STEPS.length - 1 ? <span className="h-px w-4 bg-border" aria-hidden /> : null}
          </li>
        );
      })}
    </ol>
  );
}
