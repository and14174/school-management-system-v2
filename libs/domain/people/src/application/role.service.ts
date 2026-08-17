import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { NotFoundError, newId, todayDateOnly, type DomainError, type PersonId, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { AssignRoleInput, EndRoleInput } from '../contract.js';
import type { PersonRole } from '../domain/types.js';
import { toPersonRole } from '../infrastructure/mappers.js';
import { personRoleTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

@Injectable()
export class RoleService {
  async listRoles(tenantId: TenantId, personId: PersonId): Promise<PersonRole[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(personRoleTable)
        .where(and(eq(personRoleTable.tenantId, tenantId), eq(personRoleTable.personId, personId)))
        .orderBy(personRoleTable.validFrom),
    );
    return rows.map(toPersonRole);
  }

  /**
   * Runs as the ambient tenant/actor. Defaults `validFrom` to today and
   * leaves `validTo` open-ended unless the caller says otherwise - same
   * shape as `@sms/access`'s `RoleService.assignRole`. The
   * `person_role_no_overlap` exclusion constraint (0500 migration) rejects
   * an overlapping assignment of the SAME role, surfacing as a
   * `ConflictError` via `toDomainError`.
   */
  async assignRole(tenantId: TenantId, input: AssignRoleInput): Promise<Result<PersonRole, DomainError>> {
    const ctx = scopedContext(tenantId);
    const id = newId();
    const validFrom = input.validFrom ?? todayDateOnly();

    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(personRoleTable)
          .values({
            id,
            tenantId,
            personId: input.personId,
            role: input.role,
            campusId: input.campusId ?? null,
            validFrom,
            validTo: input.validTo ?? null,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toPersonRole(row));
    } catch (error) {
      return err(toDomainError(error, `Could not assign role "${input.role}".`) as DomainError);
    }
  }

  /**
   * Ends the currently-effective role matching (person, role[, campus]) as
   * of `asOf` (default: today) by setting `valid_to`, rather than deleting
   * the row - the role's past effect must remain a fact of record, exactly
   * like `@sms/access`'s `RoleService.revokeRole`.
   */
  async endRole(tenantId: TenantId, input: EndRoleInput): Promise<Result<void, DomainError>> {
    const ctx = scopedContext(tenantId);
    const asOf = input.asOf ?? todayDateOnly();

    const conditions = [
      eq(personRoleTable.tenantId, tenantId),
      eq(personRoleTable.personId, input.personId),
      eq(personRoleTable.role, input.role),
    ];
    if (input.campusId !== undefined && input.campusId !== null) {
      conditions.push(eq(personRoleTable.campusId, input.campusId));
    }

    try {
      const rows = await withTenantTx(ctx, (db) =>
        db.update(personRoleTable).set({ validTo: asOf }).where(and(...conditions)).returning(),
      );
      if (rows.length === 0) {
        return err(new NotFoundError(`No matching role "${input.role}" for person ${input.personId}.`));
      }
      return ok(undefined);
    } catch (error) {
      return err(toDomainError(error, 'Could not end role.') as DomainError);
    }
  }
}
