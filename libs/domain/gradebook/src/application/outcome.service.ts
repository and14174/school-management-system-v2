import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { ConflictError, NotFoundError, newId, type DomainError, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { CreateLearningOutcomeInput, ListOutcomeResultsInput, RecordOutcomeResultInput } from '../contract.js';
import type { LearningOutcome, OutcomeResult } from '../domain/types.js';
import { toLearningOutcome, toOutcomeResult } from '../infrastructure/mappers.js';
import { learningOutcomeTable, outcomeResultTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * The standards-based half of this module: a tenant-owned
 * `gradebook.learning_outcome` catalogue, and the CURRENT proficiency level
 * per (person, outcome, assignment?) in `gradebook.outcome_result` - see the
 * `1000` migration header. Not bolted onto traditional grading: a section
 * can carry both `gradebook.score` rows AND `gradebook.outcome_result` rows
 * for the same assessment.
 */
@Injectable()
export class OutcomeService {
  async createLearningOutcome(tenantId: TenantId, input: CreateLearningOutcomeInput): Promise<Result<LearningOutcome, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(learningOutcomeTable)
          .values({ id: newId(), tenantId, code: input.code, description: input.description, subjectId: input.subjectId ?? null })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toLearningOutcome(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create learning outcome "${input.code}".`) as DomainError);
    }
  }

  async listLearningOutcomes(tenantId: TenantId): Promise<LearningOutcome[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) => db.select().from(learningOutcomeTable).where(eq(learningOutcomeTable.tenantId, tenantId)).orderBy(learningOutcomeTable.code));
    return rows.map(toLearningOutcome);
  }

  /** Upserts the current proficiency level for `(personId, outcomeId, assignmentId ?? null)` - same "current state" idiom as `ScoreService.enterScores`. */
  async recordOutcomeResult(tenantId: TenantId, input: RecordOutcomeResultInput): Promise<Result<OutcomeResult, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const result = await withTenantTx(ctx, async (db) => {
        const assignmentId = input.assignmentId ?? null;
        const existing = await db
          .select()
          .from(outcomeResultTable)
          .where(
            and(
              eq(outcomeResultTable.tenantId, tenantId),
              eq(outcomeResultTable.personId, input.personId),
              eq(outcomeResultTable.outcomeId, input.outcomeId),
            ),
          );
        // Exact (nullable) assignmentId match done in JS, not SQL - `col =
        // NULL` is never true in Postgres, so a WHERE clause built from
        // `eq(assignmentId, null)` would silently match nothing instead of
        // the "no particular assignment" rows this is meant to find.
        const match = existing.find((row) => (row.assignmentId ?? null) === assignmentId);

        const now = new Date();
        if (match) {
          const rows = await db
            .update(outcomeResultTable)
            .set({
              sectionId: input.sectionId,
              proficiencyLevel: input.proficiencyLevel,
              comment: input.comment ?? null,
              scoredByUserId: ctx.actorUserId ?? ctx.userId ?? null,
              scoredAt: now,
            })
            .where(eq(outcomeResultTable.id, match.id))
            .returning();
          const row = rows[0];
          if (!row) {
            throw new NotFoundError('Update returned no row.');
          }
          return row;
        }

        const rows = await db
          .insert(outcomeResultTable)
          .values({
            id: newId(),
            tenantId,
            sectionId: input.sectionId,
            personId: input.personId,
            outcomeId: input.outcomeId,
            assignmentId,
            proficiencyLevel: input.proficiencyLevel,
            comment: input.comment ?? null,
            scoredByUserId: ctx.actorUserId ?? ctx.userId ?? null,
            scoredAt: now,
          })
          .returning();
        const row = rows[0];
        if (!row) {
          throw new ConflictError('Insert returned no row.');
        }
        return row;
      });
      return ok(toOutcomeResult(result));
    } catch (error) {
      return err(toDomainError(error, `Could not record an outcome result for person ${input.personId}.`) as DomainError);
    }
  }

  async listOutcomeResults(tenantId: TenantId, filter: ListOutcomeResultsInput): Promise<OutcomeResult[]> {
    const ctx = scopedContext(tenantId);
    const conditions = [eq(outcomeResultTable.tenantId, tenantId)];
    if (filter.sectionId) {
      conditions.push(eq(outcomeResultTable.sectionId, filter.sectionId));
    }
    if (filter.personId) {
      conditions.push(eq(outcomeResultTable.personId, filter.personId));
    }
    if (filter.outcomeId) {
      conditions.push(eq(outcomeResultTable.outcomeId, filter.outcomeId));
    }
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(outcomeResultTable)
        .where(and(...conditions)),
    );
    return rows.map(toOutcomeResult);
  }
}
