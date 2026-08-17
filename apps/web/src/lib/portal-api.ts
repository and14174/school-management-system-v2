/**
 * Fetchers backing the parent/student portal - apps/web/src/app/(portal)/**.
 * Kept separate from lib/api.ts and lib/dashboard-api.ts (both off-limits to
 * edit here - see this task's own CONSTRAINTS) even though the private
 * fetch/assert helpers below mirror their shape closely; that duplication is
 * the established pattern in this codebase (dashboard-api.ts's own top
 * comment makes the same call for the same reason).
 *
 * Every endpoint below was read from its controller under
 * libs/*\/*\/src/api/*.controller.ts, not guessed - see each section's own
 * comment for which one:
 *
 *   - GET /people/me                          -> libs/domain/people/src/api/people.controller.ts
 *   - GET /people/me/dependants                -> libs/domain/people/src/api/people.controller.ts
 *   - GET /attendance/summary                  -> libs/domain/attendance/src/api/attendance.controller.ts
 *   - GET /academic/timetables/student/:id     -> libs/domain/academic/src/api/scheduling.controller.ts
 *   - GET /records/transcripts/:id[/gpa]       -> libs/domain/records/src/api/records.controller.ts
 *   - GET /records/report-cards[/:id/...]      -> libs/domain/records/src/api/records.controller.ts
 *   - GET/POST /communications/*               -> libs/domain/communications/src/api/communications.controller.ts
 *   - GET/PUT /notifications/preferences/:id   -> libs/platform/notifications/src/api/notifications.controller.ts
 *   - GET /billing/students/:id/balance        -> libs/domain/billing/src/api/billing.controller.ts
 *   - GET /billing/invoices[/:id/balance]      -> libs/domain/billing/src/api/billing.controller.ts
 *
 * A real, deliberate gap: `GET /gradebook/students/:personId/grades` requires
 * a `gradingPeriodId`, and a parent/student cannot enumerate terms or grading
 * periods (`/academic/terms` 403s for both - see `AcademicController`'s own
 * comment on why that permission is tenant/section only). There is no
 * legitimate way for this client to obtain one, so live gradebook scores are
 * NOT surfaced anywhere in the portal - `records.transcripts` (finalised,
 * historical) and `records.report-cards` (issued snapshots) are the only
 * grade data this portal can show. This mirrors the task brief's own
 * instruction: report the gap rather than inventing an endpoint.
 */
import {
  API_URL,
  ApiUnreachableError,
  type AttendanceCategory,
  type DayOfWeek,
  type Person,
  type RelationshipType,
  type TimetableEntry,
} from './api';
import { ForbiddenError, UnauthorizedError } from './http';

