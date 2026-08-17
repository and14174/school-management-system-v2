import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { NotFoundError, newId, type AcademicYearId, type DomainError, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { CreateGradingPeriodInput, CreateTermInput, UpdateTermInput } from '../contract.js';
import type { GradingPeriod, Term } from '../domain/types.js';
import { toGradingPeriod, toTerm } from '../infrastructure/mappers.js';
import { gradingPeriodTable, termTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * `academic.term`/`academic.grading_period` writes are gated in the
 * DATABASE by `tenancy.assert_year_writable` (a `BEFORE INSERT OR UPDATE`
 * trigger on `academic.term` - see the `0600` migration), not re-checked
 * here - a locked/archived academic year rejects the write regardless of
 * which code path attempted it.
 */
@Injectable()
export class TermService {
  async createTerm(tenantId: TenantId, input: CreateTermInput): Promise<Result<Term, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(termTable)
          .values({
            id: newId(),
            tenantId,
            academicYearId: input.academicYearId,
            name: input.name,
            startsOn: input.startsOn,
            endsOn: input.endsOn,
            sequence: input.sequence ?? 0,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toTerm(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create term "${input.name}".`) as DomainError);
    }
  }

  async listTerms(tenantId: TenantId, academicYearId?: AcademicYearId): Promise<Term[]> {
    const ctx = scopedContext(tenantId);
    const conditions = [eq(termTable.tenantId, tenantId)];
    if (academicYearId) {
      conditions.push(eq(termTable.academicYearId, academicYearId));
    }
    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(termTable).where(and(...conditions)).orderBy(asc(termTable.sequence)),
    );
    return rows.map(toTerm);
  }

  async getTerm(tenantId: TenantId, id: string): Promise<Result<Term, NotFoundError>> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(termTable).where(and(eq(termTable.tenantId, tenantId), eq(termTable.id, id))).limit(1),
    );
    const row = rows[0];
    return row ? ok(toTerm(row)) : err(new NotFoundError(`Term ${id} not found.`));
  }

  async updateTerm(tenantId: TenantId, id: string, input: UpdateTermInput): Promise<Result<Term, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(termTable)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.startsOn !== undefined ? { startsOn: input.startsOn } : {}),
            ...(input.endsOn !== undefined ? { endsOn: input.endsOn } : {}),
            ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
          })
          .where(and(eq(termTable.tenantId, tenantId), eq(termTable.id, id)))
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError(`Term ${id} not found.`));
      }
      return ok(toTerm(row));
    } catch (error) {
      return err(toDomainError(error, `Could not update term ${id}.`) as DomainError);
    }
  }

  async createGradingPeriod(tenantId: TenantId, input: CreateGradingPeriodInput): Promise<Result<GradingPeriod, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(gradingPeriodTable)
          .values({
            id: newId(),
            tenantId,
            termId: input.termId,
            name: input.name,
            startsOn: input.startsOn,
            endsOn: input.endsOn,
            sequence: input.sequence ?? 0,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toGradingPeriod(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create grading period "${input.name}".`) as DomainError);
    }
  }

  async listGradingPeriods(tenantId: TenantId, termId: string): Promise<GradingPeriod[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(gradingPeriodTable)
        .where(and(eq(gradingPeriodTable.tenantId, tenantId), eq(gradingPeriodTable.termId, termId)))
        .orderBy(asc(gradingPeriodTable.sequence)),
    );
    return rows.map(toGradingPeriod);
  }
}
