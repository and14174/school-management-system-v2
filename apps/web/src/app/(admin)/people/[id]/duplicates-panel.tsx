'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { useQuery } from '@tanstack/react-query';
import { Copy, WifiOff } from 'lucide-react';
import { Avatar, AvatarFallback, Badge, Button, Card, CardContent, EmptyState, Skeleton } from '@sms/ui';
import { fetchPersonDuplicates, type DuplicateCandidate, type Person } from '../../../../lib/api';
import { usePermissions } from '../../../../lib/permissions';
import { displayName, formatDateOnly, initials } from '../format';
import { MergeDialog } from './merge-dialog';

function matchBadgeVariant(scorePercent: number): 'danger' | 'warning' | 'neutral' {
  if (scorePercent >= 60) return 'danger';
  if (scorePercent >= 35) return 'warning';
  return 'neutral';
}

function DuplicateCard({
  candidate,
  canMerge,
  onMergeRequested,
}: {
  candidate: DuplicateCandidate;
  canMerge: boolean;
  onMergeRequested: () => void;
}) {
  const scorePercent = Math.round(candidate.score * 100);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Avatar className="size-10 shrink-0">
            <AvatarFallback>{initials(candidate.person)}</AvatarFallback>
          </Avatar>
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-fg">{displayName(candidate.person)}</span>
              <Badge variant={matchBadgeVariant(scorePercent)} data-tabular>
                {scorePercent}% match
              </Badge>
            </div>
            {candidate.person.dateOfBirth ? (
              <span className="text-xs text-fg-subtle" data-tabular>
                Born {formatDateOnly(candidate.person.dateOfBirth)}
              </span>
            ) : null}
            <div className="flex flex-wrap gap-1.5">
              {candidate.reasons.map((reason) => (
                <Badge key={reason} variant="neutral">
                  {reason}
                </Badge>
              ))}
            </div>
          </div>
        </div>
        {canMerge ? (
          <Button variant="outline" size="sm" onClick={onMergeRequested} className="shrink-0">
            Review merge
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** `GET /people/:id/duplicates` - scored candidates that plausibly describe the same person, with the merge action gated on `people.person:merge`. */
export function DuplicatesPanel({ person }: { person: Person }) {
  const router = useRouter();
  const { can } = usePermissions();
  const [mergeCandidate, setMergeCandidate] = React.useState<Person | null>(null);

  const duplicatesQuery = useQuery({
    queryKey: ['people', 'duplicates', person.id],
    queryFn: ({ signal }) => fetchPersonDuplicates(person.id, signal),
  });

  if (duplicatesQuery.isPending) {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 2 }).map((_, index) => (
          <Skeleton key={index} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  if (duplicatesQuery.isError) {
    return (
      <EmptyState
        icon={<WifiOff className="size-5" />}
        title="Couldn't check for possible duplicates"
        description={duplicatesQuery.error.message}
      />
    );
  }

  const candidates = duplicatesQuery.data;

  if (candidates.length === 0) {
    return (
      <EmptyState
        icon={<Copy className="size-5" />}
        title="No possible duplicates found"
        description="Nothing in this school closely matches this person's name, date of birth, identifiers or household."
      />
    );
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        {candidates.map((candidate) => (
          <DuplicateCard
            key={candidate.person.id}
            candidate={candidate}
            canMerge={can('people.person:merge')}
            onMergeRequested={() => setMergeCandidate(candidate.person)}
          />
        ))}
      </div>

      {mergeCandidate ? (
        <MergeDialog
          open={Boolean(mergeCandidate)}
          onOpenChange={(open) => {
            if (!open) setMergeCandidate(null);
          }}
          current={person}
          candidate={mergeCandidate}
          onMerged={(survivingId) => {
            setMergeCandidate(null);
            router.push(`/people/${survivingId}` as Route);
          }}
        />
      ) : null}
    </>
  );
}
