import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { NotFoundError, newId, type CampusId, type DomainError, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { CreateSectionInput, ListSectionsInput, UpdateSectionInput } from '../contract.js';
import type { Section } from '../domain/types.js';
import { toSection } from '../infrastructure/mappers.js';
import { sectionTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * `academic.section` writes are gated in the DATABASE by
 * `tenancy.assert_year_writable`, resolved via `term_id -> term.
 * academic_year_id` (a `BEFORE INSERT OR UPDATE` trigger - see the `0600`
 * migration), not re-checked here.
 */
@Injectable()
export class SectionService {
  async create(tenantId: TenantId, input: CreateSectionInput): Promise<Result<Section, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(sectionTable)
          .values({
            id: newId(),
            tenantId,
            courseId: input.courseId,
            termId: input.termId,
            campusId: input.campusId,
            roomId: input.roomId ?? null,
            code: input.code,
            name: input.name,
            capacity: input.capacity ?? null,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toSection(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create section "${input.code}".`) as DomainError);
    }
  }

  async get(tenantId: TenantId, id: string): Promise<Result<Section, NotFoundError>> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(sectionTable).where(and(eq(sectionTable.tenantId, tenantId), eq(sectionTable.id, id))).limit(1),
    );
    const row = rows[0];
    return row ? ok(toSection(row)) : err(new NotFoundError(`Section ${id} not found.`));
  }

  async list(tenantId: TenantId, filter?: ListSectionsInput): Promise<Section[]> {
    const ctx = scopedContext(tenantId);
    const conditions = [eq(sectionTable.tenantId, tenantId)];
    if (filter?.termId) {
      conditions.push(eq(sectionTable.termId, filter.termId));
    }
    if (filter?.courseId) {
      conditions.push(eq(sectionTable.courseId, filter.courseId));
    }
    if (filter?.campusId) {
      conditions.push(eq(sectionTable.campusId, filter.campusId as CampusId));
    }
    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(sectionTable).where(and(...conditions)).orderBy(asc(sectionTable.code)),
    );
    return rows.map(toSection);
  }

  async update(tenantId: TenantId, id: string, input: UpdateSectionInput): Promise<Result<Section, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(sectionTable)
          .set({
            ...(input.courseId !== undefined ? { courseId: input.courseId } : {}),
            ...(input.campusId !== undefined ? { campusId: input.campusId } : {}),
            ...(input.roomId !== undefined ? { roomId: input.roomId } : {}),
            ...(input.code !== undefined ? { code: input.code } : {}),
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
          })
          .where(and(eq(sectionTable.tenantId, tenantId), eq(sectionTable.id, id)))
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError(`Section ${id} not found.`));
      }
      return ok(toSection(row));
    } catch (error) {
      return err(toDomainError(error, `Could not update section ${id}.`) as DomainError);
    }
  }
}
