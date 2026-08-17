import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  newId,
  todayDateOnly,
  type DateOnly,
  type DomainError,
  type PersonId,
  type Result,
  type TenantId,
  err,
  ok,
} from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import { OUTBOX_CONTRACT, type OutboxContract } from '@sms/outbox';
import type { CalculateSectionGradesInput, EnterScoresInput, EnterScoresResult, GetStudentGradesInput, ScoreSectionContext } from '../contract.js';
import type { CalculationRules, Score, StudentSectionGrade } from '../domain/types.js';
import { evaluateStudentGrade, resolveLetter, type CategoryScoreInput } from './evaluator.js';
import { toScore, toSubmission } from '../infrastructure/mappers.js';
import { assignmentTable, categoryTable, scoreTable, submissionTable } from '../infrastructure/schema.js';
import { CalculationRuleSetService } from './calculation-rule-set.service.js';
import { GradeScaleService } from './grade-scale.service.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

type EnrolledStudentRow = { readonly person_id: string };
type StudentSectionRow = { readonly section_id: string };

const FALLBACK_RULES: CalculationRules = { rounding: { decimals: 1, mode: 'half-up' }, categories: [] };

/**
 * Bulk score entry (`enterScores`) and the two computed views
 * (`calculateSectionGrades`/`getStudentGrades`) that run the evaluator
 * (`application/evaluator.ts`) over live category/assignment/score data.
 * See the `1000` migration header for the locking/versioning design this
 * class enforces (the database enforces the lock itself -
 * `trg_check_score_lock`; this class only ever attempts an ordinary write
 * and translates the resulting error).
 */
/**
 * The grade-scale version a student's marked work for this grading period was
 * entered under.
 *
 * Where a student's scores straddle a scale republish, the EARLIEST stamp wins:
 * a grading period is graded under the scale in force when its grading began.
 *
 * Newest-wins was tried first and is subtly wrong. It means entering one late
 * score - a make-up quiz, a corrected mark - silently re-grades every other
 * score in the period against the new scale. A teacher adding a single missing
 * mark would watch an existing 83.6% B turn into a C, with nothing on screen
 * explaining why. Earliest-wins keeps the basis stable: late entries join the
 * period they belong to instead of redefining it.
 *
 * Returns null when the student has no stamped score, in which case the caller
 * falls back to the current default.
 */
/**
 * The rules actually applied to a section: the published rule set where it
 * covers the section's categories, otherwise the categories' own weights.
 *
 * A rule set names categories, so it only governs sections that use those
 * names. Without this fallback a section with unmatched category names scores
 * every category at zero weight and reports a null grade.
 */
function resolveEffectiveRules(
  rules: CalculationRules,
  categories: ReadonlyArray<{ name: string; weight: string | number | null; dropLowest: number | null }>,
): CalculationRules {
  const named = new Set((rules.categories ?? []).map((category) => category.name));
  const anyMatch = categories.some((category) => named.has(category.name));
  if (anyMatch) {
    return rules;
  }

  return {
    ...rules,
    categories: categories.map((category) => ({
      name: category.name,
      weight: Number(category.weight ?? 0),
      dropLowest: category.dropLowest ?? 0,
    })),
  };
}

function pickScaleVersionForStudent(
  scores: ReadonlyArray<{ personId: string; gradeScaleVersionId: string | null; gradedAt: Date | null }>,
  personId: string,
): string | null {
  const stamped = scores
    .filter((score) => score.personId === personId && score.gradeScaleVersionId)
    .sort((a, b) => (a.gradedAt?.getTime() ?? 0) - (b.gradedAt?.getTime() ?? 0));
  return stamped[0]?.gradeScaleVersionId ?? null;
}

@Injectable()
export class ScoreService {
  constructor(
    @Inject(OUTBOX_CONTRACT) private readonly outbox: OutboxContract,
    @Inject(GradeScaleService) private readonly gradeScales: GradeScaleService,
    @Inject(CalculationRuleSetService) private readonly ruleSets: CalculationRuleSetService,
  ) {}

