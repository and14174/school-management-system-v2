'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ClipboardList, RefreshCw, ShieldOff, WifiOff } from 'lucide-react';
import { Badge, Button, EmptyState, PageHeader, Skeleton } from '@sms/ui';
import { fetchMySections, fetchTerms, type Section, type Term } from '../../../lib/api';
import { ForbiddenError } from '../../../lib/http';
import { usePermissions } from '../../../lib/permissions';

/**
 * Landing page: every section the signed-in teacher teaches, one card each,
 * linking into that section's grid. `GET /academic/sections/mine` resolves
 * the caller's own linked person server-side - there is no "pick a teacher"
 * step because this screen only ever shows the caller's own sections (an
 * admin browsing another teacher's gradebook is out of this task's scope,
 * same posture as the attendance landing page's "my sections" framing).
 *
 * Term names come from `GET /academic/terms`, gated `academic.term:read` - a
 * DIFFERENT permission from the `academic.gradebook:read` this whole page is
 * gated on. Driving the API live as teacher@greenwood.test confirmed a
 * section-scoped Teacher does NOT hold it (403), so the term column is
 * omitted, not blocked, when it's unavailable - see `lib/api.ts`'s own
 * comment on this same tradeoff.
 */
export default function GradebookLandingPage() {
  const { can, isLoading: permissionsLoading, isError: permissionsError } = usePermissions();

  const sectionsQuery = useQuery({
    queryKey: ['gradebook', 'my-sections'],
    queryFn: ({ signal }) => fetchMySections(signal),
    enabled: can('academic.gradebook:read'),
  });

  const termsQuery = useQuery({
    queryKey: ['academic', 'terms', 'all'],
    queryFn: ({ signal }) => fetchTerms(undefined, signal),
    enabled: can('academic.gradebook:read') && can('academic.term:read'),
  });

  if (!permissionsLoading && !permissionsError && !can('academic.gradebook:read')) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="School" title="Gradebook" description="Enter and review grades for your classes." />
        <EmptyState
          icon={<ShieldOff className="size-5" />}
          title="You don't have permission to view this"
          description="Viewing the gradebook requires the academic.gradebook:read permission. Ask an administrator if you believe this is a mistake."
          className="min-h-[24rem] justify-center"
        />
      </div>
    );
  }

  const termsById = new Map<string, Term>((termsQuery.data ?? []).map((term) => [term.id, term]));
  const sections = sectionsQuery.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow="School" title="Gradebook" description="Enter and review grades for your classes." />

      {sectionsQuery.isPending ? (
        <GradebookLandingSkeleton />
      ) : sectionsQuery.isError ? (
        <GradebookLandingError error={sectionsQuery.error} onRetry={() => void sectionsQuery.refetch()} />
      ) : sections.length === 0 ? (
        <EmptyState
          icon={<ClipboardList className="size-5" />}
          title="No sections assigned"
          description="You aren't currently assigned to teach any sections."
          className="min-h-[24rem] justify-center"
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {sections.map((section) => (
            <SectionRow key={section.id} section={section} term={termsById.get(section.termId)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SectionRow({ section, term }: { section: Section; term: Term | undefined }) {
  return (
    <li>
      <Link
        href={`/gradebook/${section.id}` as Route}
        className="flex min-h-16 items-center justify-between gap-3 rounded-card border border-border bg-surface px-4 py-3 transition-colors duration-150 ease-out hover:bg-surface-sunken motion-reduce:transition-none"
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-semibold text-fg">
            {section.code} · {section.name}
          </span>
          <span className="truncate text-xs text-fg-muted">
            {term ? term.name : 'Term unavailable'}
            {section.capacity ? ` · Capacity ${section.capacity}` : ''}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="neutral">{section.code}</Badge>
          <ChevronRight className="size-4 text-fg-subtle" />
        </div>
      </Link>
    </li>
  );
}

function GradebookLandingSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 4 }).map((_, index) => (
        <Skeleton key={index} className="h-16 w-full rounded-card" />
      ))}
    </div>
  );
}

function GradebookLandingError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  if (error instanceof ForbiddenError) {
    return (
      <EmptyState
        icon={<ShieldOff className="size-5" />}
        title="You don't have permission to view this"
        description="Viewing the gradebook requires the academic.gradebook:read permission."
        className="min-h-[24rem] justify-center"
      />
    );
  }
  return (
    <EmptyState
      icon={<WifiOff className="size-5" />}
      title="Couldn't load your sections"
      description={error.message}
      action={
        <Button onClick={onRetry}>
          <RefreshCw className="size-4" />
          Retry
        </Button>
      }
      className="min-h-[24rem] justify-center"
    />
  );
}
