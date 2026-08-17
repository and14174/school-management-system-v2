import type { DateOnly, PersonId, TenantId } from '@sms/kernel';
import type { ReportCardAttendanceSummary } from '../domain/types.js';

/**
 * The port that keeps this module free of a hard dependency on
 * `@sms/attendance` - the module brief's dependency list for `@sms/records`
 * does not include it, so an attendance summary is folded into a report card
 * "if available" through the exact inversion `@sms/documents` uses for
 * `DOCUMENT_TEMPLATE_REGISTRY` and `@sms/access` uses for
 * `SECTION_SCOPE_RESOLVER`: this module defines the port and a zero-widening
 * default (`DEFAULT_ATTENDANCE_SUMMARY_PROVIDER`, which always returns
 * `null`), and `apps/api` - the one layer allowed to depend on both this
 * module and `@sms/attendance` - binds the real implementation.
 */
export interface AttendanceSummaryProvider {
  /** `null` when no attendance data is available for this student/range (the default, and the honest answer when nothing is wired in) - never a fabricated zero. */
  getSummary(tenantId: TenantId, personId: PersonId, from: DateOnly, to: DateOnly): Promise<ReportCardAttendanceSummary | null>;
}

export const ATTENDANCE_SUMMARY_PROVIDER = Symbol('ATTENDANCE_SUMMARY_PROVIDER');

export const DEFAULT_ATTENDANCE_SUMMARY_PROVIDER: AttendanceSummaryProvider = {
  getSummary: async () => null,
};