async function portalFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_URL}/api/v1${path}`, {
      credentials: 'include',
      ...init,
    });
  } catch (cause) {
    throw new ApiUnreachableError(cause);
  }
}

async function assertPortalOk(response: Response, fallbackMessage: string): Promise<void> {
  if (response.status === 401) throw new UnauthorizedError();
  if (response.status === 403) throw new ForbiddenError();
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? fallbackMessage);
  }
}

// ---------------------------------------------------------------------------
// People - the caller's own record, and (for a guardian) their dependants.
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/people/me/dependants's shape - the ONLY way a guardian can
 * discover their own children (`/people/:id` and `/people/:id/relationships`
 * both 403 for a `dependants`-scoped caller). Deliberately NOT filtered by
 * `mayReceiveComms` server-side - see that controller's own comment: that
 * flag governs broadcast mail, not visibility of the child's record.
 */
export interface Dependant {
  personId: string;
  givenName: string;
  familyName: string;
  relationshipType: RelationshipType;
  hasCustody: boolean;
  mayPickup: boolean;
  priority: number;
}

/** GET /api/v1/people/me - the caller's own `people.person` row. */
export async function fetchMyPerson(signal?: AbortSignal): Promise<Person> {
  const response = await portalFetch('/people/me', { signal });
  await assertPortalOk(response, `Could not load your profile (HTTP ${response.status}).`);
  return (await response.json()) as Person;
}

/** GET /api/v1/people/me/dependants - sorted by priority then name, already, by the server. Empty for a caller with no children linked (e.g. a student account). */
export async function fetchMyDependants(signal?: AbortSignal): Promise<Dependant[]> {
  const response = await portalFetch('/people/me/dependants', { signal });
  await assertPortalOk(response, `Could not load your children (HTTP ${response.status}).`);
  return (await response.json()) as Dependant[];
}

// ---------------------------------------------------------------------------
// Attendance - summary over an explicit [from, to] range. Both are REQUIRED
// by the server (400 without - see docs/decisions.md's "Required query
// parameters need a schema" entry), never omitted here.
// ---------------------------------------------------------------------------

export interface AttendanceSummary {
  personId: string;
  from: string;
  to: string;
  totalCount: number;
  presentCount: number;
  countsByCategory: Record<AttendanceCategory, number>;
  attendancePercentage: number;
}

/** GET /api/v1/attendance/summary?personId=&from=&to= - `personId` must be the caller themselves or one of their dependants (server-enforced; see `AttendanceController.assertSummaryAccess`). */
export async function fetchAttendanceSummary(
  personId: string,
  range: { from: string; to: string },
  signal?: AbortSignal,
): Promise<AttendanceSummary> {
  const search = new URLSearchParams({ personId, from: range.from, to: range.to });
  const response = await portalFetch(`/attendance/summary?${search.toString()}`, { signal });
  await assertPortalOk(response, `Could not load this attendance summary (HTTP ${response.status}).`);
  return (await response.json()) as AttendanceSummary;
}

// ---------------------------------------------------------------------------
// Academic - a student's own timetable. `from`/`to` REQUIRED, same as above.
// Sections meet Monday/Wednesday/Friday only in this tenant's data - an
// empty day is expected, not broken; callers render every requested day
// rather than only the days with entries, so that reads honestly.
// ---------------------------------------------------------------------------

export type { DayOfWeek, TimetableEntry };

/** GET /api/v1/academic/timetables/student/:personId?from=&to= */
export async function fetchStudentTimetable(
  personId: string,
  range: { from: string; to: string },
  signal?: AbortSignal,
): Promise<TimetableEntry[]> {
  const search = new URLSearchParams({ from: range.from, to: range.to });
  const response = await portalFetch(
    `/academic/timetables/student/${encodeURIComponent(personId)}?${search.toString()}`,
    { signal },
  );
  await assertPortalOk(response, `Could not load this timetable (HTTP ${response.status}).`);
  return (await response.json()) as TimetableEntry[];
}

// ---------------------------------------------------------------------------
// Records - transcript, GPA, and issued report cards.
// ---------------------------------------------------------------------------

/** Mirrors `records.transcript_entry` (frozen at finalisation - never re-graded against a newer scale, see docs/decisions.md). */
export interface TranscriptEntry {
  id: string;
  tenantId: string;
  personId: string;
  academicYearId: string;
  termId: string;
  courseId: string;
  sectionId: string;
  courseCode: string;
  courseName: string;
  creditsAttempted: number;
  creditsEarned: number;
  percentage: number | null;
  letter: string | null;
  gpaPoints: number | null;
  gradeScaleVersionId: string | null;
}

/** What `getTranscript` returns - the student's full finalised academic history. */
export interface Transcript {
  personId: string;
  entries: TranscriptEntry[];
  /** Weighted by `creditsAttempted`, from stored `gpaPoints` only. `null` when no entry carries one. */
  cumulativeGpa: number | null;
  cumulativeCreditsAttempted: number;
  cumulativeCreditsEarned: number;
}

/** GET /api/v1/records/transcripts/:personId */
export async function fetchTranscript(personId: string, signal?: AbortSignal): Promise<Transcript> {
  const response = await portalFetch(`/records/transcripts/${encodeURIComponent(personId)}`, { signal });
  await assertPortalOk(response, `Could not load this transcript (HTTP ${response.status}).`);
  return (await response.json()) as Transcript;
}

/** One course row on an issued report card snapshot. */
export interface ReportCardCourseRow {
  sectionId: string;
  courseId: string;
  courseCode: string;
  courseName: string;
  credits: number | null;
  percentage: number | null;
  letter: string | null;
  gpaPoints: number | null;
  gradeScaleVersionId: string | null;
}

/** Attendance over the grading period, when the report card was generated with one wired up. `null` means unavailable, never a fabricated zero - same rule as the field's own source comment. */
export interface ReportCardAttendanceSummary {
  totalCount: number;
  presentCount: number;
  presentRate: number;
}

/** The full frozen snapshot a report card was issued with - see the `1200` migration header: an issued report card never re-computes, it replays what was true when issued. */
export interface ReportCardSnapshot {
  personId: string;
  studentName: string;
  gradingPeriodId: string;
  gradingPeriodName: string;
  termId: string;
  termName: string;
  academicYearId: string | null;
  academicYearName: string | null;
  courses: ReportCardCourseRow[];
  gpa: number | null;
  attendanceSummary: ReportCardAttendanceSummary | null;
  comments: string | null;
  generatedAt: string;
}

/** Mirrors `records.report_card`. */
export interface ReportCard {
  id: string;
  tenantId: string;
  reportCardRunId: string;
  personId: string;
  enrollmentId: string | null;
  documentId: string;
  snapshot: ReportCardSnapshot;
  gpa: number | null;
  createdAt: string;
}

/** GET /api/v1/records/report-cards?personId= */
export async function fetchReportCards(personId: string, signal?: AbortSignal): Promise<ReportCard[]> {
  const search = new URLSearchParams({ personId });
  const response = await portalFetch(`/records/report-cards?${search.toString()}`, { signal });
  await assertPortalOk(response, `Could not load report cards (HTTP ${response.status}).`);
  return (await response.json()) as ReportCard[];
}

/** A presigned, time-limited URL - PDFs never proxy through the API (see `DocumentsContract.getDownloadUrl`'s own comment). */
export interface DownloadUrl {
  url: string;
  expiresAt: string;
}

/** GET /api/v1/records/report-cards/:id/download-url */
export async function fetchReportCardDownloadUrl(reportCardId: string, signal?: AbortSignal): Promise<DownloadUrl> {
  const response = await portalFetch(`/records/report-cards/${encodeURIComponent(reportCardId)}/download-url`, {
    signal,
  });
  await assertPortalOk(response, `Could not get a download link for this report card (HTTP ${response.status}).`);
  return (await response.json()) as DownloadUrl;
}

// ---------------------------------------------------------------------------
// Billing - a parent/student is READ-ONLY here: there is no payment flow in
// Phase 1 (see portal/children/[personId]/page.tsx's Fees tab, which has no
// "Pay now" action for exactly that reason). `billing.invoice:read` is
// `dependants`-scoped for a guardian (their own children only) and
// `own`-scoped for a student account - `BillingController` narrows both
// server-side (see that controller's own top-of-file comment on why a
// `dependants` constraint is checked against `studentPersonId`, never
// `payerPersonId`), so nothing here needs to re-derive who may see what.
// ---------------------------------------------------------------------------

export type InvoiceStatus = 'draft' | 'issued';

/** Mirrors `billing.invoice`. Carries no balance/total column - see `InvoiceBalance` below; the total is derived, never stored. */
export interface Invoice {
  id: string;
  tenantId: string;
  studentPersonId: string;
  payerPersonId: string | null;
  currency: string;
  status: InvoiceStatus;
  dueDate: string | null;
  issuedAt: string | null;
  issuedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/v1/billing/invoices?studentPersonId= - the server rejects (403) a `studentPersonId` outside the caller's own dependants, never silently ignores or filters it. */
export async function fetchInvoicesForStudent(studentPersonId: string, signal?: AbortSignal): Promise<Invoice[]> {
  const search = new URLSearchParams({ studentPersonId });
  const response = await portalFetch(`/billing/invoices?${search.toString()}`, { signal });
  await assertPortalOk(response, `Could not load invoices (HTTP ${response.status}).`);
  return (await response.json()) as Invoice[];
}

/** Mirrors `InvoiceBalance` in `@sms/billing` - DERIVED from posted charge/payment/credit rows on every read, never a stored column. `balanceMinor` can be negative (a net credit on this one invoice). */
export interface InvoiceBalance {
  invoiceId: string;
  currency: string;
  chargesMinor: number;
  paidMinor: number;
  creditedMinor: number;
  balanceMinor: number;
}

/** GET /api/v1/billing/invoices/:id/balance */
export async function fetchInvoiceBalance(invoiceId: string, signal?: AbortSignal): Promise<InvoiceBalance> {
  const response = await portalFetch(`/billing/invoices/${encodeURIComponent(invoiceId)}/balance`, { signal });
  await assertPortalOk(response, `Could not load this invoice's balance (HTTP ${response.status}).`);
  return (await response.json()) as InvoiceBalance;
}

