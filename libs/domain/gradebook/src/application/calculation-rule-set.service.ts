import { Injectable } from '@nestjs/common';
import { and, desc, eq, lte } from 'drizzle-orm';
import { NotFoundError, newId, todayDateOnly, type DateOnly, type DomainError, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { CreateCalculationRuleSetInput, PublishRuleSetVersionInput } from '../contract.js';
import type { CalculationRuleSet, CalculationRuleSetVersion } from '../domain/types.js';
import { toCalculationRuleSet, toCalculationRuleSetVersion } from '../infrastructure/mappers.js';
import { calculationRuleSetTable, calculationRuleSetVersionTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * CRUD for `gradebook.calculation_rule_set` and immutable-version CRUD for
 * `gradebook.calculation_rule_set_version` - the exact same versioned/
 * immutable shape as `GradeScaleService`, for the same reason: publishing a
 * new weighting/drop-lowest/rounding policy must never retroactively change
 * an already-computed grade. See the `1000` migration header.
 */
@Injectable()
export class CalculationRuleSetService {
  async createRuleSet(tenantId: TenantId, input: CreateCalculationRuleSetInput): Promise<Result<CalculationRuleSet, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(calculationRuleSetTable)
          .values({ id: newId(), tenantId, name: input.name, isDefault: input.isDefault ?? false })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toCalculationRuleSet(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create calculation rule set "${input.name}".`) as DomainError);
    }
  }

  async listRuleSets(tenantId: TenantId): Promise<CalculationRuleSet[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) => db.select().from(calculationRuleSetTable).where(eq(calculationRuleSetTable.tenantId, tenantId)).orderBy(calculationRuleSetTable.name));
    return rows.map(toCalculationRuleSet);
  }

  async publishRuleSetVersion(tenantId: TenantId, input: PublishRuleSetVersionInput): Promise<Result<CalculationRuleSetVersion, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const created = await withTenantTx(ctx, async (db) => {
        const setRows = await db
          .select()
          .from(calculationRuleSetTable)
          .where(and(eq(calculationRuleSetTable.tenantId, tenantId), eq(calculationRuleSetTable.id, input.calculationRuleSetId)))
          .limit(1);
        if (!setRows[0]) {
          throw new NotFoundError(`Calculation rule set ${input.calculationRuleSetId} not found.`);
        }

        const existingVersions = await db
          .select()
          .from(calculationRuleSetVersionTable)
          .where(and(eq(calculationRuleSetVersionTable.tenantId, tenantId), eq(calculationRuleSetVersionTable.calculationRuleSetId, input.calculationRuleSetId)))
          .orderBy(desc(calculationRuleSetVersionTable.version))
          .limit(1);
        const nextVersion = (existingVersions[0]?.version ?? 0) + 1;

        const rows = await db
          .insert(calculationRuleSetVersionTable)
          .values({
            id: newId(),
            tenantId,
            calculationRuleSetId: input.calculationRuleSetId,
            version: nextVersion,
            rules: input.rules,
            effectiveFrom: input.effectiveFrom ?? todayDateOnly(),
          })
          .returning();
        const row = rows[0];
        if (!row) {
          throw new NotFoundError('Insert returned no row.');
        }
        return row;
      });
      return ok(toCalculationRuleSetVersion(created));
    } catch (error) {
      return err(toDomainError(error, `Could not publish a version of calculation rule set ${input.calculationRuleSetId}.`) as DomainError);
    }
  }

  async listRuleSetVersions(tenantId: TenantId, calculationRuleSetId: string): Promise<CalculationRuleSetVersion[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(calculationRuleSetVersionTable)
        .where(and(eq(calculationRuleSetVersionTable.tenantId, tenantId), eq(calculationRuleSetVersionTable.calculationRuleSetId, calculationRuleSetId)))
        .orderBy(desc(calculationRuleSetVersionTable.version)),
    );
    return rows.map(toCalculationRuleSetVersion);
  }

  async resolveEffectiveVersion(tenantId: TenantId, calculationRuleSetId: string, asOf?: DateOnly): Promise<CalculationRuleSetVersion | null> {
    const ctx = scopedContext(tenantId);
    const resolveDate = asOf ?? todayDateOnly();
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(calculationRuleSetVersionTable)
        .where(
          and(
            eq(calculationRuleSetVersionTable.tenantId, tenantId),
            eq(calculationRuleSetVersionTable.calculationRuleSetId, calculationRuleSetId),
            lte(calculationRuleSetVersionTable.effectiveFrom, resolveDate),
          ),
        )
        .orderBy(desc(calculationRuleSetVersionTable.effectiveFrom), desc(calculationRuleSetVersionTable.version))
        .limit(1),
    );
    const row = rows[0];
    return row ? toCalculationRuleSetVersion(row) : null;
  }

  /** The tenant's default rule set's effective version as of `asOf`. `null` if no default rule set is configured, or it has no version effective yet - `ScoreService.calculateSectionGrades` falls back to an equal-weight/no-drop policy in that case so the feature still works before any rule set is published. */
  async resolveDefaultVersion(tenantId: TenantId, asOf?: DateOnly): Promise<CalculationRuleSetVersion | null> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) => db.select().from(calculationRuleSetTable).where(and(eq(calculationRuleSetTable.tenantId, tenantId), eq(calculationRuleSetTable.isDefault, true))).limit(1));
    const set = rows[0];
    if (!set) {
      return null;
    }
    return this.resolveEffectiveVersion(tenantId, set.id, asOf);
  }
}
