'use client';

import * as React from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Users, WifiOff, XCircle } from 'lucide-react';
import { Avatar, AvatarFallback, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Skeleton, cn } from '@sms/ui';
import {
  fetchPerson,
  fetchPersonRelationships,
  personDetailQueryKey,
  type Person,
  type Relationship,
} from '../../../../lib/api';
import { displayName, initials, RELATIONSHIP_TYPE_LABELS } from '../format';

/**
 * `hasCustody`/`mayPickup`/`mayReceiveComms` are legally significant - the
 * brief is explicit that they must never read as ordinary metadata. Each one
 * gets its own always-visible, color-coded chip (success/danger, never just
 * muted text) rather than being folded into a description sentence or a
 * details disclosure a reader could skip past.
 */
function FlagChip({ label, granted }: { label: string; granted: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-control px-2 py-1 text-xs font-semibold',
        granted ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger',
      )}
    >
      {granted ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
      {label}
    </span>
  );
}

function RelatedPersonName({ personId }: { personId: string }) {
  const { data, isPending } = useQuery({
    queryKey: personDetailQueryKey(personId),
    queryFn: ({ signal }) => fetchPerson(personId, signal),
    staleTime: 60_000,
  });

  if (isPending) return <Skeleton className="h-4 w-32" />;
  if (!data) return <span className="text-sm text-fg-muted">Unknown person</span>;

  return (
    <Link
      href={`/people/${personId}` as Route}
      className="truncate text-sm font-medium text-fg hover:text-primary hover:underline"
    >
      {displayName(data)}
    </Link>
  );
}

function RelatedPersonAvatar({ personId }: { personId: string }) {
  const { data } = useQuery({
    queryKey: personDetailQueryKey(personId),
    queryFn: ({ signal }) => fetchPerson(personId, signal),
    staleTime: 60_000,
  });

  return (
    <Avatar className="size-9 shrink-0">
      <AvatarFallback>{data ? initials(data) : '?'}</AvatarFallback>
    </Avatar>
  );
}

function RelationshipCard({ relationship, otherPersonId }: { relationship: Relationship; otherPersonId: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-control border border-border p-3">
      <div className="flex items-center gap-2.5">
        <RelatedPersonAvatar personId={otherPersonId} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <RelatedPersonName personId={otherPersonId} />
          <Badge variant="neutral" className="w-fit">
            {RELATIONSHIP_TYPE_LABELS[relationship.type]}
          </Badge>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <FlagChip label="Legal custody" granted={relationship.hasCustody} />
        <FlagChip label="May pick up" granted={relationship.mayPickup} />
        <FlagChip label="May receive communications" granted={relationship.mayReceiveComms} />
      </div>
    </div>
  );
}

/**
 * Relationships, not a separate "household" grouping: `GET /people/:id/
 * relationships` is real and used as-is; `people.household`/`household_member`
 * have no REST endpoint in `PeopleController` (only base CRUD plus
 * /relationships, /alerts, /duplicates exist), so a literal household-members
 * list grouped by household id isn't something this client can honestly
 * render. Every relationship - which is exactly the data that answers "who
 * has custody, who may collect this child, who may be contacted" - IS shown,
 * split by direction so it reads as two clear groups rather than one
 * ambiguous list.
 */
export function RelationshipsPanel({ person }: { person: Person }) {
  const relationshipsQuery = useQuery({
    queryKey: ['people', 'relationships', person.id],
    queryFn: ({ signal }) => fetchPersonRelationships(person.id, signal),
  });

  if (relationshipsQuery.isPending) {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  if (relationshipsQuery.isError) {
    return (
      <EmptyState
        icon={<WifiOff className="size-5" />}
        title="Couldn't load relationships"
        description={relationshipsQuery.error.message}
      />
    );
  }

  const relationships = relationshipsQuery.data;
  // This person is the DEPENDENT side (toPersonId) - the other person is a
  // parent/guardian/sibling/contact OF this person.
  const guardiansAndContacts = relationships.filter((r) => r.toPersonId === person.id);
  // This person is the GUARDIAN/CONTACT side (fromPersonId) - the other
  // person depends on them.
  const dependents = relationships.filter((r) => r.fromPersonId === person.id);

  if (relationships.length === 0) {
    return (
      <EmptyState
        icon={<Users className="size-5" />}
        title="No relationships recorded"
        description="No parent, guardian, sibling or contact relationships are on file for this person."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Guardians & contacts</CardTitle>
          <CardDescription>Who this person's parents, guardians and emergency contacts are.</CardDescription>
        </CardHeader>
        <CardContent>
          {guardiansAndContacts.length === 0 ? (
            <p className="text-sm text-fg-muted">None recorded.</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {guardiansAndContacts.map((relationship) => (
                <RelationshipCard key={relationship.id} relationship={relationship} otherPersonId={relationship.fromPersonId} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {dependents.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Guardian or contact for</CardTitle>
            <CardDescription>People this person is a parent, guardian, sibling or emergency contact for.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {dependents.map((relationship) => (
                <RelationshipCard key={relationship.id} relationship={relationship} otherPersonId={relationship.toPersonId} />
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
