'use client';

import { PageHeader, Skeleton } from '@sms/ui';
import { useSession } from '../providers/session-provider';

/**
 * Time-of-day greeting for the signed-in user, from the real session rather
 * than a hardcoded name. Uses the browser's clock, which is the user's own
 * local time - the school's configured timezone matters for records, not for
 * whether it is currently morning where the reader is sitting.
 */
function greetingFor(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** First name only - a full legal name reads as a form field, not a greeting. */
function firstNameOf(name: string | undefined, email: string | undefined): string | null {
  const trimmed = name?.trim();
  if (trimmed) return trimmed.split(/\s+/)[0] ?? null;
  const local = email?.split('@')[0];
  return local ? local : null;
}

export function DashboardGreeting() {
  const { user, activeTenant, isPending } = useSession();

  if (isPending) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-96" />
      </div>
    );
  }

  const firstName = firstNameOf(user?.name, user?.email);
  const greeting = greetingFor(new Date().getHours());

  return (
    <PageHeader
      eyebrow="Overview"
      title={firstName ? `${greeting}, ${firstName}` : greeting}
      description={
        activeTenant
          ? `Here's what's happening across ${activeTenant.name} today.`
          : "Here's what's happening today."
      }
    />
  );
}
