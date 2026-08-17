'use client';

import * as React from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  CalendarX2,
  CheckCircle2,
  ChevronRight,
  MailWarning,
  MessagesSquare,
  RefreshCw,
  Wallet,
  WifiOff,
} from 'lucide-react';
import { Avatar, AvatarFallback, Badge, Button, Card, EmptyState, PageHeader, Skeleton } from '@sms/ui';
import { useSession } from '../../../components/providers/session-provider';
import type { Person, RelationshipType } from '../../../lib/api';
import {
  fetchAttendanceSummary,
  fetchStudentBalance,
  type AccountBalance,
  type AttendanceSummary,
  type Dependant,
} from '../../../lib/portal-api';
import { formatMoneyMinor } from '../../../lib/money';
import { CardErrorState, CardSkeletonRows } from '../_components/card-states';
import { trailingDaysRange } from '../_lib/date';
import { useMyDependants, useMyPerson, usePortalUnreadCounts } from '../_lib/queries';

const ATTENDANCE_WINDOW_DAYS = 30;

/** GET /billing/students/:personId/balance - shared query key/options so the home cards and NeedsAttentionSection hit the same cache entry rather than doubling the request, same pattern the attendance summary query already uses on this page. */
function studentBalanceQueryOptions(personId: string) {
  return {
    queryKey: ['portal', 'billing', 'balance', personId] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchStudentBalance(personId, signal),
    staleTime: 60_000,
  };
}

/**
 * A student can hold a balance in more than one currency (the schema
 * permits one fee_schedule_version per currency - see the billing module's
 * `1400` migration header), though the seeded demo tenant never actually
 * produces more than one. The currency with the largest MAGNITUDE balance
 * (owed or credited) is treated as "the" figure this card leads with -
 * every currency present is still rendered, never silently merged into one
 * number.
 */
function primaryBalance(balances: AccountBalance[]): AccountBalance | null {
  if (balances.length === 0) return null;
  return [...balances].sort((a, b) => Math.abs(b.balanceMinor) - Math.abs(a.balanceMinor))[0]!;
}

function greetingFor(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function firstNameOf(name: string | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0] ?? null;
}

function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  const first = parts[0];
  const second = parts[1];
  if (first && second) return `${first[0] ?? ''}${second[0] ?? ''}`.toUpperCase();
  return (first ?? name).slice(0, 2).toUpperCase();
}

interface ChildRef {
  personId: string;
  name: string;
  relationshipType: RelationshipType | null;
}

/**
 * The whole home page's premise: "one account, all children" - whether
 * that's a parent's real children (`/people/me/dependants`) or, for a
 * student account with none, the caller themselves. Which of the two this
 * account is comes ONLY from whether `dependants` is non-empty - never from
 * any role name, matching this task's routing rule.
 */
export default function PortalHomePage() {
  const { user } = useSession();
  const personQuery = useMyPerson();
  const dependantsQuery = useMyDependants();

  const greeting = greetingFor(new Date().getHours());
  const firstName = firstNameOf(user?.name);

  const loading = personQuery.isPending || dependantsQuery.isPending;
  const errored = personQuery.isError || dependantsQuery.isError;
  // A guardian has dependants; a student has none. Drives the header wording
  // below - while the list is still loading, fall back to the student phrasing
  // rather than claiming children this account may not have.
  const hasDependants = (dependantsQuery.data?.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-8">
      {/*
        The header has to answer to BOTH audiences this portal serves. A
        student has no children, so the guardian wording read as nonsense over
        their own record ("Your children..." above Mateo's own timetable) -
        that split stays. "Their fees" was dropped from the guardian wording
        entirely because billing had no controller behind it at the time (see
        docs/decisions.md's "Never render a fabricated figure" - it names this
        exact sentence). It is restored now, and ONLY on the guardian branch:
        `GET /billing/summary` backs the dashboard tile, but a parent's own
        fee data is rendered right here on this page (ChildSummaryCard's
        balance, NeedsAttentionSection's outstanding-amount item, and the
        child detail page's Fees tab) - so "their fees" is describing content
        that is actually on the page, not a feature reachable elsewhere.
      */}
      <PageHeader
        eyebrow={hasDependants ? 'Your family' : 'Your record'}
        title={firstName ? `${greeting}, ${firstName}` : greeting}
        description={
          hasDependants
            ? 'Your children, their school record and fees, and what needs your attention - all in one place.'
            : 'Your timetable, attendance and results - all in one place.'
        }
      />

      {loading ? (
        <HomeSkeleton />
      ) : errored ? (
        <EmptyState
          icon={<WifiOff className="size-5" />}
          title="Couldn't load your portal"
          description={
            (personQuery.error ?? dependantsQuery.error)?.message ?? 'Something went wrong loading your account.'
          }
          action={
            <Button
              onClick={() => {
                void personQuery.refetch();
                void dependantsQuery.refetch();
              }}
            >
              <RefreshCw className="size-4" />
              Retry
            </Button>
          }
          className="min-h-[24rem] justify-center"
        />
      ) : (
        <PortalHomeContent person={personQuery.data} dependants={dependantsQuery.data} />
      )}
    </div>
  );
}

