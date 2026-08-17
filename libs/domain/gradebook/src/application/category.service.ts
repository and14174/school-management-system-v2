import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { NotFoundError, newId, type DomainError, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { CreateCategoryInput, UpdateCategoryInput } from '../contract.js';
import type { GradeCategory } from '../domain/types.js';
import { toCategory } from '../infrastructure/mappers.js';
import { categoryTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * CRUD for `gradebook.category` - structural, mutable, per-section. See the
 * `1000` migration header for why this is deliberately decoupled from
 * `gradebook.calculation_rule_set_version` (the policy of record
 * `ScoreService.calculateSectionGrades` actually evaluates against).
 */
@Injectable()
export class CategoryService {
  async createCategory(tenantId: TenantId, input: CreateCategoryInput): Promise<Result<GradeCategory, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(categoryTable)
          .values({
            id: newId(),
            tenantId,
            sectionId: input.sectionId,
            name: input.name,
            weight: input.weight ?? 0,
            dropLowest: input.dropLowest ?? 0,
            sequence: input.sequence ?? 0,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toCategory(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create category "${input.name}" for section ${input.sectionId}.`) as DomainError);
    }
  }

  async updateCategory(tenantId: TenantId, id: string, input: UpdateCategoryInput): Promise<Result<GradeCategory, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(categoryTable)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.weight !== undefined ? { weight: input.weight } : {}),
            ...(input.dropLowest !== undefined ? { dropLowest: input.dropLowest } : {}),
            ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
          })
          .where(and(eq(categoryTable.tenantId, tenantId), eq(categoryTable.id, id)))
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError(`Category ${id} not found.`));
      }
      return ok(toCategory(row));
    } catch (error) {
      return err(toDomainError(error, `Could not update category ${id}.`) as DomainError);
    }
  }

  async listCategories(tenantId: TenantId, sectionId: string): Promise<GradeCategory[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(categoryTable)
        .where(and(eq(categoryTable.tenantId, tenantId), eq(categoryTable.sectionId, sectionId)))
        .orderBy(asc(categoryTable.sequence), asc(categoryTable.name)),
    );
    return rows.map(toCategory);
  }

  async getCategoryContext(tenantId: TenantId, id: string): Promise<{ readonly sectionId: string } | null> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) => db.select().from(categoryTable).where(and(eq(categoryTable.tenantId, tenantId), eq(categoryTable.id, id))).limit(1));
    const row = rows[0];
    return row ? { sectionId: row.sectionId } : null;
  }
}
