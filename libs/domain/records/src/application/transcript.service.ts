import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { NotFoundError, PreconditionFailedError, ValidationError, newId, type DomainError, type PersonId, type Result, type TenantId, err, ok } from '@sms/kernel';
import { runWithContext, withTenantTx } from '@sms/db';
import { ACADEMIC_CONTRACT, type AcademicContract } from '@sms/academic';
import { GRADEBOOK_CONTRACT, type GradebookContract } from '@sms/gradebook';
import type { CalculateGpaInput, CheckPromotionEligibilityInput, FinaliseTranscriptEntriesInput } from '../contract.js';
import type { PromotionEligibility, Transcript, TranscriptEntry } from '../domain/types.js';
import { getEnrollmentGradeLevelId, getSectionCourseInfoMap, getTermAcademicYearId } from './academic-lookup.js';
import { CreditRuleSetService } from './credit-rule-set.service.js';
import { weightedGpa } from './gpa.js';
import { toTranscriptEntry } from '../infrastructure/mappers.js';
import { transcriptEntryTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * `finaliseTranscriptEntries`/`getTranscript`/`calculateGpa`/
 * `checkPromotionEligibility`. See the `1200` migration header: entries are
 * finalised ONCE (percentage/letter/gpaPoints copied in, never recomputed
 * later) and every GPA figure this class produces is `weightedGpa` (`gpa.ts`)
 * over those stored columns - never a re-derivation from a live grade-scale
 * join.
 */
@Injectable()
export class TranscriptService {
  constructor(
    @Inject(ACADEMIC_CONTRACT) private readonly academic: AcademicContract,
    @Inject(GRADEBOOK_CONTRACT) private readonly gradebook: GradebookContract,
    @Inject(CreditRuleSetService) private readonly creditRuleSets: CreditRuleSetService,
  ) {}

  /**
   * Finalises `input.termId`'s FINAL grading period (highest `sequence`,
   * tie-broken by the latest `endsOn`) for `input.personId` - the grading
   * period a term's grade is read off, matching how a real report card cycle
   * works (progress periods feed into one term grade). Idempotent per
   * `(personId, sectionId)` via `transcript_entry`'s unique index
   * (`onConflictDoNothing`): re-finalising an already-finalised section is a
   * no-op, never a duplicate row or a silent overwrite - see the `1200`
   * migration header.
   */
  async finaliseTranscriptEntries(tenantId: TenantId, input: FinaliseTranscriptEntriesInput): Promise<Result<readonly TranscriptEntry[], DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const academicYearId = await getTermAcademicYearId(ctx, tenantId, input.termId);
      if (!academicYearId) {
        return err(new NotFoundError(`Term ${input.termId} not found.`));
      }

      const gradingPeriods = await runWithContext(ctx, () => this.academic.listGradingPeriods(input.termId));
      if (gradingPeriods.length === 0) {
        return err(new PreconditionFailedError(`Term ${input.termId} has no grading periods to finalise from.`));
      }
      const finalPeriod = [...gradingPeriods].sort((a, b) => b.sequence - a.sequence || (a.endsOn < b.endsOn ? 1 : -1))[0]!;

      const grades = await runWithContext(ctx, () => this.gradebook.getStudentGrades({ personId: input.personId, gradingPeriodId: finalPeriod.id }));
      if (grades.length === 0) {
        return err(new PreconditionFailedError(`No computed grades were found for person ${input.personId} in term ${input.termId}'s final grading period.`));
      }

      const sectionCourseMap = await getSectionCourseInfoMap(ctx, tenantId, grades.map((g) => g.sectionId));

      await withTenantTx(ctx, async (db) => {
        for (const grade of grades) {
          const info = sectionCourseMap.get(grade.sectionId);
          if (!info) continue; // defensive: a section with no resolvable course - should not happen
          const creditsAttempted = info.credits ?? 0;
          const creditsEarned = grade.gpaPoints !== null && grade.gpaPoints > 0 ? creditsAttempted : 0;

          await db
            .insert(transcriptEntryTable)
            .values({
              id: newId(),
              tenantId,
              personId: input.personId,
              academicYearId,
              termId: input.termId,
              courseId: info.courseId,
              sectionId: grade.sectionId,
              courseCode: info.courseCode,
              courseName: info.courseName,
              creditsAttempted,
              creditsEarned,
              percentage: grade.percentage,
              letter: grade.letter,
              gpaPoints: grade.gpaPoints,
              gradeScaleVersionId: grade.gradeScaleVersionId,
            })
            .onConflictDoNothing();
        }
      });

      const all = await withTenantTx(ctx, (db) =>
        db
          .select()
          .from(transcriptEntryTable)
          .where(and(eq(transcriptEntryTable.tenantId, tenantId), eq(transcriptEntryTable.personId, input.personId), eq(transcriptEntryTable.termId, input.termId)))
          .orderBy(asc(transcriptEntryTable.finalisedAt)),
      );
      return ok(all.map(toTranscriptEntry));
    } catch (error) {
      return err(toDomainError(error, `Could not finalise transcript entries for person ${input.personId}, term ${input.termId}.`) as DomainError);
    }
  }

  async getTranscript(tenantId: TenantId, personId: PersonId): Promise<Transcript> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(transcriptEntryTable).where(and(eq(transcriptEntryTable.tenantId, tenantId), eq(transcriptEntryTable.personId, personId))).orderBy(asc(transcriptEntryTable.finalisedAt)),
    );
    const entries = rows.map(toTranscriptEntry);
    return {
      personId,
      entries,
      cumulativeGpa: weightedGpa(entries.map((e) => ({ gpaPoints: e.gpaPoints, credits: e.creditsAttempted }))),
      cumulativeCreditsAttempted: entries.reduce((sum, e) => sum + e.creditsAttempted, 0),
      cumulativeCreditsEarned: entries.reduce((sum, e) => sum + e.creditsEarned, 0),
    };
  }

  async calculateGpa(tenantId: TenantId, input: CalculateGpaInput): Promise<number | null> {
    const ctx = scopedContext(tenantId);
    const conditions = [eq(transcriptEntryTable.tenantId, tenantId), eq(transcriptEntryTable.personId, input.personId)];

    if (input.scope === 'term') {
      if (!input.termId) throw new ValidationError('termId is required when scope is "term".');
      conditions.push(eq(transcriptEntryTable.termId, input.termId));
    } else if (input.scope === 'year') {
      if (!input.academicYearId) throw new ValidationError('academicYearId is required when scope is "year".');
      conditions.push(eq(transcriptEntryTable.academicYearId, input.academicYearId));
    }
    // scope === 'cumulative': no extra filter - every finalised entry.

    const rows = await withTenantTx(ctx, (db) => db.select().from(transcriptEntryTable).where(and(...conditions)));
    return weightedGpa(rows.map((r) => ({ gpaPoints: r.gpaPoints, credits: r.creditsAttempted })));
  }

  async checkPromotionEligibility(tenantId: TenantId, input: CheckPromotionEligibilityInput): Promise<Result<PromotionEligibility, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const ruleVersion = await this.creditRuleSets.resolveDefaultVersion(tenantId);
      if (!ruleVersion) {
        return err(new PreconditionFailedError('No default credit rule set is configured for this tenant - create one, mark it isDefault, and publish a version.'));
      }

      const rows = await withTenantTx(ctx, (db) =>
        db
          .select()
          .from(transcriptEntryTable)
          .where(and(eq(transcriptEntryTable.tenantId, tenantId), eq(transcriptEntryTable.personId, input.personId), eq(transcriptEntryTable.academicYearId, input.academicYearId))),
      );
      const entries = rows.map(toTranscriptEntry);
      const creditsEarned = entries.reduce((sum, e) => sum + e.creditsEarned, 0);
      const gpa = weightedGpa(entries.map((e) => ({ gpaPoints: e.gpaPoints, credits: e.creditsAttempted })));

      const gradeLevelId = await getEnrollmentGradeLevelId(ctx, tenantId, input.personId, input.academicYearId);
      const override = gradeLevelId ? ruleVersion.rules.gradeLevelOverrides?.[gradeLevelId] : undefined;
      const creditsRequired = override?.requiredCredits ?? ruleVersion.rules.defaultRequiredCredits;
      const minGpaRequired = (override?.minGpa ?? ruleVersion.rules.minGpa) ?? null;

      const reasons: string[] = [];
      if (creditsEarned < creditsRequired) {
        reasons.push(`Credits earned (${creditsEarned}) is below the required ${creditsRequired}.`);
      }
      if (minGpaRequired !== null && (gpa === null || gpa < minGpaRequired)) {
        reasons.push(`GPA (${gpa ?? 'n/a'}) is below the required minimum ${minGpaRequired}.`);
      }

      return ok({
        personId: input.personId,
        academicYearId: input.academicYearId,
        eligible: reasons.length === 0,
        creditsEarned,
        creditsRequired,
        gpa,
        minGpaRequired,
        reasons,
        ruleSetVersionId: ruleVersion.id,
      });
    } catch (error) {
      return err(toDomainError(error, `Could not check promotion eligibility for person ${input.personId}.`) as DomainError);
    }
  }
}
