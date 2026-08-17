/**
 * Fetchers backing the adaptive dashboard - apps/web/src/app/(admin)/dashboard/**.
 * Kept separate from lib/api.ts (owned by another agent working concurrently -
 * see the dashboard task's own CONSTRAINTS) even though several of these mirror
 * its shape exactly. Every endpoint below was read from its controller under
 * libs/*\/*\/src/api/*.controller.ts, not guessed:
 *
 *   - GET /academic/schedule-conflicts   -> libs/domain/academic/src/api/scheduling.controller.ts
 *   - GET /communications/unread-counts  -> libs/domain/communications/src/api/communications.controller.ts
 *   - GET /attendance/corrections        -> libs/domain/attendance/src/api/attendance.controller.ts
 *   - GET /enrollment/enrollments        -> libs/domain/enrollment/src/api/enrollments.controller.ts (already
 *     exported as fetchEnrollments() from lib/api.ts; fetchEnrollmentCounts below pages through it rather than
 *     re-implementing the request, since no dedicated stats endpoint exists).
 *   - GET /billing/summary               -> libs/domain/billing/src/api/billing.controller.ts (added alongside
 *     this card - see BillingSummary's own doc comment for what each figure means and how it is scoped).
 *
 * `dashboardFetch`/`assertDashboardOk` intentionally mirror the private helpers
 * in lib/api.ts (peopleFetch/assertPeopleOk, attendanceFetch/assertAttendanceOk,
 * etc.) - that file cannot be imported into for a shared helper without editing
 * it, and this is a small enough shape to duplicate rather than fight the
 * ownership boundary over.
 */
import { API_URL, ApiUnreachableError, ENROLLMENT_STATUSES, fetchEnrollments, type AccessPermissionGrant, type AccessScope, type AttendanceCorrection, type EnrollmentStatus } from './api';
import { ForbiddenError, UnauthorizedError } from './http';

