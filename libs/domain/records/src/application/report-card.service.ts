import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  NotFoundError,
  ValidationError,
  newId,
  todayDateOnly,
  type DomainError,
  type PersonId,
  type Result,
  type TenantId,
  err,
  ok,
} from '@sms/kernel';
import { runWithContext, withTenantTx, type Tx } from '@sms/db';
import { AUDIT_CONTRACT, type AuditContract } from '@sms/audit';
import { OUTBOX_CONTRACT, type OutboxContract } from '@sms/outbox';
import { DOCUMENTS_CONTRACT, type DocumentsContract } from '@sms/documents';
import { GRADEBOOK_CONTRACT, type GradebookContract } from '@sms/gradebook';
import { PEOPLE_CONTRACT, type PeopleContract } from '@sms/people';
import type { IssueReportCardsInput, IssueReportCardsResult, ListReportCardsInput, PreviewReportCardInput, ReportCardContext } from '../contract.js';
import type { ReportCard, ReportCardCourseRow, ReportCardSnapshot } from '../domain/types.js';
import { ATTENDANCE_SUMMARY_PROVIDER, DEFAULT_ATTENDANCE_SUMMARY_PROVIDER, type AttendanceSummaryProvider } from './attendance-summary-provider.js';
import { getEnrollmentId, getGradingPeriodContext, getGradingPeriodRoster, getSectionCourseInfoMap, getSectionRoster, type GradingPeriodContext } from './academic-lookup.js';
import { weightedGpa } from './gpa.js';
import { toReportCard, toReportCardRun } from '../infrastructure/mappers.js';
import { reportCardRunTable, reportCardTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

export const REPORT_CARD_TEMPLATE_KEY = 'report_card';

interface PreparedReportCard {
  readonly personId: PersonId;
  readonly enrollmentId: string | null;
  readonly snapshot: ReportCardSnapshot;
  readonly documentId: string;
}

/**
 * `previewReportCard`/`issueReportCards`/`getReportCard`/`listReportCards`.
 * See the `1200` migration header: an issued report card is a snapshot, not
 * a live view - `buildSnapshot` below is the ONE place that computation
 * happens, called identically by a preview (nothing written) and an issue
 * (the exact same snapshot frozen into `records.report_card.snapshot` and
 * handed to `@sms/documents`) - a preview computed by different logic than
 * the commit is a preview that lies (see `docs/decisions.md`).
 */
@Injectable()
export class ReportCardService {
  constructor(
    @Inject(GRADEBOOK_CONTRACT) private readonly gradebook: GradebookContract,
    @Inject(PEOPLE_CONTRACT) private readonly people: PeopleContract,
    @Inject(DOCUMENTS_CONTRACT) private readonly documents: DocumentsContract,
    @Inject(AUDIT_CONTRACT) private readonly audit: AuditContract,
    @Inject(OUTBOX_CONTRACT) private readonly outbox: OutboxContract,
    @Optional() @Inject(ATTENDANCE_SUMMARY_PROVIDER) private readonly attendance: AttendanceSummaryProvider = DEFAULT_ATTENDANCE_SUMMARY_PROVIDER,
  ) {}

  /** The full computed report for one student/grading period - shared by `previewReportCard` and `issueReportCards`. */
  private async buildSnapshot(
    tenantId: TenantId,
    ctx: ReturnType<typeof scopedContext>,
    personId: PersonId,
    gp: GradingPeriodContext,
  ): Promise<{ snapshot: ReportCardSnapshot; enrollmentId: string | null }> {
    const grades = await runWithContext(ctx, () => this.gradebook.getStudentGrades({ personId, gradingPeriodId: gp.id }));
    const sectionCourseMap = await getSectionCourseInfoMap(ctx, tenantId, grades.map((g) => g.sectionId));

    const courses: ReportCardCourseRow[] = grades.map((g) => {
      const info = sectionCourseMap.get(g.sectionId);
      return {
        sectionId: g.sectionId,
        courseId: info?.courseId ?? g.sectionId,
        courseCode: info?.courseCode ?? '—',
        courseName: info?.courseName ?? 'Unknown course',
        credits: info?.credits ?? null,
        percentage: g.percentage,
        letter: g.letter,
        gpaPoints: g.gpaPoints,
        gradeScaleVersionId: g.gradeScaleVersionId,
      };
    });

    const gpa = weightedGpa(courses.map((c) => ({ gpaPoints: c.gpaPoints, credits: c.credits ?? 0 })));

    const personResult = await runWithContext(ctx, () => this.people.getPerson(personId));
    const studentName = personResult.ok
      ? `${personResult.value.preferredName ?? personResult.value.givenName} ${personResult.value.familyName}`
      : 'Unknown Student';

    const attendanceSummary = await this.attendance.getSummary(tenantId, personId, gp.startsOn, gp.endsOn);
    const enrollmentId = await getEnrollmentId(ctx, tenantId, personId, gp.academicYearId);

    const snapshot: ReportCardSnapshot = {
      personId,
      studentName,
      gradingPeriodId: gp.id,
      gradingPeriodName: gp.name,
      termId: gp.termId,
      termName: gp.termName,
      academicYearId: gp.academicYearId,
      academicYearName: gp.academicYearName,
      courses,
      gpa,
      attendanceSummary,
      comments: null,
      generatedAt: new Date().toISOString(),
    };

    return { snapshot, enrollmentId };
  }

  async previewReportCard(tenantId: TenantId, input: PreviewReportCardInput): Promise<Result<ReportCardSnapshot, DomainError>> {
    const ctx = scopedContext(tenantId);
    const gp = await getGradingPeriodContext(ctx, tenantId, input.gradingPeriodId);
    if (!gp) {
      return err(new NotFoundError(`Grading period ${input.gradingPeriodId} not found.`));
    }
    const built = await this.buildSnapshot(tenantId, ctx, input.personId, gp);
    return ok(built.snapshot);
  }

  private async findRunByIdempotencyKey(tenantId: TenantId, ctx: ReturnType<typeof scopedContext>, idempotencyKey: string) {
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(reportCardRunTable)
        .where(and(eq(reportCardRunTable.tenantId, tenantId), eq(reportCardRunTable.idempotencyKey, idempotencyKey)))
        .limit(1),
    );
    return rows[0];
  }

  private async listByRun(tenantId: TenantId, ctx: ReturnType<typeof scopedContext>, runId: string): Promise<ReportCard[]> {
    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(reportCardTable).where(and(eq(reportCardTable.tenantId, tenantId), eq(reportCardTable.reportCardRunId, runId))),
    );
    return rows.map(toReportCard);
  }

  private async currentBulkOperationId(tx: Tx): Promise<string | null> {
    const rows = await tx.execute<{ id: string | null }>(sql`select current_setting('app.bulk_operation_id', true) as id`);
    return (rows as unknown as Array<{ id: string | null }>)[0]?.id ?? null;
  }

  /**
   * See `RecordsContract.issueReportCards`' doc comment. Document generation
   * (real I/O - PDF render, object-storage upload - see `@sms/documents`'
   * `1100` migration header) happens BEFORE the bulk-operation transaction
   * opens, one immutable `documents.document` write per student; the
   * transaction below is what makes writing every `records.report_card` row
   * and publishing `records.report_card_issued` atomic with EACH OTHER -
   * the property the module brief calls out explicitly.
   */
  async issueReportCards(tenantId: TenantId, input: IssueReportCardsInput): Promise<Result<IssueReportCardsResult, DomainError>> {
    const ctx = scopedContext(tenantId);
    const asOf = todayDateOnly();

    try {
      const existingRun = await this.findRunByIdempotencyKey(tenantId, ctx, input.idempotencyKey);
      if (existingRun) {
        const cards = await this.listByRun(tenantId, ctx, existingRun.id);
        return ok({ run: toReportCardRun(existingRun), reportCards: cards, replayed: true });
      }

      const personIds = input.sectionId
        ? await getSectionRoster(ctx, tenantId, input.sectionId, asOf)
        : await getGradingPeriodRoster(ctx, tenantId, input.gradingPeriodId, asOf);
      if (personIds.length === 0) {
        return err(new ValidationError('No enrolled students were found to issue report cards for.'));
      }

      const gp = await getGradingPeriodContext(ctx, tenantId, input.gradingPeriodId);
      if (!gp) {
        return err(new NotFoundError(`Grading period ${input.gradingPeriodId} not found.`));
      }

      const prepared: PreparedReportCard[] = [];
      for (const personId of personIds) {
        const { snapshot, enrollmentId } = await this.buildSnapshot(tenantId, ctx, personId, gp);
        if (snapshot.courses.length === 0) {
          // Nothing gradeable for this student this period yet - skip rather
          // than issue a blank artefact; not an error for the whole batch.
          continue;
        }
        const generated = await runWithContext(ctx, () =>
          this.documents.generate({
            templateKey: REPORT_CARD_TEMPLATE_KEY,
            subjectType: 'people.person',
            subjectId: personId,
            title: `Report Card - ${snapshot.studentName} - ${snapshot.gradingPeriodName}`,
            data: snapshot,
          }),
        );
        if (!generated.ok) {
          return err(generated.error);
        }
        prepared.push({ personId, enrollmentId, snapshot, documentId: generated.value.id });
      }

      if (prepared.length === 0) {
        return err(new ValidationError('None of the selected students have gradeable results for this grading period.'));
      }

      const outcome = await runWithContext(ctx, () =>
        this.audit.withBulkOperation(
          {
            kind: 'records.issue_report_cards',
            summary: { gradingPeriodId: input.gradingPeriodId, sectionId: input.sectionId ?? null, studentCount: prepared.length },
          },
          async (tx) => {
            const bulkOperationId = await this.currentBulkOperationId(tx);

            const runRows = await tx
              .insert(reportCardRunTable)
              .values({
                id: newId(),
                tenantId,
                gradingPeriodId: input.gradingPeriodId,
                sectionId: input.sectionId ?? null,
                idempotencyKey: input.idempotencyKey,
                status: 'issued',
                issuedAt: new Date(),
                issuedByUserId: ctx.actorUserId ?? ctx.userId ?? null,
                documentCount: prepared.length,
                bulkOperationId,
              })
              .returning();
            const runRow = runRows[0];
            if (!runRow) throw new Error('records.report_card_run insert returned no row.');

            const cards: ReportCard[] = [];
            for (const item of prepared) {
              const rows = await tx
                .insert(reportCardTable)
                .values({
                  id: newId(),
                  tenantId,
                  reportCardRunId: runRow.id,
                  personId: item.personId,
                  enrollmentId: item.enrollmentId,
                  documentId: item.documentId,
                  snapshot: item.snapshot,
                  gpa: item.snapshot.gpa,
                })
                .returning();
              const row = rows[0];
              if (!row) throw new Error('records.report_card insert returned no row.');
              cards.push(toReportCard(row));

              await this.outbox.publish(tx, {
                topic: 'records.report_card_issued',
                payload: { reportCardId: row.id, reportCardRunId: runRow.id, personId: item.personId, documentId: item.documentId, gradingPeriodId: input.gradingPeriodId },
              });
            }

            return { run: toReportCardRun(runRow), reportCards: cards };
          },
        ),
      );

      return ok({ ...outcome, replayed: false });
    } catch (error) {
      return err(toDomainError(error, 'Could not issue report cards.') as DomainError);
    }
  }

  async getReportCard(tenantId: TenantId, id: string): Promise<Result<ReportCard, NotFoundError>> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) => db.select().from(reportCardTable).where(and(eq(reportCardTable.tenantId, tenantId), eq(reportCardTable.id, id))).limit(1));
    const row = rows[0];
    if (!row) return err(new NotFoundError(`Report card ${id} not found.`));
    return ok(toReportCard(row));
  }

  async listReportCards(tenantId: TenantId, input: ListReportCardsInput): Promise<ReportCard[]> {
    const ctx = scopedContext(tenantId);
    const conditions = [eq(reportCardTable.tenantId, tenantId)];
    if (input.personId) conditions.push(eq(reportCardTable.personId, input.personId));
    if (input.runId) conditions.push(eq(reportCardTable.reportCardRunId, input.runId));
    const rows = await withTenantTx(ctx, (db) => db.select().from(reportCardTable).where(and(...conditions)).orderBy(desc(reportCardTable.createdAt)));
    return rows.map(toReportCard);
  }

  async getReportCardContext(tenantId: TenantId, id: string): Promise<ReportCardContext | null> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select({ personId: reportCardTable.personId, sectionId: reportCardRunTable.sectionId })
        .from(reportCardTable)
        .innerJoin(reportCardRunTable, eq(reportCardRunTable.id, reportCardTable.reportCardRunId))
        .where(and(eq(reportCardTable.tenantId, tenantId), eq(reportCardTable.id, id)))
        .limit(1),
    );
    const row = rows[0];
    return row ? { personId: row.personId as PersonId, sectionId: row.sectionId } : null;
  }
}
