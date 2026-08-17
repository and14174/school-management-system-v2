import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { NotFoundError, newId, type DomainError, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { CreateGradeLevelInput, UpdateGradeLevelInput } from '../contract.js';
import type { GradeLevel } from '../domain/types.js';
import { toGradeLevel } from '../infrastructure/mappers.js';
import { gradeLevelTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

@Injectable()
export class GradeLevelService {
  async create(tenantId: TenantId, input: CreateGradeLevelInput): Promise<Result<GradeLevel, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(gradeLevelTable)
          .values({ id: newId(), tenantId, code: input.code, name: input.name, sequence: input.sequence ?? 0 })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toGradeLevel(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create grade level "${input.code}".`) as DomainError);
    }
  }

  async list(tenantId: TenantId): Promise<GradeLevel[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(gradeLevelTable).where(eq(gradeLevelTable.tenantId, tenantId)).orderBy(asc(gradeLevelTable.sequence)),
    );
    return rows.map(toGradeLevel);
  }

  async update(tenantId: TenantId, id: string, input: UpdateGradeLevelInput): Promise<Result<GradeLevel, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(gradeLevelTable)
          .set({
            ...(input.code !== undefined ? { code: input.code } : {}),
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
          })
          .where(and(eq(gradeLevelTable.tenantId, tenantId), eq(gradeLevelTable.id, id)))
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError(`Grade level ${id} not found.`));
      }
      return ok(toGradeLevel(row));
    } catch (error) {
      return err(toDomainError(error, `Could not update grade level ${id}.`) as DomainError);
    }
  }
}