async function dashboardFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_URL}/api/v1${path}`, {
      credentials: 'include',
      ...init,
    });
  } catch (cause) {
    throw new ApiUnreachableError(cause);
  }
}

async function assertDashboardOk(response: Response, fallbackMessage: string): Promise<void> {
  if (response.status === 401) throw new UnauthorizedError();
  if (response.status === 403) throw new ForbiddenError();
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? fallbackMessage);
  }
}

/**
 * The scope a permission grant was resolved at (see AccessScope's own
 * comment in lib/api.ts: own | section | grade_level | campus | tenant), or
 * `undefined` if the caller does not hold `key` at all. A UX convenience
 * only, exactly like usePermissions().can() - it decides which dashboard
 * cards bother to render, nothing more; the server re-checks (and
 * data-filters by) the real scope on every request regardless.
 *
 * Several dashboard cards need this because the underlying endpoint itself
 * silently narrows to nothing for a caller whose scope it cannot use rather
 * than 403ing (e.g. `schedule-conflicts` and the tenant-wide read of
 * `unmarked-sessions` both return [] for a non-`tenant` caller - see their
 * controllers' own comments). Gating on `can(key)` alone would render a card
 * reading "0 conflicts" for a section-scoped teacher, indistinguishable from
 * a real all-clear - exactly the ambiguous zero the task brief warns against.
 * Checking the granted scope instead lets the card be omitted for a caller
 * who can never get a meaningful answer from it, without switching on any
 * role name.
 */
export function permissionScope(
  permissions: readonly AccessPermissionGrant[],
  key: string,
): AccessScope | undefined {
  return permissions.find((permission) => permission.key === key)?.scope;
}

/**
 * Cards that need the tenant's current academic year (EnrolmentCard,
 * SchedulingCard) derive it from the SAME `GET /tenancy/scope` call the rest
 * of the admin shell already uses (see people/page.tsx's identical query
 * key). A plain `string | null` can't distinguish "still loading" from "loaded,
 * and there genuinely is no current year" from "the scope call itself
 * failed" - collapsing the last two would render a real fetch failure as the
 * calm, truthful-looking "no current academic year is configured" message,
 * which is exactly the kind of dishonest zero the dashboard exists to avoid.
 */
export type AcademicYearState =
  | { status: 'loading' }
  | { status: 'error'; message: string; retry: () => void }
  | { status: 'ready'; academicYearId: string | null };

// ---------------------------------------------------------------------------
// Scheduling - outstanding conflicts (tenant-wide report; see
// SchedulingController.scheduleConflicts's own comment: only a tenant-scoped
// caller gets anything back).
// ---------------------------------------------------------------------------

export type ConflictKind = 'room' | 'teacher';

/** Mirrors `libs/domain/academic/src/domain/types.ts`'s `ScheduleConflict`. */
export interface ScheduleConflict {
  kind: ConflictKind;
  periodId: string;
  dayOfWeek: number;
  sectionMeetingIdA: string;
  sectionIdA: string;
  sectionMeetingIdB: string;
  sectionIdB: string;
  roomId: string | null;
  personId: string | null;
}

/** GET /api/v1/academic/schedule-conflicts - every unresolved room/teacher double-booking for `academicYearId`. */
export async function fetchScheduleConflicts(
  academicYearId: string,
  signal?: AbortSignal,
): Promise<ScheduleConflict[]> {
  const response = await dashboardFetch(
    `/academic/schedule-conflicts?academicYearId=${encodeURIComponent(academicYearId)}`,
    { signal },
  );
  await assertDashboardOk(response, `Could not load schedule conflicts (HTTP ${response.status}).`);
  return (await response.json()) as ScheduleConflict[];
}

// ---------------------------------------------------------------------------
// Communications - the caller's own unread announcements/threads.
// ---------------------------------------------------------------------------

/** Mirrors `libs/domain/communications/src/domain/types.ts`'s `UnreadCounts`. */
export interface UnreadCounts {
  personId: string;
  unreadAnnouncements: number;
  unreadThreads: number;
}

/**
 * GET /api/v1/communications/unread-counts - always the CALLER's own
 * participation (`CommunicationsController.getUnreadCounts` resolves
 * `personId` from the session, taking none). Throws `ForbiddenError` for a
 * caller with no linked `people.person` row at all (see that controller's
 * `requireOwnPersonId`) - a real, distinct outcome from "zero unread",
 * meaning "this account has no personal inbox", not "nothing new".
 */
export async function fetchUnreadCounts(signal?: AbortSignal): Promise<UnreadCounts> {
  const response = await dashboardFetch('/communications/unread-counts', { signal });
  await assertDashboardOk(response, `Could not load your unread counts (HTTP ${response.status}).`);
  return (await response.json()) as UnreadCounts;
}

// ---------------------------------------------------------------------------
// Attendance - corrections awaiting approval (attendance.correction:approve,
// held tenant-wide only - see @sms/access's seed.ts: never granted to
// Teacher, so no scope narrowing to reason about here).
// ---------------------------------------------------------------------------

/** GET /api/v1/attendance/corrections?status=pending - not exported from lib/api.ts (only the POST helpers are), so it lives here. */
export async function fetchPendingCorrections(signal?: AbortSignal): Promise<AttendanceCorrection[]> {
  const response = await dashboardFetch('/attendance/corrections?status=pending', { signal });
  await assertDashboardOk(response, `Could not load pending corrections (HTTP ${response.status}).`);
  return (await response.json()) as AttendanceCorrection[];
}

// ---------------------------------------------------------------------------
// Enrolment - real counts by status. No dedicated stats endpoint exists (see
// `EnrollmentPage` in lib/api.ts: `{ items, nextCursor }`, no total) - the
// list endpoint is already server-scoped per caller (campus-scoped grants
// only ever see their own campus's rows - EnrollmentsController.
// applyEnrollmentConstraint), so paging through it and tallying client-side
// reports a real, correctly-scoped count rather than fabricating one.
// Bounded to MAX_PAGES so a runaway server bug can't hang the dashboard
// forever - the demo tenant's enrolment is a few dozen rows, nowhere near
// the cap.
// ---------------------------------------------------------------------------

const ENROLLMENT_COUNT_PAGE_SIZE = 200;
const MAX_ENROLLMENT_COUNT_PAGES = 25;

export interface EnrollmentCounts {
  byStatus: Record<EnrollmentStatus, number>;
  total: number;
  /** `true` when MAX_ENROLLMENT_COUNT_PAGES was hit before exhausting the result set - the count is a true lower bound, not the full total. Surfaced so the UI never silently understates it. */
  truncated: boolean;
}

export async function fetchEnrollmentCounts(
  params: { academicYearId?: string; campusId?: string },
  signal?: AbortSignal,
): Promise<EnrollmentCounts> {
  const byStatus = Object.fromEntries(ENROLLMENT_STATUSES.map((status) => [status, 0])) as Record<
    EnrollmentStatus,
    number
  >;
  let total = 0;
  let cursor: string | undefined;
  let truncated = false;

  for (let page = 0; page < MAX_ENROLLMENT_COUNT_PAGES; page += 1) {
    const result = await fetchEnrollments(
      {
        academicYearId: params.academicYearId,
        campusId: params.campusId,
        limit: ENROLLMENT_COUNT_PAGE_SIZE,
        cursor,
      },
      signal,
    );
    for (const item of result.items) {
      byStatus[item.status] += 1;
      total += 1;
    }
    if (!result.nextCursor) {
      break;
    }
    cursor = result.nextCursor;
    if (page === MAX_ENROLLMENT_COUNT_PAGES - 1) {
      truncated = true;
    }
  }

  return { byStatus, total, truncated };
}

// ---------------------------------------------------------------------------
// Billing - tenant-level totals (billing.invoice:read, held tenant-wide by
// finance/school_administrator - see @sms/access's seed.ts). Aggregated
// server-side in SQL (BillingController.getBillingSummary /
// InvoiceService.getBillingSummary) - never computed here by listing
// invoices and summing client-side.
// ---------------------------------------------------------------------------

/** Mirrors `libs/domain/billing/src/domain/types.ts`'s `BillingSummary`. `currency` is `null` only when there is no issued invoice anywhere in scope - a genuine "nothing to report" state, never a guessed default. */
export interface BillingSummary {
  currency: string | null;
  outstandingMinor: number;
  overdueInvoiceCount: number;
  collectedMinor: number;
  collectedWindowDays: number;
}

/** GET /api/v1/billing/summary */
export async function fetchBillingSummary(signal?: AbortSignal): Promise<BillingSummary> {
  const response = await dashboardFetch('/billing/summary', { signal });
  await assertDashboardOk(response, `Could not load billing totals (HTTP ${response.status}).`);
  return (await response.json()) as BillingSummary;
}