function PortalHomeContent({ person, dependants }: { person: Person; dependants: Dependant[] }) {
  const isParent = dependants.length > 0;

  const children: ChildRef[] = isParent
    ? dependants.map((dependant) => ({
        personId: dependant.personId,
        name: `${dependant.givenName} ${dependant.familyName}`,
        relationshipType: dependant.relationshipType,
      }))
    : [{ personId: person.id, name: `${person.givenName} ${person.familyName}`, relationshipType: null }];

  return (
    <div className="flex flex-col gap-8">
      <NeedsAttentionSection children={children} />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-fg">
          {isParent ? (children.length > 1 ? 'Your children' : 'Your child') : 'Your record'}
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {children.map((child) => (
            <ChildSummaryCard key={child.personId} child={child} />
          ))}
        </div>
      </section>
    </div>
  );
}

function ChildSummaryCard({ child }: { child: ChildRef }) {
  const range = React.useMemo(() => trailingDaysRange(ATTENDANCE_WINDOW_DAYS), []);
  // Same query key `NeedsAttentionSection` uses for this child/range - one
  // shared cache entry, not a duplicate network call.
  const summaryQuery = useQuery<AttendanceSummary, Error>({
    queryKey: ['portal', 'attendance', 'summary', child.personId, range.from, range.to],
    queryFn: ({ signal }) => fetchAttendanceSummary(child.personId, range, signal),
    staleTime: 60_000,
  });
  const balanceQuery = useQuery<AccountBalance[], Error>(studentBalanceQueryOptions(child.personId));

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center gap-3">
        <Avatar className="size-10">
          <AvatarFallback>{initialsOf(child.name)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold text-fg">{child.name}</span>
          <span className={`text-xs text-fg-muted ${child.relationshipType ? 'capitalize' : ''}`}>
            {child.relationshipType ? child.relationshipType.replace(/_/g, ' ') : 'Your record'}
          </span>
        </div>
      </div>

      {summaryQuery.isPending ? (
        <CardSkeletonRows count={1} />
      ) : summaryQuery.isError ? (
        <CardErrorState message={summaryQuery.error.message} onRetry={() => void summaryQuery.refetch()} />
      ) : (
        <AttendanceSnippet summary={summaryQuery.data} />
      )}

      {balanceQuery.isPending ? (
        <CardSkeletonRows count={1} />
      ) : balanceQuery.isError ? (
        <CardErrorState message={balanceQuery.error.message} onRetry={() => void balanceQuery.refetch()} />
      ) : (
        <BalanceSnippet balances={balanceQuery.data} />
      )}

      <Button asChild variant="secondary" size="sm" className="mt-auto justify-between">
        <Link href={`/portal/children/${child.personId}` as Route}>
          View timetable &amp; records
          <ChevronRight className="size-4" />
        </Link>
      </Button>
    </Card>
  );
}

/** `balances` is empty for a child with no issued invoice at all - a real, truthful "nothing to show yet" rather than a "$0.00" indistinguishable from "the fetch failed". */
function BalanceSnippet({ balances }: { balances: AccountBalance[] }) {
  const balance = primaryBalance(balances);
  if (!balance) {
    return <p className="text-sm text-fg-muted">No fees on file yet.</p>;
  }
  const tone = balance.balanceMinor > 0 ? 'warning' : balance.balanceMinor < 0 ? 'info' : 'success';
  const label = balance.balanceMinor > 0 ? 'Balance due' : balance.balanceMinor < 0 ? 'Credit balance' : 'Paid in full';
  return (
    <div className="flex items-center justify-between rounded-control bg-surface-sunken px-3 py-2">
      <span className="text-xs text-fg-muted">{label}</span>
      <Badge variant={tone}>{formatMoneyMinor(balance.balanceMinor, balance.currency)}</Badge>
    </div>
  );
}

function AttendanceSnippet({ summary }: { summary: AttendanceSummary }) {
  if (summary.totalCount === 0) {
    return (
      <p className="text-sm text-fg-muted">No attendance recorded in the last {ATTENDANCE_WINDOW_DAYS} days.</p>
    );
  }

  const pct = summary.attendancePercentage;
  const tone = pct >= 95 ? 'success' : pct >= 85 ? 'warning' : 'danger';

  return (
    <div className="flex items-center justify-between rounded-control bg-surface-sunken px-3 py-2">
      <span className="text-xs text-fg-muted">Present, last {ATTENDANCE_WINDOW_DAYS} days</span>
      <Badge variant={tone}>{pct}%</Badge>
    </div>
  );
}

