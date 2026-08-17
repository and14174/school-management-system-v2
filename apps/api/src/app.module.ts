import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { TenancyModule } from '@sms/tenancy';
import { AuthGuard, IdentityModule } from '@sms/identity';
import { AccessModule, FieldMaskingInterceptor, PermissionGuard } from '@sms/access';
import { ApiKeyGuard, PublicApiModule } from '@sms/public-api';
import { CustomFieldsModule } from '@sms/custom-fields';
import { PeopleModule } from '@sms/people';
import { AcademicModule } from '@sms/academic';
import { EnrollmentModule } from '@sms/enrollment';
import { AdmissionsModule } from '@sms/admissions';
import { AttendanceModule } from '@sms/attendance';
import { GradebookModule } from '@sms/gradebook';
import { ImportExportModule } from '@sms/import-export';
import { DocumentsModule } from '@sms/documents';
import { RecordsModule } from '@sms/records';
import { CommunicationsModule } from '@sms/communications';
import { BillingModule } from '@sms/billing';
import { ApprovalsModule } from '@sms/approvals';
import { NotificationsModule } from '@sms/notifications';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter.js';
import { TenantContextInterceptor } from './common/interceptors/tenant-context.interceptor.js';
import { AppConfigModule } from './config/config.module.js';
import type { AppEnv } from './config/env.schema.js';
import { HealthModule } from './health/health.module.js';
import { ImportTargetsModule } from './import-export/people-import-target.module.js';
import { DependantScopeResolverModule } from './access/dependant-scope-resolver.module.js';
import { DocumentTemplatesModule } from './documents/document-templates.module.js';
import { AttendanceSummaryProviderModule } from './records/attendance-summary-provider.module.js';
import { NotificationChannelsModule } from './notifications/notification-channels.module.js';
import { AttendanceAbsenceSubscriberModule } from './notifications/attendance-absence-subscriber.module.js';
import { CreditNoteApprovalHandlerModule } from './billing/credit-note-approval-handler.module.js';

