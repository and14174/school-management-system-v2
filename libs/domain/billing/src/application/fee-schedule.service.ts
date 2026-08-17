import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { NotFoundError, newId, todayDateOnly, type DomainError, type NotFoundError as NotFoundErrorType, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { CreateFeeScheduleInput, PublishFeeScheduleVersionInput } from '../contract.js';
import type { FeeSchedule, FeeScheduleVersion, FeeScheduleVersionDetail } from '../domain/types.js';
import { toFeeComponent, toFeeSchedule, toFeeScheduleVersion } from '../infrastructure/mappers.js';
import { feeComponentTable, feeScheduleTable, feeScheduleVersionTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * What things cost - a named `fee_schedule` for an academic year, priced by
 * publishing successive `fee_schedule_version` rows. Every version is
 * IMMUTABLE once written (enforced by `trg_forbid_fsv_mutation`, see the
 * `1400` migration header, same posture as `@sms/gradebook`'s
 * `GradeScaleService`): correcting a price is publishing a new version, and
 * every invoice line already priced from an older version keeps reading
 * against exactly the version it was stamped with (rule #6 in the module
 * brief).
 */
@Injectable()
export class FeeScheduleService {
  async createFeeSchedule(tenantId: TenantId, input: CreateFeeScheduleInput): Promise<Result<FeeSchedule, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const created = await withTenantTx(ctx, async (db) => {
        const rows = await db
          .insert(feeScheduleTable)
          .values({ id: newId(), tenantId, academicYearId: input.academicYearId, name: input.name })
          .returning();
        return rows[0]!;
      });
      return ok(toFeeSchedule(created));
    } catch (error) {
      return err(toDomainError(error, `Could not create fee schedule "${input.name}".`) as DomainError);
    }
  }

  async listFeeSchedules(tenantId: TenantId): Promise<FeeSchedule[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(feeScheduleTable).where(eq(feeScheduleTable.tenantId, tenantId)).orderBy(feeScheduleTable.name),
    );
    return rows.map(toFeeSchedule);
  }

  /** Publishes the fee schedule's NEXT version (`max(version) + 1`, starting at 1) with its `fee_component` rows - all in one transaction, same idiom as `@sms/gradebook`'s `GradeScaleService.publishScaleVersion`. */
  async publishFeeScheduleVersion(
    tenantId: TenantId,
    input: PublishFeeScheduleVersionInput,
  ): Promise<Result<FeeScheduleVersionDetail, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const result = await withTenantTx(ctx, async (db) => {
        const scheduleRows = await db
          .select()
          .from(feeScheduleTable)
          .where(and(eq(feeScheduleTable.tenantId, tenantId), eq(feeScheduleTable.id, input.feeScheduleId)))
          .limit(1);
        if (!scheduleRows[0]) {
          throw new NotFoundError(`Fee schedule ${input.feeScheduleId} not found.`);
        }

        const existingVersions = await db
          .select()
          .from(feeScheduleVersionTable)
          .where(and(eq(feeScheduleVersionTable.tenantId, tenantId), eq(feeScheduleVersionTable.feeScheduleId, input.feeScheduleId)))
          .orderBy(desc(feeScheduleVersionTable.version))
          .limit(1);
        const nextVersion = (existingVersions[0]?.version ?? 0) + 1;

        const versionRows = await db
          .insert(feeScheduleVersionTable)
          .values({
            id: newId(),
            tenantId,
            feeScheduleId: input.feeScheduleId,
            version: nextVersion,
            currency: input.currency,
            effectiveFrom: input.effectiveFrom ?? todayDateOnly(),
          })
          .returning();
        const version = versionRows[0]!;

        const components = [];
        for (const component of input.components) {
          const componentRows = await db
            .insert(feeComponentTable)
            .values({
              id: newId(),
              tenantId,
              feeScheduleVersionId: version.id,
              code: component.code,
              name: component.name,
              amountMinor: component.amountMinor,
            })
            .returning();
          components.push(componentRows[0]!);
        }

        return { version, components };
      });
      return ok({ ...toFeeScheduleVersion(result.version), components: result.components.map(toFeeComponent) });
    } catch (error) {
      return err(toDomainError(error, `Could not publish a version for fee schedule ${input.feeScheduleId}.`) as DomainError);
    }
  }

  async listFeeScheduleVersions(tenantId: TenantId, feeScheduleId: string): Promise<FeeScheduleVersion[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(feeScheduleVersionTable)
        .where(and(eq(feeScheduleVersionTable.tenantId, tenantId), eq(feeScheduleVersionTable.feeScheduleId, feeScheduleId)))
        .orderBy(desc(feeScheduleVersionTable.version)),
    );
    return rows.map(toFeeScheduleVersion);
  }

  async getFeeScheduleVersion(tenantId: TenantId, id: string): Promise<Result<FeeScheduleVersionDetail, NotFoundErrorType>> {
    const ctx = scopedContext(tenantId);
    const versionRows = await withTenantTx(ctx, (db) =>
      db.select().from(feeScheduleVersionTable).where(and(eq(feeScheduleVersionTable.tenantId, tenantId), eq(feeScheduleVersionTable.id, id))).limit(1),
    );
    const version = versionRows[0];
    if (!version) {
      return err(new NotFoundError(`Fee schedule version ${id} not found.`));
    }
    const componentRows = await withTenantTx(ctx, (db) =>
      db.select().from(feeComponentTable).where(and(eq(feeComponentTable.tenantId, tenantId), eq(feeComponentTable.feeScheduleVersionId, id))),
    );
    return ok({ ...toFeeScheduleVersion(version), components: componentRows.map(toFeeComponent) });
  }
}
