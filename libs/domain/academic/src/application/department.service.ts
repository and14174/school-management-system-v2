import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { NotFoundError, newId, type DomainError, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { CreateDepartmentInput, UpdateDepartmentInput } from '../contract.js';
import type { Department } from '../domain/types.js';
import { toDepartment } from '../infrastructure/mappers.js';
import { departmentTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

@Injectable()
export class DepartmentService {
  async create(tenantId: TenantId, input: CreateDepartmentInput): Promise<Result<Department, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db.insert(departmentTable).values({ id: newId(), tenantId, code: input.code, name: input.name }).returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toDepartment(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create department "${input.code}".`) as DomainError);
    }
  }

  async list(tenantId: TenantId): Promise<Department[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(departmentTable).where(eq(departmentTable.tenantId, tenantId)).orderBy(asc(departmentTable.code)),
    );
    return rows.map(toDepartment);
  }

  async update(tenantId: TenantId, id: string, input: UpdateDepartmentInput): Promise<Result<Department, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(departmentTable)
          .set({
            ...(input.code !== undefined ? { code: input.code } : {}),
            ...(input.name !== undefined ? { name: input.name } : {}),
          })
          .where(and(eq(departmentTable.tenantId, tenantId), eq(departmentTable.id, id)))
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError(`Department ${id} not found.`));
      }
      return ok(toDepartment(row));
    } catch (error) {
      return err(toDomainError(error, `Could not update department ${id}.`) as DomainError);
    }
  }
}