/** Mirrors `AccountBalance` in `@sms/billing` - the same derivation as `InvoiceBalance`, summed across every `issued` invoice a student has, grouped by currency. */
export interface AccountBalance {
  studentPersonId: string;
  currency: string;
  chargesMinor: number;
  paidMinor: number;
  creditedMinor: number;
  balanceMinor: number;
}

/** GET /api/v1/billing/students/:personId/balance */
export async function fetchStudentBalance(personId: string, signal?: AbortSignal): Promise<AccountBalance[]> {
  const response = await portalFetch(`/billing/students/${encodeURIComponent(personId)}/balance`, { signal });
  await assertPortalOk(response, `Could not load this student's balance (HTTP ${response.status}).`);
  return (await response.json()) as AccountBalance[];
}

// ---------------------------------------------------------------------------
// Communications - announcements and threads, always the CALLER's own
// participation for a non-tenant-scope caller (parent/student both resolve
// to their OWN linked person, never a dependant's - see
// `CommunicationsController.requireOwnPersonId`). There is genuinely no
// endpoint that reports PER-ANNOUNCEMENT read state to a non-tenant caller
// (`listAnnouncementRecipients` is `people.person:read`, tenant-only) - only
// the aggregate `unread-counts`. Screens here surface that honestly: the
// aggregate count is real, but no individual announcement can be marked
// "unread" from stale knowledge, only acted on going forward.
// ---------------------------------------------------------------------------

