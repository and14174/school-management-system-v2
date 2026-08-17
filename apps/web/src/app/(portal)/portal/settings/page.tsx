'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, WifiOff } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Label,
  PageHeader,
  Skeleton,
  Switch,
} from '@sms/ui';
import {
  fetchNotificationPreferences,
  setNotificationPreference,
  type NotificationPreference,
} from '../../../../lib/portal-api';
import { useMyDependants, useMyPerson } from '../../_lib/queries';

/**
 * The ONLY notification category actually wired to a send path anywhere in
 * this codebase - `AttendanceAbsenceSubscriber` sends `channel: 'email',
 * category: 'attendance'` and nothing else exists yet (see portal-api.ts's
 * own top comment). `GET /notifications/templates`, which would otherwise
 * enumerate every real category, is gated `notifications.template:manage` -
 * neither Parent/Guardian nor Student holds it - so this is hardcoded to the
 * one category this account can honestly be offered, not guessed at from a
 * list it cannot read.
 */
const ATTENDANCE_PREFERENCE = { channel: 'email' as const, category: 'attendance' };

export default function PortalSettingsPage() {
  const personQuery = useMyPerson();
  const dependantsQuery = useMyDependants();

  const loading = personQuery.isPending || dependantsQuery.isPending;
  const errored = personQuery.isError || dependantsQuery.isError;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Settings"
        title="Notification preferences"
        description="Choose which emails you'd like to receive."
      />

      {loading ? (
        <SettingsSkeleton />
      ) : errored ? (
        <EmptyState
          icon={<WifiOff className="size-5" />}
          title="Couldn't load your settings"
          description={(personQuery.error ?? dependantsQuery.error)?.message ?? 'Something went wrong.'}
          className="min-h-64 justify-center"
        />
      ) : (
        <SettingsContent personId={personQuery.data.id} isGuardian={dependantsQuery.data.length > 0} />
      )}
    </div>
  );
}

function SettingsContent({ personId, isGuardian }: { personId: string; isGuardian: boolean }) {
  // Attendance emails are resolved to a student's GUARDIANS at send time
  // (`GuardianRecipientResolverService` walks `people.relationship` for the
  // absent student's guardians - it never includes the student themselves).
  // A student account genuinely has nothing to configure yet, so this says
  // that honestly instead of offering a toggle with no real effect.
  if (!isGuardian) {
    return (
      <EmptyState
        icon={<Bell className="size-5" />}
        title="No notification preferences yet"
        description="Attendance emails are sent to a student's guardians, not the student directly - there's nothing to configure on a student account yet."
        className="min-h-64 justify-center"
      />
    );
  }
  return <AttendancePreferenceCard personId={personId} />;
}

function AttendancePreferenceCard({ personId }: { personId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery<NotificationPreference[], Error>({
    queryKey: ['portal', 'notifications', 'preferences', personId],
    queryFn: ({ signal }) => fetchNotificationPreferences(personId, signal),
  });

  const mutation = useMutation({
    mutationFn: (optedIn: boolean) =>
      setNotificationPreference(personId, { ...ATTENDANCE_PREFERENCE, optedIn }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal', 'notifications', 'preferences', personId] });
    },
  });

  if (query.isPending) {
    return (
      <Card className="p-5">
        <Skeleton className="h-11 w-full rounded-control" />
      </Card>
    );
  }
  if (query.isError) {
    return (
      <EmptyState
        icon={<WifiOff className="size-5" />}
        title="Couldn't load your preferences"
        description={query.error.message}
        className="min-h-48 justify-center"
      />
    );
  }

  const existing = query.data.find(
    (preference) => preference.channel === ATTENDANCE_PREFERENCE.channel && preference.category === ATTENDANCE_PREFERENCE.category,
  );
  // No explicit row means opted in - the server's own documented default
  // (see `NotificationPreference`'s comment in portal-api.ts) - never shown
  // as "off" for an absent row.
  const optedIn = existing ? existing.optedIn : true;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Attendance emails</CardTitle>
        <CardDescription>Get an email when an absence is recorded for one of your children.</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-4">
        <Label htmlFor="attendance-email-toggle" className="flex-1 cursor-pointer">
          {optedIn ? 'On' : 'Off'}
        </Label>
        <Switch
          id="attendance-email-toggle"
          checked={optedIn}
          disabled={mutation.isPending}
          onCheckedChange={(checked) => mutation.mutate(checked)}
        />
      </CardContent>
      {mutation.isError ? (
        <CardContent className="pt-0">
          <Alert variant="danger">
            <AlertTitle>Couldn&rsquo;t save</AlertTitle>
            <AlertDescription>{mutation.error.message}</AlertDescription>
          </Alert>
        </CardContent>
      ) : null}
    </Card>
  );
}

function SettingsSkeleton() {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-3 w-64" />
      <Skeleton className="h-11 w-full rounded-control" />
    </Card>
  );
}
