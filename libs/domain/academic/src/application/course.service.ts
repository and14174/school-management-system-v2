import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { NotFoundError, newId, type DomainError, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { CreateCourseInput, UpdateCourseInput } from '../contract.js';
import type { Course } from '../domain/types.js';
import { toCourse } from '../infrastructure/mappers.js';
import { courseTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

@Injectable()
export class CourseService {
  async create(tenantId: TenantId, input: CreateCourseInput): Promise<Result<Course, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(courseTable)
          .values({
            id: newId(),
            tenantId,
            subjectId: input.subjectId,
            gradeLevelId: input.gradeLevelId,
            code: input.code,
            name: input.name,
            credits: input.credits !== undefined && input.credits !== null ? String(input.credits) : null,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toCourse(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create course "${input.code}".`) as DomainError);
    }
  }

  async list(tenantId: TenantId): Promise<Course[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(courseTable).where(eq(courseTable.tenantId, tenantId)).orderBy(asc(courseTable.code)),
    );
    return rows.map(toCourse);
  }

  async update(tenantId: TenantId, id: string, input: UpdateCourseInput): Promise<Result<Course, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(courseTable)
          .set({
            ...(input.subjectId !== undefined ? { subjectId: input.subjectId } : {}),
            ...(input.gradeLevelId !== undefined ? { gradeLevelId: input.gradeLevelId } : {}),
            ...(input.code !== undefined ? { code: input.code } : {}),
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.credits !== undefined ? { credits: input.credits === null ? null : String(input.credits) } : {}),
          })
          .where(and(eq(courseTable.tenantId, tenantId), eq(courseTable.id, id)))
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError(`Course ${id} not found.`));
      }
      return ok(toCourse(row));
    } catch (error) {
      return err(toDomainError(error, `Could not update course ${id}.`) as DomainError);
    }
  }
}
