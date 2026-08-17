'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ShieldOff, UserX, WifiOff } from 'lucide-react';
import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  EmptyState,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@sms/ui';
import { fetchPerson, personDetailQueryKey } from '../../../../lib/api';
import { ForbiddenError } from '../../../../lib/http';
import { usePermissions } from '../../../../lib/permissions';
import { ageFromDateOfBirth, displayName, formatDateOnly, fullName, initials } from '../format';
import { AlertsPanel } from './alerts-panel';
import { DuplicatesPanel } from './duplicates-panel';
import { GradesPanel } from './grades-panel';
import { ProfilePanel } from './profile-panel';
import { RelationshipsPanel } from './relationships-panel';

export default function PersonDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { can, isLoading: permissionsLoading, isError: permissionsError } = usePermissions();

  const personQuery = useQuery({
    queryKey: personDetailQueryKey(id),
    queryFn: ({ signal }) => fetchPerson(id, signal),
    enabled: Boolean(id),
  });

  if (!permissionsLoading && !permissionsError && !can('people.person:read')) {
    return (
      <EmptyState
        icon={<ShieldOff className="size-5" />}
        title="You don't have permission to view this"
        description="Viewing a person's profile requires the people.person:read permission. Ask an administrator if you believe this is a mistake."
        className="min-h-[24rem] justify-center"
      />
    );
  }

  if (personQuery.isPending) {
    return <PersonDetailSkeleton />;
  }

  if (personQuery.isError) {
    if (personQuery.error instanceof ForbiddenError) {
      return (
        <EmptyState
          icon={<ShieldOff className="size-5" />}
          title="You don't have permission to view this"
          description="Viewing a person's profile requires the people.person:read permission."
          className="min-h-[24rem] justify-center"
        />
      );
    }
    return (
      <EmptyState
        icon={<WifiOff className="size-5" />}
        title="Couldn't load this person"
        description={personQuery.error.message}
        action={<Button onClick={() => void personQuery.refetch()}>Retry</Button>}
        className="min-h-[24rem] justify-center"
      />
    );
  }

  const person = personQuery.data;
  if (!person) {
    return (
      <EmptyState
        icon={<UserX className="size-5" />}
        title="Person not found"
        description="This profile may have been removed."
        className="min-h-[24rem] justify-center"
      />
    );
  }

  const shownName = displayName(person);
  const legalName = fullName(person);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href={'/people' as Route}
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted transition-colors duration-150 hover:text-fg"
        >
          <ArrowLeft className="size-3.5" />
          Back to directory
        </Link>
      </div>

      <div className="flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-start sm:gap-5">
        <Avatar className="size-16 shrink-0 text-base">
          <AvatarFallback className="text-base">{initials(person)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-fg">{shownName}</h1>
            {shownName !== legalName ? <Badge variant="neutral">Legal name: {legalName}</Badge> : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
            {person.dateOfBirth ? (
              <span data-tabular>
                Born {formatDateOnly(person.dateOfBirth)} ({ageFromDateOfBirth(person.dateOfBirth)} years old)
              </span>
            ) : null}
            {person.gender ? <span>{person.gender}</span> : null}
          </div>
          <p className="text-xs text-fg-subtle">
            Role and identifier records for this person aren&apos;t exposed by the current API.
          </p>
        </div>
      </div>

      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="relationships">Relationships</TabsTrigger>
          <TabsTrigger value="alerts">Alerts</TabsTrigger>
          {can('academic.gradebook:read') ? <TabsTrigger value="grades">Grades</TabsTrigger> : null}
          <TabsTrigger value="duplicates">Possible duplicates</TabsTrigger>
        </TabsList>
        <TabsContent value="profile">
          <ProfilePanel person={person} />
        </TabsContent>
        <TabsContent value="relationships">
          <RelationshipsPanel person={person} />
        </TabsContent>
        <TabsContent value="alerts">
          <AlertsPanel person={person} />
        </TabsContent>
        {can('academic.gradebook:read') ? (
          <TabsContent value="grades">
            <GradesPanel person={person} />
          </TabsContent>
        ) : null}
        <TabsContent value="duplicates">
          <DuplicatesPanel person={person} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PersonDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-4 w-32" />
      <div className="flex items-start gap-5 border-b border-border pb-6">
        <Skeleton className="size-16 rounded-full" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
      </div>
      <Skeleton className="h-9 w-96" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
