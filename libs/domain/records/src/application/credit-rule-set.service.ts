import { Injectable } from '@nestjs/common';
import { and, desc, eq, lte } from 'drizzle-orm';
import { NotFoundError, newId, todayDateOnly, type DateOnly, type DomainError, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { CreateCreditRuleSetInput, PublishCreditRuleSetVersionInput } from '../contract.js';
import type { CreditRuleSet, CreditRuleSetVersion } from '../domain/types.js';
import { toCreditRuleSet, toCreditRuleSetVersion } from '../infrastructure/mappers.js';
import { creditRuleSetTable, creditRuleSetVersionTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * CRUD for `records.credit_rule_set` and immutable-version CRUD for
 * `records.credit_rule_set_version` - see the `1200` migration header for
 * why credits/promotion eligibility are rules as data, versioned exactly
 * like `@sms/gradebook`'s grade scales, rather than `if` branches in code.
 */
@Injectable()
export class CreditRuleSetService {
  async createCreditRuleSet(tenantId: TenantId, input: CreateCreditRuleSetInput): Promise<Result<CreditRuleSet, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(creditRuleSetTable)
          .values({ id: newId(), tenantId, name: input.name, isDefault: input.isDefault ?? false })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toCreditRuleSet(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create credit rule set "${input.name}".`) as DomainError);
    }
  }

  async listCreditRuleSets(tenantId: TenantId): Promise<CreditRuleSet[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) => db.select().from(creditRuleSetTable).where(eq(creditRuleSetTable.tenantId, tenantId)).orderBy(creditRuleSetTable.name));
    return rows.map(toCreditRuleSet);
  }

  /** Creates a NEW immutable version - never touches an existing version or any transcript entry/eligibility decision that resolved through it. */
  async publishCreditRuleSetVersion(tenantId: TenantId, input: PublishCreditRuleSetVersionInput): Promise<Result<CreditRuleSetVersion, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const created = await withTenantTx(ctx, async (db) => {
        const setRows = await db
          .select()
          .from(creditRuleSetTable)
          .where(and(eq(creditRuleSetTable.tenantId, tenantId), eq(creditRuleSetTable.id, input.creditRuleSetId)))
          .limit(1);
        if (!setRows[0]) {
          throw new NotFoundError(`Credit rule set ${input.creditRuleSetId} not found.`);
        }

        const existingVersions = await db
          .select()
          .from(creditRuleSetVersionTable)
          .where(and(eq(creditRuleSetVersionTable.tenantId, tenantId), eq(creditRuleSetVersionTable.creditRuleSetId, input.creditRuleSetId)))
          .orderBy(desc(creditRuleSetVersionTable.version))
          .limit(1);
        const nextVersion = (existingVersions[0]?.version ?? 0) + 1;

        const rows = await db
          .insert(creditRuleSetVersionTable)
          .values({
            id: newId(),
            tenantId,
            creditRuleSetId: input.creditRuleSetId,
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
      return ok(toCreditRuleSetVersion(created));
    } catch (error) {
      return err(toDomainError(error, `Could not publish a version of credit rule set ${input.creditRuleSetId}.`) as DomainError);
    }
  }

  async listCreditRuleSetVersions(tenantId: TenantId, creditRuleSetId: string): Promise<CreditRuleSetVersion[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(creditRuleSetVersionTable)
        .where(and(eq(creditRuleSetVersionTable.tenantId, tenantId), eq(creditRuleSetVersionTable.creditRuleSetId, creditRuleSetId)))
        .orderBy(desc(creditRuleSetVersionTable.version)),
    );
    return rows.map(toCreditRuleSetVersion);
  }

  /** The tenant's default rule set's effective version as of `asOf` - what `checkPromotionEligibility` evaluates against when no specific rule set is named. `null` if no default is configured, or it has no version effective yet. */
  async resolveDefaultVersion(tenantId: TenantId, asOf?: DateOnly): Promise<CreditRuleSetVersion | null> {
    const ctx = scopedContext(tenantId);
    const resolveDate = asOf ?? todayDateOnly();
    const setRows = await withTenantTx(ctx, (db) => db.select().from(creditRuleSetTable).where(and(eq(creditRuleSetTable.tenantId, tenantId), eq(creditRuleSetTable.isDefault, true))).limit(1));
    const set = setRows[0];
    if (!set) {
      return null;
    }
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(creditRuleSetVersionTable)
        .where(and(eq(creditRuleSetVersionTable.tenantId, tenantId), eq(creditRuleSetVersionTable.creditRuleSetId, set.id), lte(creditRuleSetVersionTable.effectiveFrom, resolveDate)))
        .orderBy(desc(creditRuleSetVersionTable.effectiveFrom), desc(creditRuleSetVersionTable.version))
        .limit(1),
    );
    const row = rows[0];
    return row ? toCreditRuleSetVersion(row) : null;
  }
}
