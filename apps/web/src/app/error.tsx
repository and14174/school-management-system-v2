'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button, EmptyState } from '@sms/ui';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-md">
        <EmptyState
          icon={<AlertTriangle className="size-5 text-danger" />}
          title="Something went wrong"
          description="An unexpected error occurred. You can try again, and if it keeps happening, let the team know."
          action={
            <Button onClick={reset} variant="secondary">
              Try again
            </Button>
          }
        />
      </div>
    </div>
  );
}
