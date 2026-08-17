import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { ATTENDANCE_CONTRACT, AttendanceModule, type AttendanceContract } from '@sms/attendance';
import { ATTENDANCE_SUMMARY_PROVIDER, type AttendanceSummaryProvider, type ReportCardAttendanceSummary } from '@sms/records';
import type { DateOnly, PersonId, TenantId } from '@sms/kernel';
import { runWithContext } from '@sms/db';

/**
 * The real `AttendanceSummaryProvider` - backed by `@sms/attendance`'s
 * `ATTENDANCE_CONTRACT`. `@sms/records` (`type:domain`) deliberately does
 * NOT depend on `@sms/attendance` (see that module's `application/
 * attendance-summary-provider.ts` for the full reasoning - same inversion
 * `DOCUMENT_TEMPLATE_REGISTRY`/`SECTION_SCOPE_RESOLVER` use); `apps/api` is
 * the one layer allowed to depend on both, so it is the one place this port
 * is ever bound to something real.
 */
@Injectable()
class RealAttendanceSummaryProvider implements AttendanceSummaryProvider {
  constructor(@Inject(ATTENDANCE_CONTRACT) private readonly attendance: AttendanceContract) {}

  async getSummary(tenantId: TenantId, personId: PersonId, from: DateOnly, to: DateOnly): Promise<ReportCardAttendanceSummary | null> {
    // `AttendanceContract` methods resolve the ambient tenant context; the
    // caller (`ReportCardService`, `type:domain`) has no ambient context
    // guarantee of its own callers, so this establishes one explicitly -
    // same idiom as this module's own `scopedContext` helpers.
    const summary = await runWithContext({ tenantId, roles: [], requestId: `records-attendance-summary-${personId}` }, () =>
      this.attendance.getAttendanceSummary({ personId, from, to }),
    );
    if (summary.totalCount === 0) {
      return null;
    }
    return { totalCount: summary.totalCount, presentCount: summary.presentCount, presentRate: summary.attendancePercentage };
  }
}

/**
 * `@Global()`: this is what actually lets `@sms/records`' `ReportCardService`
 * (living inside `RecordsModule`'s own DI container) see the
 * `ATTENDANCE_SUMMARY_PROVIDER` override - exactly the reasoning
 * `DocumentTemplatesModule`/`ImportTargetsModule` document for their own
 * tokens (same file shape, same precedent). `apps/api`'s `AppModule` still
 * has to import this module once for Nest to instantiate it.
 */
@Global()
@Module({
  imports: [AttendanceModule],
  providers: [RealAttendanceSummaryProvider, { provide: ATTENDANCE_SUMMARY_PROVIDER, useExisting: RealAttendanceSummaryProvider }],
  exports: [ATTENDANCE_SUMMARY_PROVIDER],
})
export class AttendanceSummaryProviderModule {}
