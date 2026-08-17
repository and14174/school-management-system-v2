import { Injectable } from '@nestjs/common';
import { and, desc, eq, lte } from 'drizzle-orm';
import { ConflictError, NotFoundError, newId, todayDateOnly, type DateOnly, type DomainError, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { CreateGradeScaleInput, PublishScaleVersionInput } from '../contract.js';
import type { GradeScale, GradeScaleVersion } from '../domain/types.js';
import { toGradeScale, toGradeScaleVersion } from '../infrastructure/mappers.js';
import { gradeScaleTable, gradeScaleVersionTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * CRUD for `gradebook.grade_scale` and immutable-version CRUD for
 * `gradebook.grade_scale_version` - see the `1000` migration header for why
 * a score points at the VERSION, never the scale, and why the database
 * itself refuses to UPDATE/DELETE a published version
 * (`trg_forbid_version_update`/`_delete`).
 */
@Injectable()
export class GradeScaleService {
  async createGradeScale(tenantId: TenantId, input: CreateGradeScaleInput): Promise<Result<GradeScale, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(gradeScaleTable)
          .values({ id: newId(), tenantId, name: input.name, kind: input.kind, isDefault: input.isDefault ?? false })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toGradeScale(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create grade scale "${input.name}".`) as DomainError);
    }
  }

  async listGradeScales(tenantId: TenantId): Promise<GradeScale[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) => db.select().from(gradeScaleTable).where(eq(gradeScaleTable.tenantId, tenantId)).orderBy(gradeScaleTable.name));
    return rows.map(toGradeScale);
  }

  /**
   * Creates a NEW immutable version - never touches an existing version or
   * any score that points at it. `version` is `1 + max(existing version)` for
   * this scale, computed inside the same transaction as the insert.
   */
  async publishScaleVersion(tenantId: TenantId, input: PublishScaleVersionInput): Promise<Result<GradeScaleVersion, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const created = await withTenantTx(ctx, async (db) => {
        const scaleRows = await db.select().from(gradeScaleTable).where(and(eq(gradeScaleTable.tenantId, tenantId), eq(gradeScaleTable.id, input.gradeScaleId))).limit(1);
        if (!scaleRows[0]) {
          throw new NotFoundError(`Grade scale ${input.gradeScaleId} not found.`);
        }

        const existingVersions = await db
          .select()
          .from(gradeScaleVersionTable)
          .where(and(eq(gradeScaleVersionTable.tenantId, tenantId), eq(gradeScaleVersionTable.gradeScaleId, input.gradeScaleId)))
          .orderBy(desc(gradeScaleVersionTable.version))
          .limit(1);
        const nextVersion = (existingVersions[0]?.version ?? 0) + 1;

        const rows = await db
          .insert(gradeScaleVersionTable)
          .values({
            id: newId(),
            tenantId,
            gradeScaleId: input.gradeScaleId,
            version: nextVersion,
            bands: input.bands,
            effectiveFrom: input.effectiveFrom ?? todayDateOnly(),
          })
          .returning();
        const row = rows[0];
        if (!row) {
          throw new NotFoundError('Insert returned no row.');
        }
        return row;
      });
      return ok(toGradeScaleVersion(created));
    } catch (error) {
      return err(toDomainError(error, `Could not publish a version of grade scale ${input.gradeScaleId}.`) as DomainError);
    }
  }

  async listScaleVersions(tenantId: TenantId, gradeScaleId: string): Promise<GradeScaleVersion[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(gradeScaleVersionTable)
        .where(and(eq(gradeScaleVersionTable.tenantId, tenantId), eq(gradeScaleVersionTable.gradeScaleId, gradeScaleId)))
        .orderBy(desc(gradeScaleVersionTable.version)),
    );
    return rows.map(toGradeScaleVersion);
  }

  /** The version of `gradeScaleId` effective as of `asOf` - the latest version whose `effectiveFrom <= asOf`, or `null` if none qualifies yet. */
  async resolveEffectiveVersion(tenantId: TenantId, gradeScaleId: string, asOf?: DateOnly): Promise<GradeScaleVersion | null> {
    const ctx = scopedContext(tenantId);
    const resolveDate = asOf ?? todayDateOnly();
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(gradeScaleVersionTable)
        .where(and(eq(gradeScaleVersionTable.tenantId, tenantId), eq(gradeScaleVersionTable.gradeScaleId, gradeScaleId), lte(gradeScaleVersionTable.effectiveFrom, resolveDate)))
        .orderBy(desc(gradeScaleVersionTable.effectiveFrom), desc(gradeScaleVersionTable.version))
        .limit(1),
    );
    const row = rows[0];
    return row ? toGradeScaleVersion(row) : null;
  }

  /** The tenant's default scale's effective version as of `asOf` - what `enterScores`/`calculateSectionGrades` resolve a letter through when no specific scale is named. `null` if no default scale is configured, or it has no version effective yet. */
  async resolveDefaultVersion(tenantId: TenantId, asOf?: DateOnly): Promise<GradeScaleVersion | null> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) => db.select().from(gradeScaleTable).where(and(eq(gradeScaleTable.tenantId, tenantId), eq(gradeScaleTable.isDefault, true))).limit(1));
    const scale = rows[0];
    if (!scale) {
      return null;
    }
    return this.resolveEffectiveVersion(tenantId, scale.id, asOf);
  }

  async getVersionById(tenantId: TenantId, id: string): Promise<GradeScaleVersion | null> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) => db.select().from(gradeScaleVersionTable).where(and(eq(gradeScaleVersionTable.tenantId, tenantId), eq(gradeScaleVersionTable.id, id))).limit(1));
    const row = rows[0];
    return row ? toGradeScaleVersion(row) : null;
  }
}

// Re-exported so callers hitting the "no default scale configured" case get
// a consistent, documented error rather than each caller inventing its own.
export function noDefaultScaleError(): ConflictError {
  return new ConflictError('No default grade scale is configured for this tenant - create one and mark it isDefault, or publish a version for it.');
}
