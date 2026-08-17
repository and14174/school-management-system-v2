'use client';

import * as React from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarDays,
  ClipboardList,
  Download,
  FileText,
  Receipt,
  RefreshCw,
  ShieldOff,
  WifiOff,
} from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Skeleton,
  StatTile,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@sms/ui';
import type { AttendanceCategory, TimetableEntry } from '../../../../../lib/api';
import { ForbiddenError } from '../../../../../lib/http';
import { formatMoneyMinor } from '../../../../../lib/money';
import {
  fetchAttendanceSummary,
  fetchInvoiceBalance,
  fetchInvoicesForStudent,
  fetchReportCardDownloadUrl,
  fetchReportCards,
  fetchStudentTimetable,
  fetchTranscript,
  type AttendanceSummary,
  type Invoice,
  type InvoiceBalance,
  type ReportCard,
  type Transcript,
} from '../../../../../lib/portal-api';
import {
  currentWeekRange,
  everyDayOf,
  formatDate,
  formatDayLabel,
  formatTimeOfDay,
  trailingDaysRange,
} from '../../../_lib/date';
import { useMyDependants, useMyPerson } from '../../../_lib/queries';

const ATTENDANCE_WINDOW_DAYS = 30;

export default function ChildDetailPage() {
  const params = useParams<{ personId: string }>();
  const personId = params.personId;

  const personQuery = useMyPerson();
  const dependantsQuery = useMyDependants();

  // The parent's own `/people/:id` is 403 for them, so the child's name has
  // to come from data this account can already see: either the dependants
  // list (a parent viewing a child) or their own person record (a student
  // viewing themselves). Neither is guaranteed to resolve for an arbitrary
  // id - the tabs below fail on their own real permission checks in that
  // case, this heading just falls back to a generic label rather than
  // blocking the page on a name lookup that isn't the point of it.
  const displayName = React.useMemo(() => {
    const dependant = dependantsQuery.data?.find((entry) => entry.personId === personId);
    if (dependant) return `${dependant.givenName} ${dependant.familyName}`;
    if (personQuery.data && personQuery.data.id === personId) {
      return `${personQuery.data.givenName} ${personQuery.data.familyName}`;
    }
    return null;
  }, [dependantsQuery.data, personQuery.data, personId]);

  const nameLoading = personQuery.isPending || dependantsQuery.isPending;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <Button asChild variant="ghost" size="sm" className="w-fit">
          <Link href={'/portal' as Route}>
            <ArrowLeft className="size-4" />
            Back to portal
          </Link>
        </Button>
        {nameLoading ? (
          <div className="flex flex-col gap-2 border-b border-border pb-5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-7 w-56" />
          </div>
        ) : (
          <PageHeader
            eyebrow="Student record"
            title={displayName ?? 'Student record'}
            description="Timetable, attendance, transcript and report cards."
          />
        )}
      </div>

      <Tabs defaultValue="timetable">
        {/* The five labels together are wider than a 375px viewport - scroll
            the tab strip itself rather than letting it push the whole page
            into horizontal overflow. */}
        <div className="overflow-x-auto">
          <TabsList>
            <TabsTrigger value="timetable">Timetable</TabsTrigger>
            <TabsTrigger value="attendance">Attendance</TabsTrigger>
            <TabsTrigger value="transcript">Transcript</TabsTrigger>
            <TabsTrigger value="report-cards">Report cards</TabsTrigger>
            <TabsTrigger value="fees">Fees</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="timetable">
          <TimetableTab personId={personId} />
        </TabsContent>
        <TabsContent value="attendance">
          <AttendanceTab personId={personId} />
        </TabsContent>
        <TabsContent value="transcript">
          <TranscriptTab personId={personId} />
        </TabsContent>
        <TabsContent value="report-cards">
          <ReportCardsTab personId={personId} />
        </TabsContent>
        <TabsContent value="fees">
          <FeesTab personId={personId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function TabSkeleton() {
  return (
    <div className="flex flex-col gap-2 pt-1">
      {Array.from({ length: 3 }).map((_, index) => (
        <Skeleton key={index} className="h-14 w-full rounded-card" />
      ))}
    </div>
  );
}

function TabError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  if (error instanceof ForbiddenError) {
    return (
      <EmptyState
        icon={<ShieldOff className="size-5" />}
        title="You don't have access to this"
        description="This record isn't yours to view."
        className="min-h-48 justify-center py-8"
      />
    );
  }
  return (
    <EmptyState
      icon={<WifiOff className="size-5" />}
      title="Couldn't load this"
      description={error.message}
      action={
        <Button size="sm" variant="secondary" onClick={onRetry}>
          <RefreshCw className="size-3.5" />
          Retry
        </Button>
      }
      className="min-h-48 justify-center py-8"
    />
  );
}

// ---------------------------------------------------------------------------
// Timetable - the current calendar week, every day rendered (including
// empty ones). Sections in this tenant meet Monday/Wednesday/Friday only -
// an empty Tuesday is correct, so every day says so explicitly rather than
// just showing nothing.
// ---------------------------------------------------------------------------

function TimetableTab({ personId }: { personId: string }) {
  const range = React.useMemo(() => currentWeekRange(), []);
  const query = useQuery<TimetableEntry[], Error>({
    queryKey: ['portal', 'academic', 'timetable', 'student', personId, range.from, range.to],
    queryFn: ({ signal }) => fetchStudentTimetable(personId, range, signal),
  });

  if (query.isPending) return <TabSkeleton />;
  if (query.isError) return <TabError error={query.error} onRetry={() => void query.refetch()} />;

  const days = everyDayOf(range);
  const byDay = new Map<string, TimetableEntry[]>(days.map((day) => [day, []]));
  for (const entry of query.data) {
    byDay.get(entry.date)?.push(entry);
  }
  for (const entries of byDay.values()) {
    entries.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }

  return (
    <div className="flex flex-col gap-3 pt-1">
      <p className="text-xs text-fg-subtle">
        Week of {formatDate(`${range.from}T00:00:00`)} - classes meet Monday, Wednesday and Friday only; other days
        are expected to be empty.
      </p>
      {days.map((day) => {
        const entries = byDay.get(day) ?? [];
        return (
          <div key={day} className="overflow-hidden rounded-card border border-border bg-surface">
            <div className="border-b border-border bg-surface-sunken px-4 py-2 text-sm font-semibold text-fg">
              {formatDayLabel(day)}
            </div>
            {entries.length === 0 ? (
              <p className="px-4 py-3 text-sm text-fg-muted">No classes scheduled.</p>
            ) : (
              <ul className="divide-y divide-border">
                {entries.map((entry) => (
                  <li key={entry.sectionMeetingId} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="flex min-w-0 flex-col">
                      <span className="text-sm font-medium text-fg">
                        {entry.sectionCode} · {entry.periodName}
                      </span>
                      <span className="truncate text-xs text-fg-muted">
                        {entry.sectionName}
                        {entry.roomCode ? ` · Room ${entry.roomCode}` : ''}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {entry.isSubstituted ? <Badge variant="warning">Covered</Badge> : null}
                      <span className="text-xs text-fg-muted">
                        {formatTimeOfDay(entry.startsAt)} – {formatTimeOfDay(entry.endsAt)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attendance - a clearly-labelled trailing window (a parent/student cannot
// resolve term dates - see portal-api.ts's own top comment - so "this term"
// is not something this client can honestly compute).
// ---------------------------------------------------------------------------

const ATTENDANCE_CATEGORY_LABELS: Record<AttendanceCategory, string> = {
  present: 'Present',
  absent: 'Absent',
  late: 'Late',
  excused: 'Excused',
};

function AttendanceTab({ personId }: { personId: string }) {
  const range = React.useMemo(() => trailingDaysRange(ATTENDANCE_WINDOW_DAYS), []);
  const query = useQuery<AttendanceSummary, Error>({
    queryKey: ['portal', 'attendance', 'summary', personId, range.from, range.to],
    queryFn: ({ signal }) => fetchAttendanceSummary(personId, range, signal),
  });

  if (query.isPending) return <TabSkeleton />;
  if (query.isError) return <TabError error={query.error} onRetry={() => void query.refetch()} />;

  const summary = query.data;
  const windowLabel = `${formatDate(`${range.from}T00:00:00`)} - ${formatDate(`${range.to}T00:00:00`)}`;

  if (summary.totalCount === 0) {
    return (
      <EmptyState
        icon={<CalendarDays className="size-5" />}
        title="No attendance recorded"
        description={`Nothing was recorded between ${windowLabel}.`}
        className="min-h-48 justify-center py-8"
      />
    );
  }

  return (
    <div className="flex flex-col gap-4 pt-1">
      <p className="text-xs text-fg-subtle">
        {windowLabel} · {summary.totalCount} session{summary.totalCount === 1 ? '' : 's'} recorded
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatTile label="Present rate" value={`${summary.attendancePercentage}%`} />
        {(Object.keys(ATTENDANCE_CATEGORY_LABELS) as AttendanceCategory[]).map((category) => (
          <StatTile key={category} label={ATTENDANCE_CATEGORY_LABELS[category]} value={summary.countsByCategory[category]} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transcript - finalised course history and cumulative GPA. Live gradebook
// scores are NOT shown here - see portal-api.ts's top comment for why.
// ---------------------------------------------------------------------------

function TranscriptTab({ personId }: { personId: string }) {
  const query = useQuery<Transcript, Error>({
    queryKey: ['portal', 'records', 'transcript', personId],
    queryFn: ({ signal }) => fetchTranscript(personId, signal),
  });

  if (query.isPending) return <TabSkeleton />;
  if (query.isError) return <TabError error={query.error} onRetry={() => void query.refetch()} />;

  const transcript = query.data;
  if (transcript.entries.length === 0) {
    return (
      <EmptyState
        icon={<FileText className="size-5" />}
        title="No transcript entries yet"
        description="Finalised course grades will appear here once a term has been finalised."
        className="min-h-48 justify-center py-8"
      />
    );
  }

  return (
    <div className="flex flex-col gap-4 pt-1">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile
          label="Cumulative GPA"
          value={transcript.cumulativeGpa != null ? transcript.cumulativeGpa.toFixed(2) : 'Not available'}
        />
        <StatTile label="Credits earned" value={transcript.cumulativeCreditsEarned} />
        <StatTile label="Credits attempted" value={transcript.cumulativeCreditsAttempted} />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Course</TableHead>
            <TableHead>Credits</TableHead>
            <TableHead>Grade</TableHead>
            <TableHead>GPA points</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {transcript.entries.map((entry) => (
            <TableRow key={entry.id}>
              <TableCell>
                <div className="flex flex-col">
                  <span className="font-medium text-fg">{entry.courseCode}</span>
                  <span className="text-xs text-fg-muted">{entry.courseName}</span>
                </div>
              </TableCell>
              <TableCell>
                {entry.creditsEarned}/{entry.creditsAttempted}
              </TableCell>
              <TableCell>
                {entry.letter ?? '—'}
                {entry.percentage != null ? ` (${entry.percentage}%)` : ''}
              </TableCell>
              <TableCell>{entry.gpaPoints ?? '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Report cards - issued, frozen snapshots. Downloads via a presigned URL -
// PDFs never proxy through this app.
// ---------------------------------------------------------------------------

function ReportCardsTab({ personId }: { personId: string }) {
  const query = useQuery<ReportCard[], Error>({
    queryKey: ['portal', 'records', 'report-cards', personId],
    queryFn: ({ signal }) => fetchReportCards(personId, signal),
  });

  if (query.isPending) return <TabSkeleton />;
  if (query.isError) return <TabError error={query.error} onRetry={() => void query.refetch()} />;

  if (query.data.length === 0) {
    return (
      <EmptyState
        icon={<ClipboardList className="size-5" />}
        title="No report cards issued yet"
        description="Issued report cards will appear here as soon as the school publishes one."
        className="min-h-48 justify-center py-8"
      />
    );
  }

  return (
    <ul className="flex flex-col gap-2 pt-1">
      {query.data.map((card) => (
        <ReportCardRow key={card.id} card={card} />
      ))}
    </ul>
  );
}

function ReportCardRow({ card }: { card: ReportCard }) {
  const [downloading, setDownloading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleDownload = async () => {
    setDownloading(true);
    setError(null);
    try {
      const { url } = await fetchReportCardDownloadUrl(card.id);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not get a download link.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <li className="flex flex-col gap-3 rounded-card border border-border bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-semibold text-fg">
          {card.snapshot.gradingPeriodName} · {card.snapshot.termName}
        </span>
        <span className="text-xs text-fg-muted">
          {card.gpa != null ? `GPA ${card.gpa.toFixed(2)}` : 'GPA not available'} · Issued {formatDate(card.createdAt)}
        </span>
        {error ? <span className="text-xs text-danger">{error}</span> : null}
      </div>
      <Button size="sm" variant="secondary" onClick={() => void handleDownload()} loading={downloading} className="shrink-0">
        <Download className="size-3.5" />
        Download
      </Button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Fees - READ ONLY. There is no payment flow in Phase 1, and a parent must
// never be able to alter what their child was charged (billing.invoice is
// immutable in substance once issued - see the billing module's `1400`
// migration header - so even a working "Pay now" button would only ever be
// able to record a payment, never adjust a charge; that write path does not
// exist for this role at all: billing.payment:record is finance-only, never
// granted to Parent/Guardian - see @sms/access's seed.ts). Deliberately no
// "Pay now" action anywhere on this tab - an inert button that does nothing
// is worse than no button.
// ---------------------------------------------------------------------------

const INVOICE_STATUS_LABEL: Record<Invoice['status'], string> = {
  draft: 'Draft',
  issued: 'Issued',
};

function FeesTab({ personId }: { personId: string }) {
  const invoicesQuery = useQuery<Invoice[], Error>({
    queryKey: ['portal', 'billing', 'invoices', personId],
    queryFn: ({ signal }) => fetchInvoicesForStudent(personId, signal),
  });

  const invoiceIds = invoicesQuery.data?.map((invoice) => invoice.id) ?? [];
  const balanceQueries = useQueries({
    queries: invoiceIds.map((invoiceId) => ({
      queryKey: ['portal', 'billing', 'invoice-balance', invoiceId],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchInvoiceBalance(invoiceId, signal),
    })),
  });

  if (invoicesQuery.isPending) return <TabSkeleton />;
  if (invoicesQuery.isError) return <TabError error={invoicesQuery.error} onRetry={() => void invoicesQuery.refetch()} />;

  const invoices = invoicesQuery.data;
  if (invoices.length === 0) {
    return (
      <EmptyState
        icon={<Receipt className="size-5" />}
        title="No invoices issued yet"
        description="Fees will appear here once the school issues an invoice for this student."
        className="min-h-48 justify-center py-8"
      />
    );
  }

  return (
    <div className="flex flex-col gap-3 pt-1">
      <p className="text-xs text-fg-subtle">
        Read-only - fees are issued and collected by the school office, not managed from this portal.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Issued</TableHead>
            <TableHead>Due</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Balance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invoices.map((invoice, index) => (
            <InvoiceRow key={invoice.id} invoice={invoice} balanceQuery={balanceQueries[index]} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function InvoiceRow({
  invoice,
  balanceQuery,
}: {
  invoice: Invoice;
  balanceQuery: UseQueryResult<InvoiceBalance, Error> | undefined;
}) {
  return (
    <TableRow>
      <TableCell>{invoice.issuedAt ? formatDate(invoice.issuedAt) : 'Not yet issued'}</TableCell>
      <TableCell>{invoice.dueDate ? formatDate(`${invoice.dueDate}T00:00:00`) : '—'}</TableCell>
      <TableCell>
        <Badge variant={invoice.status === 'issued' ? 'info' : 'neutral'}>{INVOICE_STATUS_LABEL[invoice.status]}</Badge>
      </TableCell>
      <TableCell>
        {!balanceQuery || balanceQuery.isPending ? (
          <Skeleton className="h-5 w-16" />
        ) : balanceQuery.isError ? (
          <span className="text-xs text-danger">Couldn&rsquo;t load</span>
        ) : (
          <Badge
            variant={
              balanceQuery.data.balanceMinor > 0 ? 'warning' : balanceQuery.data.balanceMinor < 0 ? 'info' : 'success'
            }
          >
            {formatMoneyMinor(balanceQuery.data.balanceMinor, balanceQuery.data.currency)}
          </Badge>
        )}
      </TableCell>
    </TableRow>
  );
}