function isPinoPrettyAvailable(): boolean {
  // pino-pretty is not in this workspace's dependency set (it's not listed
  // among the pre-installed api deps, and we don't install new packages -
  // see the M0 report). Degrade to pino's plain JSON output rather than
  // crashing the whole app at boot if it's absent, but use it when present
  // since it's much easier to read during local dev.
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AppEnv, true>) => ({
        pinoHttp: {
          level: configService.get('LOG_LEVEL', { infer: true }),
          // Fastify's genReqId (set in main.ts) already assigned request.id;
          // pino-http's fastify integration reuses it automatically so every
          // log line, the tenant context and the error envelope all carry
          // the exact same requestId.
          transport:
            configService.get('NODE_ENV', { infer: true }) === 'development' && isPinoPrettyAvailable()
              ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss.l' } }
              : undefined,
        },
      }),
    }),
    HealthModule,
    TenancyModule,
    IdentityModule,
    AccessModule,
    CustomFieldsModule,
    PeopleModule,
    // @Global(): the sole place @sms/access's DEPENDANT_SCOPE_RESOLVER default
    // (resolves to nothing) gets overridden with the real identity.membership
    // -> people.relationship walk - see DependantScopeResolverModule's own
    // comment (same AcademicModule/SECTION_SCOPE_RESOLVER precedent
    // immediately below, except the real implementation lives here in
    // apps/api rather than inside a domain module).
    DependantScopeResolverModule,
    // @Global(): also the sole place @sms/academic's real SectionScopeResolverService
    // gets bound over @sms/access's zero-widening default - see AcademicModule's
    // own comment for why importing it here (rather than from AccessModule)
    // is what makes the override actually reach AbilityService.
    AcademicModule,
    EnrollmentModule,
    // Basic admissions pipeline (enquiry -> applied -> assessment -> offered
    // -> accepted/rejected/withdrawn) - see @sms/admissions' module report.
    // DecisionService hands an accepted applicant to EnrollmentModule/
    // PeopleModule through their public contracts on acceptance, so both
    // must already be registered above.
    AdmissionsModule,
    // The first real producer of domain events (attendance.marked_absent,
    // through @sms/outbox) - see @sms/attendance's module report.
    AttendanceModule,
    // Versioned grade scales/calculation rule sets, assignments/scores,
    // grading-period locking and standards-based outcomes - see
    // @sms/gradebook's module report.
    GradebookModule,
    // @Global(): the sole place @sms/import-export's IMPORT_TARGET_REGISTRY
    // default gets overridden with the real people.person target - see
    // ImportTargetsModule's own comment (same AcademicModule/
    // SECTION_SCOPE_RESOLVER precedent immediately above).
    ImportTargetsModule,
    ImportExportModule,
    // @Global(): the sole place @sms/documents' DOCUMENT_TEMPLATE_REGISTRY
    // default gets overridden with the sample-certificate template - see
    // DocumentTemplatesModule's own comment (same ImportTargetsModule /
    // AcademicModule precedent above).
    DocumentTemplatesModule,
    DocumentsModule,
    // @Global(): the sole place @sms/records' ATTENDANCE_SUMMARY_PROVIDER
    // default gets overridden with a real @sms/attendance-backed
    // implementation - see AttendanceSummaryProviderModule's own comment
    // (same DocumentTemplatesModule/ImportTargetsModule precedent above).
    // Imported before RecordsModule so the override is visible the moment
    // RecordsModule's own providers resolve.
    AttendanceSummaryProviderModule,
    // Report cards (issued as immutable document snapshots), append-only
    // transcripts, GPA and versioned credit/promotion rules - see
    // @sms/records' module report.
    RecordsModule,
    // Announcements with a frozen, publish-time recipient list and threaded
    // messaging always anchored to a subject (a student, a section, ...) -
    // see @sms/communications' module report. Publishes communications.
    // announcement_published / communications.message_posted through
    // @sms/outbox, same transactional-outbox discipline as @sms/attendance.
    CommunicationsModule,
    // The generic "someone else must sign off" workflow engine - an
    // append-only request, then a one-time decision that applies the change
    // through a domain-registered handler, with the requester-cannot-approve-
    // their-own-request rule enforced at the database level. See
    // @sms/approvals' 1700 migration header. Imported before BillingModule so
    // its APPROVALS_CONTRACT is already resolvable when BillingModule's own
    // providers (CreditNoteService) resolve.
    ApprovalsModule,
    // Versioned fee schedules, invoices priced from an immutable fee-schedule
    // version, idempotent payment recording with explicit allocation, and
    // credit notes as the only correction to an issued invoice - see
    // @sms/billing's 1400 migration header. Publishes billing.invoice_issued /
    // billing.payment_recorded through @sms/outbox, same transactional-outbox
    // discipline as @sms/attendance/@sms/communications. Its credit notes are
    // also the pilot integration for @sms/approvals (opt-in, above a
    // configurable threshold - see the 1401 migration header).
    BillingModule,
    // @Global(): the sole place @sms/approvals' APPROVAL_HANDLER_REGISTRY
    // default (resolves to nothing) gets overridden with
    // CreditNoteApprovalHandler - see that module's own comment (same
    // AttendanceAbsenceSubscriberModule/AcademicModule/SECTION_SCOPE_RESOLVER
    // precedent elsewhere in this file).
    CreditNoteApprovalHandlerModule,
    // @Global(): the sole place @sms/notifications' NOTIFICATION_CHANNEL_REGISTRY
    // and RECIPIENT_RESOLVER defaults get overridden with the real email
    // (nodemailer -> Mailpit)/console-SMS adapters and the people.relationship
    // guardian walker - see NotificationChannelsModule's own comment (same
    // DocumentTemplatesModule/ImportTargetsModule precedent above). Imported
    // before NotificationsModule so the override is visible the moment
    // NotificationsModule's own providers resolve.
    NotificationChannelsModule,
    // Closes the loop the transactional outbox was built for:
    // attendance.marked_absent becoming a real message to a guardian - see
    // @sms/notifications' 1300 migration header.
    NotificationsModule,
    // @Global(): the sole place @sms/outbox's OUTBOX_SUBSCRIBERS default
    // (empty) gets overridden with AttendanceAbsenceSubscriber - see that
    // module's own comment (same AcademicModule/SECTION_SCOPE_RESOLVER
    // precedent above).
    AttendanceAbsenceSubscriberModule,
    // Machine access to the API: `Authorization: Bearer <api key>` in place
    // of a human session - keys bound to a tenant and an explicit subset of
    // their minting user's own permissions, revocable, rate-limited (Redis)
    // and attributable. See @sms/public-api's 1600 migration header and
    // ApiKeyGuard's own comment (registered below, deliberately BEFORE
    // AuthGuard).
    PublicApiModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    // Registration order matters for both guards and interceptors (Nest
    // runs each group in the order they're provided):
    //   ApiKeyGuard -> AuthGuard -> PermissionGuard: ApiKeyGuard populates
    //     `request.identity` for `Authorization: Bearer <api key>` requests
    //     BEFORE AuthGuard runs, so AuthGuard's own early-return ("already
    //     authenticated by an earlier guard" - see its comment) can see it
    //     and skip trying to resolve a Better Auth cookie session that a
    //     machine client never sent. PermissionGuard reads `request.identity`
    //     too, which only exists once one of the first two guards has set it.
    //   TenantContextInterceptor -> FieldMaskingInterceptor: guards run
    //     before interceptors entirely, so by the time either interceptor
    //     runs `request.identity` is already set; FieldMaskingInterceptor
    //     additionally needs the ambient TenantContext TenantContextInterceptor
    //     establishes (via ALS `runWithContext`), so it must be the inner
    //     (later-registered) one - see its own comment.
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: FieldMaskingInterceptor },
  ],
})
export class AppModule {}
