import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { NotFoundError, newId, type CampusId, type DomainError, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { CreatePeriodInput, ListBellSchedulesInput, CreateBellScheduleInput, UpdateBellScheduleInput, UpdatePeriodInput } from '../contract.js';
import type { BellSchedule, Period } from '../domain/types.js';
import { toBellSchedule, toPeriod } from '../infrastructure/mappers.js';
import { bellScheduleTable, periodTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * Bell schedules and periods - the reference data `academic.section_meeting`
 * hangs off (a meeting is `(period_id, day_of_week)` + effective range, no
 * time-of-day/room repetition on the meeting row itself). `bell_schedule_
 * one_default_idx` (0610) rejects a second default per (tenant, campus,
 * year) - surfaced as a `ConflictError` via `toDomainError`, same shape as
 * every other unique-constraint violation in this module.
 */
@Injectable()
export class BellScheduleService {
  async createBellSchedule(tenantId: TenantId, input: CreateBellScheduleInput): Promise<Result<BellSchedule, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(bellScheduleTable)
          .values({
            id: newId(),
            tenantId,
            campusId: input.campusId,
            academicYearId: input.academicYearId,
            name: input.name,
            isDefault: input.isDefault ?? false,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toBellSchedule(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create bell schedule "${input.name}".`) as DomainError);
    }
  }

  async listBellSchedules(tenantId: TenantId, filter?: ListBellSchedulesInput): Promise<BellSchedule[]> {
    const ctx = scopedContext(tenantId);
    const conditions = [eq(bellScheduleTable.tenantId, tenantId)];
    if (filter?.campusId) {
      conditions.push(eq(bellScheduleTable.campusId, filter.campusId as CampusId));
    }
    if (filter?.academicYearId) {
      conditions.push(eq(bellScheduleTable.academicYearId, filter.academicYearId));
    }
    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(bellScheduleTable).where(and(...conditions)).orderBy(asc(bellScheduleTable.name)),
    );
    return rows.map(toBellSchedule);
  }

  async getBellSchedule(tenantId: TenantId, id: string): Promise<Result<BellSchedule, NotFoundError>> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(bellScheduleTable).where(and(eq(bellScheduleTable.tenantId, tenantId), eq(bellScheduleTable.id, id))).limit(1),
    );
    const row = rows[0];
    return row ? ok(toBellSchedule(row)) : err(new NotFoundError(`Bell schedule ${id} not found.`));
  }

  async updateBellSchedule(tenantId: TenantId, id: string, input: UpdateBellScheduleInput): Promise<Result<BellSchedule, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(bellScheduleTable)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
          })
          .where(and(eq(bellScheduleTable.tenantId, tenantId), eq(bellScheduleTable.id, id)))
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError(`Bell schedule ${id} not found.`));
      }
      return ok(toBellSchedule(row));
    } catch (error) {
      return err(toDomainError(error, `Could not update bell schedule ${id}.`) as DomainError);
    }
  }

  async createPeriod(tenantId: TenantId, input: CreatePeriodInput): Promise<Result<Period, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(periodTable)
          .values({
            id: newId(),
            tenantId,
            bellScheduleId: input.bellScheduleId,
            name: input.name,
            sequence: input.sequence ?? 0,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            isInstructional: input.isInstructional ?? true,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toPeriod(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create period "${input.name}".`) as DomainError);
    }
  }

  async listPeriods(tenantId: TenantId, bellScheduleId: string): Promise<Period[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(periodTable)
        .where(and(eq(periodTable.tenantId, tenantId), eq(periodTable.bellScheduleId, bellScheduleId)))
        .orderBy(asc(periodTable.sequence)),
    );
    return rows.map(toPeriod);
  }

  async updatePeriod(tenantId: TenantId, id: string, input: UpdatePeriodInput): Promise<Result<Period, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(periodTable)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
            ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
            ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
            ...(input.isInstructional !== undefined ? { isInstructional: input.isInstructional } : {}),
          })
          .where(and(eq(periodTable.tenantId, tenantId), eq(periodTable.id, id)))
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError(`Period ${id} not found.`));
      }
      return ok(toPeriod(row));
    } catch (error) {
      return err(toDomainError(error, `Could not update period ${id}.`) as DomainError);
    }
  }
}
