import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { NotFoundError, newId, type DomainError, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { CreateSubjectInput, UpdateSubjectInput } from '../contract.js';
import type { Subject } from '../domain/types.js';
import { toSubject } from '../infrastructure/mappers.js';
import { subjectTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

@Injectable()
export class SubjectService {
  async create(tenantId: TenantId, input: CreateSubjectInput): Promise<Result<Subject, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(subjectTable)
          .values({ id: newId(), tenantId, departmentId: input.departmentId, code: input.code, name: input.name })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toSubject(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create subject "${input.code}".`) as DomainError);
    }
  }

  async list(tenantId: TenantId): Promise<Subject[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(subjectTable).where(eq(subjectTable.tenantId, tenantId)).orderBy(asc(subjectTable.code)),
    );
    return rows.map(toSubject);
  }

  async update(tenantId: TenantId, id: string, input: UpdateSubjectInput): Promise<Result<Subject, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(subjectTable)
          .set({
            ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
            ...(input.code !== undefined ? { code: input.code } : {}),
            ...(input.name !== undefined ? { name: input.name } : {}),
          })
          .where(and(eq(subjectTable.tenantId, tenantId), eq(subjectTable.id, id)))
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError(`Subject ${id} not found.`));
      }
      return ok(toSubject(row));
    } catch (error) {
      return err(toDomainError(error, `Could not update subject ${id}.`) as DomainError);
    }
  }
}
