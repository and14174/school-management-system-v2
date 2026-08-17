import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { NotFoundError, newId, type DomainError, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { CreateCodeInput, UpdateCodeInput } from '../contract.js';
import type { AttendanceCode } from '../domain/types.js';
import { toCode } from '../infrastructure/mappers.js';
import { codeTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * CRUD for the tenant-owned `attendance.code` catalogue - see the `0900`
 * migration header for why codes are configuration, not an enum.
 * `code_tenant_id_code_key`/`code_one_default_idx` (at most one default per
 * tenant - a partial unique index) are enforced by the database; a
 * violation of either surfaces as a `ConflictError` via `toDomainError`.
 */
@Injectable()
export class AttendanceCodeService {
  async createCode(tenantId: TenantId, input: CreateCodeInput): Promise<Result<AttendanceCode, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(codeTable)
          .values({
            id: newId(),
            tenantId,
            code: input.code,
            label: input.label,
            category: input.category,
            countsAsPresent: input.countsAsPresent ?? false,
            isDefault: input.isDefault ?? false,
            requiresReason: input.requiresReason ?? false,
            sequence: input.sequence ?? 0,
            active: true,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toCode(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create attendance code "${input.code}".`) as DomainError);
    }
  }

  async updateCode(tenantId: TenantId, id: string, input: UpdateCodeInput): Promise<Result<AttendanceCode, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(codeTable)
          .set({
            ...(input.label !== undefined ? { label: input.label } : {}),
            ...(input.category !== undefined ? { category: input.category } : {}),
            ...(input.countsAsPresent !== undefined ? { countsAsPresent: input.countsAsPresent } : {}),
            ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
            ...(input.requiresReason !== undefined ? { requiresReason: input.requiresReason } : {}),
            ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
            ...(input.active !== undefined ? { active: input.active } : {}),
          })
          .where(and(eq(codeTable.tenantId, tenantId), eq(codeTable.id, id)))
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError(`Attendance code ${id} not found.`));
      }
      return ok(toCode(row));
    } catch (error) {
      return err(toDomainError(error, `Could not update attendance code ${id}.`) as DomainError);
    }
  }

  async listCodes(tenantId: TenantId): Promise<AttendanceCode[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(codeTable).where(eq(codeTable.tenantId, tenantId)).orderBy(asc(codeTable.sequence), asc(codeTable.code)),
    );
    return rows.map(toCode);
  }
}
