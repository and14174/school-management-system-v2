import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { NotFoundError, newId, type CampusId, type Result, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { Campus } from '../domain/types.js';
import { currentTenantContext } from './current-context.js';
import { toCampus } from '../infrastructure/mappers.js';
import { campusTable } from '../infrastructure/schema.js';
import { createCampusSchema, updateCampusSchema, type CreateCampusInput, type UpdateCampusInput } from './schemas.js';
import { toDomainError } from './sql-errors.js';

/**
 * Campus CRUD, always scoped to the ambient tenant (`currentTenantContext`).
 * There is no "campus by id, any tenant" method anywhere in this module -
 * `resolveScope` is the one place a campus id is checked against an
 * explicitly named tenant, precisely so nothing else needs to (or can
 * forget to).
 */
@Injectable()
export class CampusService {
  async list(): Promise<Campus[]> {
    const ctx = currentTenantContext();
    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(campusTable).where(eq(campusTable.tenantId, ctx.tenantId)),
    );
    return rows.map(toCampus);
  }

  async getById(id: CampusId): Promise<Result<Campus, NotFoundError>> {
    const ctx = currentTenantContext();
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(campusTable)
        .where(and(eq(campusTable.id, id), eq(campusTable.tenantId, ctx.tenantId)))
        .limit(1),
    );
    const row = rows[0];
    return row ? ok(toCampus(row)) : err(new NotFoundError(`Campus ${id} not found.`));
  }

  async create(input: CreateCampusInput): Promise<Result<Campus, Error>> {
    const ctx = currentTenantContext();
    const parsed = createCampusSchema.parse(input);
    const id = newId() as CampusId;

    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(campusTable)
          .values({
            id,
            tenantId: ctx.tenantId,
            code: parsed.code,
            name: parsed.name,
            address: parsed.address,
            timezone: parsed.timezone,
            locale: parsed.locale,
            isDefault: parsed.isDefault,
            status: parsed.status,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new Error('Insert returned no row.'));
      }
      return ok(toCampus(row));
    } catch (error) {
      return err(toDomainError(error, 'Could not create campus.'));
    }
  }

  async updateById(id: CampusId, input: UpdateCampusInput): Promise<Result<Campus, Error>> {
    const ctx = currentTenantContext();
    const parsed = updateCampusSchema.parse(input);

    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(campusTable)
          .set({
            ...(parsed.code !== undefined ? { code: parsed.code } : {}),
            ...(parsed.name !== undefined ? { name: parsed.name } : {}),
            ...(parsed.address !== undefined ? { address: parsed.address } : {}),
            ...(parsed.timezone !== undefined ? { timezone: parsed.timezone } : {}),
            ...(parsed.locale !== undefined ? { locale: parsed.locale } : {}),
            ...(parsed.isDefault !== undefined ? { isDefault: parsed.isDefault } : {}),
            ...(parsed.status !== undefined ? { status: parsed.status } : {}),
          })
          .where(and(eq(campusTable.id, id), eq(campusTable.tenantId, ctx.tenantId)))
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError(`Campus ${id} not found.`));
      }
      return ok(toCampus(row));
    } catch (error) {
      return err(toDomainError(error, 'Could not update campus.'));
    }
  }
}