export type AnnouncementStatus = 'draft' | 'published' | 'superseded';

/** Mirrors `communications.announcement`. `audience` is the resolution QUERY, not resolved data - not rendered here (no `people.person:read`-gated endpoint to show what it resolved to). */
export interface Announcement {
  id: string;
  tenantId: string;
  title: string;
  body: string;
  category: string;
  campusId: string | null;
  status: AnnouncementStatus;
  publishedAt: string | null;
  publishedByUserId: string | null;
  supersededByAnnouncementId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/v1/communications/announcements - the caller's own addressed announcements (a non-tenant scope ignores any `forPersonId` and always resolves the caller's own - server-enforced). */
export async function fetchAnnouncements(signal?: AbortSignal): Promise<Announcement[]> {
  const response = await portalFetch('/communications/announcements', { signal });
  await assertPortalOk(response, `Could not load announcements (HTTP ${response.status}).`);
  return (await response.json()) as Announcement[];
}

/** GET /api/v1/communications/announcements/:id */
export async function fetchAnnouncement(id: string, signal?: AbortSignal): Promise<Announcement> {
  const response = await portalFetch(`/communications/announcements/${encodeURIComponent(id)}`, { signal });
  await assertPortalOk(response, `Could not load this announcement (HTTP ${response.status}).`);
  return (await response.json()) as Announcement;
}

/** POST /api/v1/communications/announcements/:id/read - idempotent; a repeat call is a harmless no-op. */
export async function markAnnouncementRead(id: string): Promise<void> {
  const response = await portalFetch(`/communications/announcements/${encodeURIComponent(id)}/read`, {
    method: 'POST',
  });
  await assertPortalOk(response, `Could not mark this announcement as read (HTTP ${response.status}).`);
}

export type ThreadSubjectType = 'people.person' | 'academic.section' | 'billing.invoice' | 'other';
export type ThreadStatus = 'open' | 'closed';
export type ThreadParticipantRole = 'owner' | 'participant' | 'observer';

