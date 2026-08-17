import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { NotFoundError, newId, todayDateOnly, type DomainError, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { AddHouseholdMemberInput, CreateHouseholdInput, EndHouseholdMemberInput, UpdateHouseholdInput } from '../contract.js';
import type { Household, HouseholdMember } from '../domain/types.js';
import { toHousehold, toHouseholdMember } from '../infrastructure/mappers.js';
import { householdMemberTable, householdTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

@Injectable()
export class HouseholdService {
  async createHousehold(tenantId: TenantId, input: CreateHouseholdInput): Promise<Result<Household, DomainError>> {
    const ctx = scopedContext(tenantId);
    const id = newId();
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(householdTable)
          .values({ id, tenantId, name: input.name, primaryAddress: input.primaryAddress ?? {} })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toHousehold(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create household "${input.name}".`) as DomainError);
    }
  }

  async getHousehold(tenantId: TenantId, id: string): Promise<Result<Household, NotFoundError>> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(householdTable)
        .where(and(eq(householdTable.tenantId, tenantId), eq(householdTable.id, id)))
        .limit(1),
    );
    const row = rows[0];
    return row ? ok(toHousehold(row)) : err(new NotFoundError(`Household ${id} not found.`));
  }

  async updateHousehold(tenantId: TenantId, id: string, input: UpdateHouseholdInput): Promise<Result<Household, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(householdTable)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.primaryAddress !== undefined ? { primaryAddress: input.primaryAddress } : {}),
          })
          .where(and(eq(householdTable.tenantId, tenantId), eq(householdTable.id, id)))
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError(`Household ${id} not found.`));
      }
      return ok(toHousehold(row));
    } catch (error) {
      return err(toDomainError(error, `Could not update household ${id}.`) as DomainError);
    }
  }

  async addHouseholdMember(tenantId: TenantId, input: AddHouseholdMemberInput): Promise<Result<HouseholdMember, DomainError>> {
    const ctx = scopedContext(tenantId);
    const id = newId();
    const validFrom = input.validFrom ?? todayDateOnly();
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(householdMemberTable)
          .values({
            id,
            tenantId,
            householdId: input.householdId,
            personId: input.personId,
            isPrimaryContact: input.isPrimaryContact ?? false,
            validFrom,
            validTo: input.validTo ?? null,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toHouseholdMember(row));
    } catch (error) {
      return err(toDomainError(error, 'Could not add household member.') as DomainError);
    }
  }

  async endHouseholdMember(tenantId: TenantId, input: EndHouseholdMemberInput): Promise<Result<void, DomainError>> {
    const ctx = scopedContext(tenantId);
    const asOf = input.asOf ?? todayDateOnly();
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(householdMemberTable)
          .set({ validTo: asOf })
          .where(
            and(
              eq(householdMemberTable.tenantId, tenantId),
              eq(householdMemberTable.householdId, input.householdId),
              eq(householdMemberTable.personId, input.personId),
            ),
          )
          .returning(),
      );
      if (rows.length === 0) {
        return err(new NotFoundError(`No matching household membership for person ${input.personId} in household ${input.householdId}.`));
      }
      return ok(undefined);
    } catch (error) {
      return err(toDomainError(error, 'Could not end household membership.') as DomainError);
    }
  }

  async listHouseholdMembers(tenantId: TenantId, householdId: string): Promise<HouseholdMember[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(householdMemberTable)
        .where(and(eq(householdMemberTable.tenantId, tenantId), eq(householdMemberTable.householdId, householdId)))
        .orderBy(householdMemberTable.validFrom),
    );
    return rows.map(toHouseholdMember);
  }
}