  /**
   * One transaction: upsert every score in `input.scores`, write the
   * `gradebook.submission` idempotency row, and publish
   * `gradebook.score_entered` (plus `gradebook.grade_posted` when the
   * assignment is already published) through the SAME transaction. A
   * replayed `idempotencyKey` returns the ORIGINAL result and writes nothing
   * further. Rejected outright by the database (no partial write - see
   * `trg_check_score_lock`) if the assignment's grading period is locked.
   *
   * The default grade scale's effective version is resolved BEFORE opening
   * this transaction (its own short-lived read, not part of the atomic
   * unit) so this method never nests a second `withTenantTx` transaction
   * inside the one it opens for the actual writes.
   */
  async enterScores(tenantId: TenantId, input: EnterScoresInput): Promise<Result<EnterScoresResult, DomainError>> {
    const ctx = scopedContext(tenantId);
    const defaultScaleVersion = await this.gradeScales.resolveDefaultVersion(tenantId);

    try {
      const outcome = await withTenantTx(ctx, async (db) => {
        const insertedSubmissionRows = await db
          .insert(submissionTable)
          .values({
            id: newId(),
            tenantId,
            idempotencyKey: input.idempotencyKey,
            assignmentId: input.assignmentId,
            submittedByUserId: ctx.actorUserId ?? ctx.userId ?? null,
            scoreCount: input.scores.length,
          })
          .onConflictDoNothing()
          .returning();

        if (insertedSubmissionRows.length === 0) {
          const existingSubmissionRows = await db
            .select()
            .from(submissionTable)
            .where(and(eq(submissionTable.tenantId, tenantId), eq(submissionTable.idempotencyKey, input.idempotencyKey)))
            .limit(1);
          const existingSubmission = existingSubmissionRows[0];
          if (!existingSubmission) {
            throw new ConflictError(`Idempotency key "${input.idempotencyKey}" conflicted but no submission row was found.`);
          }

          const personIds = input.scores.map((s) => s.personId);
          const existingScoreRows =
            personIds.length === 0
              ? []
              : await db
                  .select()
                  .from(scoreTable)
                  .where(and(eq(scoreTable.tenantId, tenantId), eq(scoreTable.assignmentId, existingSubmission.assignmentId), inArray(scoreTable.personId, personIds)));

          return { scores: existingScoreRows.map(toScore), submission: toSubmission(existingSubmission), replayed: true };
        }
        const submission = insertedSubmissionRows[0]!;

        const assignmentRows = await db.select().from(assignmentTable).where(and(eq(assignmentTable.tenantId, tenantId), eq(assignmentTable.id, input.assignmentId))).limit(1);
        const assignment = assignmentRows[0];
        if (!assignment) {
          throw new NotFoundError(`Assignment ${input.assignmentId} not found.`);
        }

        const resultScores: (typeof scoreTable.$inferSelect)[] = [];

        for (const entry of input.scores) {
          if (entry.points != null && entry.points > assignment.pointsPossible) {
            throw new ValidationError(`Score ${entry.points} exceeds assignment ${assignment.id}'s pointsPossible (${assignment.pointsPossible}).`);
          }

          const gradeScaleVersionId = entry.points != null ? (defaultScaleVersion?.id ?? null) : null;

          const rows = await db
            .insert(scoreTable)
            .values({
              id: newId(),
              tenantId,
              assignmentId: input.assignmentId,
              personId: entry.personId,
              points: entry.points ?? null,
              status: entry.status,
              gradeScaleVersionId,
              comment: entry.comment ?? null,
              gradedByUserId: ctx.actorUserId ?? ctx.userId ?? null,
              gradedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [scoreTable.assignmentId, scoreTable.personId],
              set: {
                points: entry.points ?? null,
                status: entry.status,
                gradeScaleVersionId,
                comment: entry.comment ?? null,
                gradedByUserId: ctx.actorUserId ?? ctx.userId ?? null,
                gradedAt: new Date(),
              },
            })
            .returning();
          const row = rows[0];
          if (!row) {
            throw new NotFoundError('Upsert returned no row.');
          }
          resultScores.push(row);

          // Published in the SAME transaction - see this method's own doc
          // comment and @sms/outbox's OutboxContract.publish doc comment.
          await this.outbox.publish(db, {
            topic: 'gradebook.score_entered',
            payload: { assignmentId: input.assignmentId, sectionId: assignment.sectionId, personId: entry.personId, scoreId: row.id, points: row.points, status: row.status },
          });
          if (assignment.published) {
            await this.outbox.publish(db, {
              topic: 'gradebook.grade_posted',
              payload: { assignmentId: input.assignmentId, sectionId: assignment.sectionId, personId: entry.personId, scoreId: row.id },
            });
          }
        }

        return { scores: resultScores.map(toScore), submission: toSubmission(submission), replayed: false };
      });

      return ok(outcome);
    } catch (error) {
      return err(toDomainError(error, `Could not enter scores for assignment ${input.assignmentId}.`) as DomainError);
    }
  }

