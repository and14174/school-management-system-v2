import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { NotFoundError, newId, type DomainError, type NotFoundError as NotFoundErrorType, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import { OUTBOX_CONTRACT, type OutboxContract } from '@sms/outbox';
import type { AssignmentSectionContext, CreateAssignmentInput, UpdateAssignmentInput } from '../contract.js';
import type { Assignment } from '../domain/types.js';
import { toAssignment } from '../infrastructure/mappers.js';
import { assignmentTable, scoreTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * CRUD for `gradebook.assignment`, plus `publishAssignment` - the transition
 * that makes a draft assignment's grades visible to students/guardians. See
 * the `1000` migration header's `gradebook.assignment` comment for why
 * `gradebook.grade_posted` fires here (for every score ALREADY entered) and
 * again from `ScoreService.enterScores` (for a score entered AFTER the
 * assignment is already published) - the two paths cover both orderings.
 */
@Injectable()
export class AssignmentService {
  constructor(@Inject(OUTBOX_CONTRACT) private readonly outbox: OutboxContract) {}

  async createAssignment(tenantId: TenantId, input: CreateAssignmentInput): Promise<Result<Assignment, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(assignmentTable)
          .values({
            id: newId(),
            tenantId,
            sectionId: input.sectionId,
            categoryId: input.categoryId,
            gradingPeriodId: input.gradingPeriodId,
            title: input.title,
            description: input.description ?? null,
            pointsPossible: input.pointsPossible,
            dueOn: input.dueOn ?? null,
            published: false,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toAssignment(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create assignment "${input.title}".`) as DomainError);
    }
  }

  async updateAssignment(tenantId: TenantId, id: string, input: UpdateAssignmentInput): Promise<Result<Assignment, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(assignmentTable)
          .set({
            ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
            ...(input.gradingPeriodId !== undefined ? { gradingPeriodId: input.gradingPeriodId } : {}),
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.pointsPossible !== undefined ? { pointsPossible: input.pointsPossible } : {}),
            ...(input.dueOn !== undefined ? { dueOn: input.dueOn } : {}),
          })
          .where(and(eq(assignmentTable.tenantId, tenantId), eq(assignmentTable.id, id)))
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError(`Assignment ${id} not found.`));
      }
      return ok(toAssignment(row));
    } catch (error) {
      return err(toDomainError(error, `Could not update assignment ${id}.`) as DomainError);
    }
  }

  async publishAssignment(tenantId: TenantId, id: string): Promise<Result<Assignment, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const updated = await withTenantTx(ctx, async (db) => {
        const rows = await db
          .update(assignmentTable)
          .set({ published: true })
          .where(and(eq(assignmentTable.tenantId, tenantId), eq(assignmentTable.id, id)))
          .returning();
        const row = rows[0];
        if (!row) {
          throw new NotFoundError(`Assignment ${id} not found.`);
        }

        const existingScores = await db.select().from(scoreTable).where(and(eq(scoreTable.tenantId, tenantId), eq(scoreTable.assignmentId, id)));
        for (const score of existingScores) {
          await this.outbox.publish(db, {
            topic: 'gradebook.grade_posted',
            payload: { assignmentId: id, sectionId: row.sectionId, personId: score.personId, scoreId: score.id },
          });
        }

        return row;
      });
      return ok(toAssignment(updated));
    } catch (error) {
      return err(toDomainError(error, `Could not publish assignment ${id}.`) as DomainError);
    }
  }

  async listAssignments(tenantId: TenantId, sectionId: string, gradingPeriodId?: string): Promise<Assignment[]> {
    const ctx = scopedContext(tenantId);
    const conditions = [eq(assignmentTable.tenantId, tenantId), eq(assignmentTable.sectionId, sectionId)];
    if (gradingPeriodId) {
      conditions.push(eq(assignmentTable.gradingPeriodId, gradingPeriodId));
    }
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(assignmentTable)
        .where(and(...conditions))
        .orderBy(asc(assignmentTable.dueOn), asc(assignmentTable.title)),
    );
    return rows.map(toAssignment);
  }

  async getAssignment(tenantId: TenantId, id: string): Promise<Result<Assignment, NotFoundErrorType>> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) => db.select().from(assignmentTable).where(and(eq(assignmentTable.tenantId, tenantId), eq(assignmentTable.id, id))).limit(1));
    const row = rows[0];
    if (!row) {
      return err(new NotFoundError(`Assignment ${id} not found.`));
    }
    return ok(toAssignment(row));
  }

  async getAssignmentContext(tenantId: TenantId, id: string): Promise<AssignmentSectionContext | null> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) => db.select().from(assignmentTable).where(and(eq(assignmentTable.tenantId, tenantId), eq(assignmentTable.id, id))).limit(1));
    const row = rows[0];
    return row ? { sectionId: row.sectionId, gradingPeriodId: row.gradingPeriodId, published: row.published } : null;
  }
}
