import Link from 'next/link';
import { Compass } from 'lucide-react';
import { Button, EmptyState } from '@sms/ui';

export default function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-md">
        <EmptyState
          icon={<Compass className="size-5" />}
          title="Page not found"
          description="The page you're looking for doesn't exist or may have moved."
          action={
            <Button asChild>
              <Link href="/dashboard">Back to dashboard</Link>
            </Button>
          }
        />
      </div>
    </div>
  );
}