  async listScoresForAssignment(tenantId: TenantId, assignmentId: string): Promise<Score[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) => db.select().from(scoreTable).where(and(eq(scoreTable.tenantId, tenantId), eq(scoreTable.assignmentId, assignmentId))));
    return rows.map(toScore);
  }

  async getScoreContext(tenantId: TenantId, scoreId: string): Promise<ScoreSectionContext | null> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select({ assignmentId: scoreTable.assignmentId, personId: scoreTable.personId, sectionId: assignmentTable.sectionId })
        .from(scoreTable)
        .innerJoin(assignmentTable, eq(assignmentTable.id, scoreTable.assignmentId))
        .where(and(eq(scoreTable.tenantId, tenantId), eq(scoreTable.id, scoreId)))
        .limit(1),
    );
    const row = rows[0];
    return row ? { sectionId: row.sectionId, assignmentId: row.assignmentId, personId: row.personId as PersonId } : null;
  }

  /**
   * Runs the evaluator over every currently-enrolled student in `sectionId`,
   * for every PUBLISHED assignment in `gradingPeriodId` - drafts do not
   * count toward the grade a student/guardian would see. Returns the full
   * breakdown per student, not just the number - see the module brief.
   */
  async calculateSectionGrades(tenantId: TenantId, input: CalculateSectionGradesInput): Promise<StudentSectionGrade[]> {
    const asOf = input.asOf ?? todayDateOnly();
    const ctx = scopedContext(tenantId);

    const [ruleSetVersion, scaleVersion] = await Promise.all([
      this.ruleSets.resolveDefaultVersion(tenantId, asOf),
      this.gradeScales.resolveDefaultVersion(tenantId, asOf),
    ]);
    const rules = ruleSetVersion?.rules ?? FALLBACK_RULES;

    const enrolledRows = await withTenantTx(ctx, (db) =>
      db.execute<EnrolledStudentRow>(sql`
        select se.person_id
        from academic.section_enrollment se
        where se.tenant_id = ${tenantId} and se.section_id = ${input.sectionId}
          and se.valid_from <= ${asOf} and (se.valid_to is null or se.valid_to >= ${asOf})
      `),
    );
    const personIds = (enrolledRows as unknown as EnrolledStudentRow[]).map((row) => row.person_id as PersonId);

    return this.computeGrades(tenantId, input.sectionId, input.gradingPeriodId, asOf, rules, ruleSetVersion?.id ?? null, scaleVersion, personIds);
  }

  /** Every currently-enrolled section this person has assignments in during `gradingPeriodId`, each computed independently - a student typically takes several sections (subjects) that share one grading period. */
  async getStudentGrades(tenantId: TenantId, input: GetStudentGradesInput): Promise<StudentSectionGrade[]> {
    const asOf = todayDateOnly();
    const ctx = scopedContext(tenantId);

    const sectionRows = await withTenantTx(ctx, (db) =>
      db.execute<StudentSectionRow>(sql`
        select distinct a.section_id
        from gradebook.assignment a
        join academic.section_enrollment se on se.tenant_id = a.tenant_id and se.section_id = a.section_id
        where a.tenant_id = ${tenantId} and a.grading_period_id = ${input.gradingPeriodId} and se.person_id = ${input.personId}
          and se.valid_from <= ${asOf} and (se.valid_to is null or se.valid_to >= ${asOf})
      `),
    );
    const sectionIds = (sectionRows as unknown as StudentSectionRow[]).map((row) => row.section_id);
    if (sectionIds.length === 0) {
      return [];
    }

    const [ruleSetVersion, scaleVersion] = await Promise.all([
      this.ruleSets.resolveDefaultVersion(tenantId, asOf),
      this.gradeScales.resolveDefaultVersion(tenantId, asOf),
    ]);
    const rules = ruleSetVersion?.rules ?? FALLBACK_RULES;

    const results: StudentSectionGrade[] = [];
    for (const sectionId of sectionIds) {
      const grades = await this.computeGrades(tenantId, sectionId, input.gradingPeriodId, asOf, rules, ruleSetVersion?.id ?? null, scaleVersion, [input.personId]);
      results.push(...grades);
    }
    return results;
  }

  /** Shared by `calculateSectionGrades` (all enrolled students) and `getStudentGrades` (one student, one section) - loads categories/published assignments/scores for `sectionId`+`gradingPeriodId` once and evaluates each of `personIds`. */
  private async computeGrades(
    tenantId: TenantId,
    sectionId: string,
    gradingPeriodId: string,
    asOf: DateOnly,
    rules: CalculationRules,
    calculationRuleSetVersionId: string | null,
    scaleVersion: Awaited<ReturnType<GradeScaleService['resolveDefaultVersion']>>,
    personIds: readonly PersonId[],
  ): Promise<StudentSectionGrade[]> {
    const ctx = scopedContext(tenantId);

    const categories = await withTenantTx(ctx, (db) => db.select().from(categoryTable).where(and(eq(categoryTable.tenantId, tenantId), eq(categoryTable.sectionId, sectionId))));

    // Rule sets are tenant-wide and match categories BY NAME, so a section whose
    // categories are not named in the published rule set - or a tenant with no
    // rule set at all - had every category fall to zero weight and every grade
    // came back `null`. Silently ungraded is the worst possible answer here: a
    // teacher sees blanks with nothing indicating why, and a report card run
    // produces empty grades rather than failing loudly.
    //
    // Fall back to the weights already stored on the categories themselves,
    // which is what a teacher configured on the section and what they would
    // reasonably expect to apply.
    const effectiveRules = resolveEffectiveRules(rules, categories);

    const assignments = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(assignmentTable)
        .where(and(eq(assignmentTable.tenantId, tenantId), eq(assignmentTable.sectionId, sectionId), eq(assignmentTable.gradingPeriodId, gradingPeriodId), eq(assignmentTable.published, true))),
    );
    const assignmentIds = assignments.map((a) => a.id);

    const scores =
      assignmentIds.length === 0
        ? []
        : await withTenantTx(ctx, (db) => db.select().from(scoreTable).where(and(eq(scoreTable.tenantId, tenantId), inArray(scoreTable.assignmentId, assignmentIds))));

    const results: StudentSectionGrade[] = [];
    for (const personId of personIds) {
      const categoryInputs: CategoryScoreInput[] = categories.map((category) => {
        const categoryAssignments = assignments.filter((a) => a.categoryId === category.id);
        return {
          categoryId: category.id,
          categoryName: category.name,
          assignments: categoryAssignments.map((assignment) => {
            const score = scores.find((s) => s.assignmentId === assignment.id && s.personId === personId);
            return {
              assignmentId: assignment.id,
              assignmentTitle: assignment.title,
              pointsPossible: assignment.pointsPossible,
              pointsEarned: score?.points ?? null,
              status: (score?.status ?? 'missing') as CategoryScoreInput['assignments'][number]['status'],
            };
          }),
        };
      });

      const { percentage, breakdown } = evaluateStudentGrade(effectiveRules, categoryInputs);

      // Resolve the letter against the scale version THIS STUDENT'S SCORES were
      // entered under - not whichever version is current today.
      //
      // Every score is stamped with `grade_scale_version_id` at entry precisely
      // so a later scale change cannot re-grade work that has already been
      // marked. Using the current default here threw that away: publishing a
      // stricter scale silently turned an existing 82.2% from a B into a C, on
      // a report card that had already been issued. A transcript that re-grades
      // itself is a legal problem, not a display bug.
      //
      // Where a student's scores span a scale change (entered either side of a
      // republish), the newest stamped version wins - it is the scale in force
      // when the most recent piece of their work was marked. Falling back to
      // today's default only when they have no stamped scores at all.
      const stampedVersionId = pickScaleVersionForStudent(scores, personId);
      const effectiveScaleVersion = stampedVersionId
        ? ((await this.gradeScales.getVersionById(tenantId, stampedVersionId)) ?? scaleVersion)
        : scaleVersion;

      const letter =
        percentage !== null && effectiveScaleVersion
          ? resolveLetter(effectiveScaleVersion.bands, percentage)
          : null;

      results.push({
        personId,
        sectionId,
        gradingPeriodId,
        percentage,
        letter: letter?.label ?? null,
        gpaPoints: letter?.gpaPoints ?? null,
        gradeScaleVersionId: effectiveScaleVersion?.id ?? null,
        calculationRuleSetVersionId,
        breakdown,
      });
    }
    return results;
  }
}