interface AttentionItem {
  key: string;
  icon: React.ReactNode;
  text: string;
  href: Route;
}

/**
 * Built ONLY from real signals, per this task's non-negotiable rule: unread
 * announcement/thread counts (`GET /communications/unread-counts`), real
 * absence counts per child (`GET /attendance/summary`, same query the child
 * card above runs - same query key, so this shares its cache rather than
 * doubling the request), and real outstanding fee balances (`GET /billing/
 * students/:id/balance`, same query/key `ChildSummaryCard`'s balance snippet
 * uses). Nothing here is invented; an account with nothing outstanding gets
 * an honest "all caught up" state, not an empty section that looks broken -
 * and an outstanding-amount item only ever appears when a real balance is
 * actually owed (`balanceMinor > 0` - a credit is never phrased as
 * "attention needed").
 */
function NeedsAttentionSection({ children }: { children: ChildRef[] }) {
  const unreadQuery = usePortalUnreadCounts();
  const range = React.useMemo(() => trailingDaysRange(ATTENDANCE_WINDOW_DAYS), []);
  const attendanceQueries = useQueries({
    queries: children.map((child) => ({
      queryKey: ['portal', 'attendance', 'summary', child.personId, range.from, range.to],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchAttendanceSummary(child.personId, range, signal),
      staleTime: 60_000,
    })),
  });
  const balanceQueries = useQueries({
    queries: children.map((child) => studentBalanceQueryOptions(child.personId)),
  });

  const loading =
    unreadQuery.isPending || attendanceQueries.some((query) => query.isPending) || balanceQueries.some((query) => query.isPending);

  const items: AttentionItem[] = [];

  // unread-counts 403s (ForbiddenError) for an account with no linked
  // person at all - treated as "nothing to report" here, not an error, same
  // as (admin)/dashboard's CommunicationsCard.
  if (unreadQuery.data) {
    if (unreadQuery.data.unreadAnnouncements > 0) {
      items.push({
        key: 'announcements',
        icon: <MailWarning className="size-4" />,
        text: `${unreadQuery.data.unreadAnnouncements} unread announcement${unreadQuery.data.unreadAnnouncements === 1 ? '' : 's'}`,
        href: '/portal/messages' as Route,
      });
    }
    if (unreadQuery.data.unreadThreads > 0) {
      items.push({
        key: 'threads',
        icon: <MessagesSquare className="size-4" />,
        text: `${unreadQuery.data.unreadThreads} conversation${unreadQuery.data.unreadThreads === 1 ? '' : 's'} with unread messages`,
        href: '/portal/messages' as Route,
      });
    }
  }

  children.forEach((child, index) => {
    const summary = attendanceQueries[index]?.data as AttendanceSummary | undefined;
    const absences = summary?.countsByCategory.absent ?? 0;
    if (absences > 0) {
      items.push({
        key: `absence-${child.personId}`,
        icon: <CalendarX2 className="size-4" />,
        text: `${child.name}: ${absences} absence${absences === 1 ? '' : 's'} in the last ${ATTENDANCE_WINDOW_DAYS} days`,
        href: `/portal/children/${child.personId}` as Route,
      });
    }

    const balances = balanceQueries[index]?.data as AccountBalance[] | undefined;
    const owed = balances?.filter((b) => b.balanceMinor > 0) ?? [];
    for (const balance of owed) {
      items.push({
        key: `balance-${child.personId}-${balance.currency}`,
        icon: <Wallet className="size-4" />,
        text: `${child.name}: ${formatMoneyMinor(balance.balanceMinor, balance.currency)} outstanding`,
        href: `/portal/children/${child.personId}` as Route,
      });
    }
  });

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-fg">Needs your attention</h2>
      {loading ? (
        <CardSkeletonRows count={2} />
      ) : items.length === 0 ? (
        <Card className="flex items-center gap-3 p-4">
          <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden />
          <p className="text-sm text-fg-muted">
            You&rsquo;re all caught up - no unread messages, no recent absences, and no outstanding fees.
          </p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.key}>
              <Link
                href={item.href}
                className={
                  'flex min-h-14 items-center gap-3 rounded-card border border-warning/40 bg-warning-soft px-4 py-3 text-sm font-medium text-fg ' +
                  'transition-colors duration-150 ease-out hover:border-warning/70 motion-reduce:transition-none ' +
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
                }
              >
                <span className="text-warning">{item.icon}</span>
                <span className="flex-1">{item.text}</span>
                <ChevronRight className="size-4 shrink-0 text-fg-subtle" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-16 w-full rounded-card" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 2 }).map((_, index) => (
          <div key={index} className="flex flex-col gap-3 rounded-card border border-border bg-surface p-5">
            <Skeleton className="size-10 rounded-full" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-11 w-full rounded-control" />
            <Skeleton className="h-9 w-full rounded-control" />
          </div>
        ))}
      </div>
    </div>
  );
}