/** Mirrors `communications.thread`. */
export interface Thread {
  id: string;
  tenantId: string;
  subject: string;
  subjectType: ThreadSubjectType;
  subjectId: string;
  status: ThreadStatus;
  createdByUserId: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors `communications.thread_participant`. `lastReadAt` is what per-participant unread state is computed from - see `fetchThread`'s own comment. */
export interface ThreadParticipant {
  id: string;
  tenantId: string;
  threadId: string;
  personId: string;
  role: ThreadParticipantRole;
  lastReadAt: string | null;
  muted: boolean;
  createdAt: string;
}

/** Mirrors `communications.message`. Append-only. */
export interface Message {
  id: string;
  tenantId: string;
  threadId: string;
  authorPersonId: string;
  body: string;
  idempotencyKey: string;
  sentAt: string;
}

/** What `getThread` returns - unlike announcements, this DOES carry enough to compute real per-thread unread state client-side: the caller's own `ThreadParticipant.lastReadAt` versus the newest message not authored by them (the exact logic `ThreadService.countUnreadThreads` runs server-side for the aggregate). */
export interface ThreadDetail {
  thread: Thread;
  participants: ThreadParticipant[];
  messages: Message[];
}

/** GET /api/v1/communications/threads - the caller's own participation only, for a non-tenant scope. */
export async function fetchThreads(signal?: AbortSignal): Promise<Thread[]> {
  const response = await portalFetch('/communications/threads', { signal });
  await assertPortalOk(response, `Could not load your messages (HTTP ${response.status}).`);
  return (await response.json()) as Thread[];
}

/** GET /api/v1/communications/threads/:id */
export async function fetchThread(id: string, signal?: AbortSignal): Promise<ThreadDetail> {
  const response = await portalFetch(`/communications/threads/${encodeURIComponent(id)}`, { signal });
  await assertPortalOk(response, `Could not load this conversation (HTTP ${response.status}).`);
  return (await response.json()) as ThreadDetail;
}

/**
 * POST /api/v1/communications/threads/:id/messages. `idempotencyKey` must be
 * generated ONCE per send attempt and reused for every retry of that same
 * attempt - same idempotency contract as `lib/api.ts`'s `markSession`/
 * `enterScores`, so a flaky-network double-tap can never post the reply twice.
 */
export async function postThreadMessage(
  threadId: string,
  input: { body: string; idempotencyKey: string },
): Promise<{ message: Message; replayed: boolean }> {
  const response = await portalFetch(`/communications/threads/${encodeURIComponent(threadId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  await assertPortalOk(response, `Could not send this message (HTTP ${response.status}).`);
  return (await response.json()) as { message: Message; replayed: boolean };
}

/** POST /api/v1/communications/threads/:id/read - sets the caller's own `lastReadAt` to now. */
export async function markThreadRead(id: string): Promise<void> {
  const response = await portalFetch(`/communications/threads/${encodeURIComponent(id)}/read`, { method: 'POST' });
  await assertPortalOk(response, `Could not mark this conversation as read (HTTP ${response.status}).`);
}

/** Mirrors `getUnreadCounts` - always the caller's own participation. */
export interface UnreadCounts {
  personId: string;
  unreadAnnouncements: number;
  unreadThreads: number;
}

/** GET /api/v1/communications/unread-counts */
export async function fetchUnreadCounts(signal?: AbortSignal): Promise<UnreadCounts> {
  const response = await portalFetch('/communications/unread-counts', { signal });
  await assertPortalOk(response, `Could not load your unread counts (HTTP ${response.status}).`);
  return (await response.json()) as UnreadCounts;
}

// ---------------------------------------------------------------------------
// Notifications - the caller's OWN preferences only ('own' scope; see
// @sms/access's seed.ts - a guardian manages their own mailing preference,
// never a dependant's). The only category genuinely wired to a send path
// anywhere in this codebase is `channel: 'email', category: 'attendance'`
// (`AttendanceAbsenceSubscriber`) - `GET /notifications/templates` (which
// would otherwise enumerate every category) is gated
// `notifications.template:manage`, which neither Parent/Guardian nor Student
// holds, so this is the one category the settings screen can honestly offer
// rather than guess at.
// ---------------------------------------------------------------------------

export type NotificationChannelName = 'email' | 'sms' | 'push';

/** Mirrors `notifications.preference`. Absence of a row for a given (channel, category) means "opted in" - the server's documented default (see `NotificationsService.isOptedOut`'s own comment) - never "unknown" or "opted out". */
export interface NotificationPreference {
  id: string;
  tenantId: string;
  personId: string;
  channel: NotificationChannelName;
  category: string;
  optedIn: boolean;
  updatedAt: string;
}

/** GET /api/v1/notifications/preferences/:personId - only the CALLER's own personId is accepted (server-enforced; see `NotificationsController.assertCanManagePreferences`). Returns only rows that have been explicitly set - never one per possible category. */
export async function fetchNotificationPreferences(
  personId: string,
  signal?: AbortSignal,
): Promise<NotificationPreference[]> {
  const response = await portalFetch(`/notifications/preferences/${encodeURIComponent(personId)}`, { signal });
  await assertPortalOk(response, `Could not load your notification preferences (HTTP ${response.status}).`);
  return (await response.json()) as NotificationPreference[];
}

/** PUT /api/v1/notifications/preferences/:personId - upserts one (channel, category) row. */
export async function setNotificationPreference(
  personId: string,
  input: { channel: NotificationChannelName; category: string; optedIn: boolean },
): Promise<NotificationPreference> {
  const response = await portalFetch(`/notifications/preferences/${encodeURIComponent(personId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  await assertPortalOk(response, `Could not save this preference (HTTP ${response.status}).`);
  return (await response.json()) as NotificationPreference;
}
