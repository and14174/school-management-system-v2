import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { NotFoundError, newId, type AcademicYearId, type Result, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { AcademicYear } from '../domain/types.js';
import { currentTenantContext } from './current-context.js';
import { toAcademicYear } from '../infrastructure/mappers.js';
import { academicYearTable } from '../infrastructure/schema.js';
import {
  createAcademicYearSchema,
  updateAcademicYearSchema,
  type CreateAcademicYearInput,
  type UpdateAcademicYearInput,
} from './schemas.js';
import { toDomainError } from './sql-errors.js';

/** Academic year CRUD, always scoped to the ambient tenant - see `campus.service.ts` for why. */
@Injectable()
export class AcademicYearService {
  async list(): Promise<AcademicYear[]> {
    const ctx = currentTenantContext();
    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(academicYearTable).where(eq(academicYearTable.tenantId, ctx.tenantId)),
    );
    return rows.map(toAcademicYear);
  }

  async getById(id: AcademicYearId): Promise<Result<AcademicYear, NotFoundError>> {
    const ctx = currentTenantContext();
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(academicYearTable)
        .where(and(eq(academicYearTable.id, id), eq(academicYearTable.tenantId, ctx.tenantId)))
        .limit(1),
    );
    const row = rows[0];
    return row ? ok(toAcademicYear(row)) : err(new NotFoundError(`Academic year ${id} not found.`));
  }

  async getCurrent(): Promise<Result<AcademicYear, NotFoundError>> {
    const ctx = currentTenantContext();
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(academicYearTable)
        .where(and(eq(academicYearTable.tenantId, ctx.tenantId), eq(academicYearTable.isCurrent, true)))
        .limit(1),
    );
    const row = rows[0];
    return row ? ok(toAcademicYear(row)) : err(new NotFoundError('No current academic year is set for this tenant.'));
  }

  async create(input: CreateAcademicYearInput): Promise<Result<AcademicYear, Error>> {
    const ctx = currentTenantContext();
    const parsed = createAcademicYearSchema.parse(input);
    const id = newId() as AcademicYearId;

    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(academicYearTable)
          .values({
            id,
            tenantId: ctx.tenantId,
            name: parsed.name,
            startsOn: parsed.startsOn,
            endsOn: parsed.endsOn,
            status: parsed.status,
            isCurrent: parsed.isCurrent,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new Error('Insert returned no row.'));
      }
      return ok(toAcademicYear(row));
    } catch (error) {
      return err(toDomainError(error, 'Could not create academic year.'));
    }
  }

  async updateById(id: AcademicYearId, input: UpdateAcademicYearInput): Promise<Result<AcademicYear, Error>> {
    const ctx = currentTenantContext();
    const parsed = updateAcademicYearSchema.parse(input);

    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(academicYearTable)
          .set({
            ...(parsed.name !== undefined ? { name: parsed.name } : {}),
            ...(parsed.startsOn !== undefined ? { startsOn: parsed.startsOn } : {}),
            ...(parsed.endsOn !== undefined ? { endsOn: parsed.endsOn } : {}),
            ...(parsed.status !== undefined ? { status: parsed.status } : {}),
            ...(parsed.isCurrent !== undefined ? { isCurrent: parsed.isCurrent } : {}),
          })
          .where(and(eq(academicYearTable.id, id), eq(academicYearTable.tenantId, ctx.tenantId)))
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError(`Academic year ${id} not found.`));
      }
      return ok(toAcademicYear(row));
    } catch (error) {
      return err(toDomainError(error, 'Could not update academic year.'));
    }
  }
}
