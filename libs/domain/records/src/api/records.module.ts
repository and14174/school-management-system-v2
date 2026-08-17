import { Module } from '@nestjs/common';
import { AccessModule } from '@sms/access';
import { AuditModule } from '@sms/audit';
import { OutboxModule } from '@sms/outbox';
import { DocumentsModule } from '@sms/documents';
import { PeopleModule } from '@sms/people';
import { AcademicModule } from '@sms/academic';
import { GradebookModule } from '@sms/gradebook';
import { RECORDS_CONTRACT } from '../contract.js';
import { CreditRuleSetService } from '../application/credit-rule-set.service.js';
import { ReportCardService } from '../application/report-card.service.js';
import { RecordsService } from '../application/records.service.js';
import { TranscriptService } from '../application/transcript.service.js';
import { RecordsController } from './records.controller.js';

/**
 * Exports `RECORDS_CONTRACT` (not the concrete `RecordsService`) - matching
 * `@sms/gradebook`'s `GradebookModule` shape. Imports every contract this
 * module reads through: `GradebookModule` (`getStudentGrades` - the ONE
 * evaluator a report card/transcript entry's percentage/letter/gpaPoints
 * come from), `AcademicModule` (`listGradingPeriods`/`listStudentsInSection`
 * - `@Global()` already, imported explicitly anyway for self-containedness,
 * same posture as `@sms/gradebook`'s own test setup), `PeopleModule`
 * (a report card's student name), `DocumentsModule`
 * (`DocumentsContract.generate`/`getDownloadUrl` - see the `1200` migration
 * header: an issued report card IS a rendered document), `AuditModule`
 * (`issueReportCards` runs inside `AuditContract.withBulkOperation`),
 * `OutboxModule` (`records.report_card_issued`), and `AccessModule`
 * (`@RequirePermission` plus `RecordsController`'s own direct
 * `resolveScopeConstraints` calls - see that file's own comment).
 *
 * Does NOT import `@sms/attendance` - `ReportCardService`'s
 * `AttendanceSummaryProvider` is an inversion port with a safe (`null`)
 * default; `apps/api` is the one layer allowed to bind the real
 * implementation. See `application/attendance-summary-provider.ts`.
 */
@Module({
  imports: [AccessModule, AuditModule, OutboxModule, DocumentsModule, PeopleModule, AcademicModule, GradebookModule],
  controllers: [RecordsController],
  providers: [
    CreditRuleSetService,
    ReportCardService,
    TranscriptService,
    RecordsService,
    { provide: RECORDS_CONTRACT, useExisting: RecordsService },
  ],
  exports: [RECORDS_CONTRACT],
})
export class RecordsModule {}
