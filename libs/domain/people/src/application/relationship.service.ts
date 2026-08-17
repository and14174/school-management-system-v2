import { Injectable } from '@nestjs/common';
import { and, eq, or } from 'drizzle-orm';
import { NotFoundError, ValidationError, newId, type DomainError, type PersonId, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { CreateRelationshipInput, UpdateRelationshipInput } from '../contract.js';
import type { Relationship } from '../domain/types.js';
import { toRelationship } from '../infrastructure/mappers.js';
import { relationshipTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

@Injectable()
export class RelationshipService {
  async createRelationship(tenantId: TenantId, input: CreateRelationshipInput): Promise<Result<Relationship, DomainError>> {
    if (input.fromPersonId === input.toPersonId) {
      return err(new ValidationError('A person cannot have a relationship to themselves.'));
    }

    const ctx = scopedContext(tenantId);
    const id = newId();
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(relationshipTable)
          .values({
            id,
            tenantId,
            fromPersonId: input.fromPersonId,
            toPersonId: input.toPersonId,
            type: input.type,
            hasCustody: input.hasCustody ?? false,
            mayPickup: input.mayPickup ?? false,
            mayReceiveComms: input.mayReceiveComms ?? false,
            priority: input.priority ?? 0,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toRelationship(row));
    } catch (error) {
      return err(toDomainError(error, 'Could not create relationship.') as DomainError);
    }
  }

  async updateRelationship(tenantId: TenantId, id: string, input: UpdateRelationshipInput): Promise<Result<Relationship, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(relationshipTable)
          .set({
            ...(input.hasCustody !== undefined ? { hasCustody: input.hasCustody } : {}),
            ...(input.mayPickup !== undefined ? { mayPickup: input.mayPickup } : {}),
            ...(input.mayReceiveComms !== undefined ? { mayReceiveComms: input.mayReceiveComms } : {}),
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
          })
          .where(and(eq(relationshipTable.tenantId, tenantId), eq(relationshipTable.id, id)))
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError(`Relationship ${id} not found.`));
      }
      return ok(toRelationship(row));
    } catch (error) {
      return err(toDomainError(error, `Could not update relationship ${id}.`) as DomainError);
    }
  }

  async deleteRelationship(tenantId: TenantId, id: string): Promise<Result<void, DomainError>> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.delete(relationshipTable).where(and(eq(relationshipTable.tenantId, tenantId), eq(relationshipTable.id, id))).returning(),
    );
    if (rows.length === 0) {
      return err(new NotFoundError(`Relationship ${id} not found.`));
    }
    return ok(undefined);
  }

  /** Both directions: `personId` as either `fromPersonId` or `toPersonId`. */
  async listRelationships(tenantId: TenantId, personId: PersonId): Promise<Relationship[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(relationshipTable)
        .where(
          and(
            eq(relationshipTable.tenantId, tenantId),
            or(eq(relationshipTable.fromPersonId, personId), eq(relationshipTable.toPersonId, personId)),
          ),
        )
        .orderBy(relationshipTable.priority),
    );
    return rows.map(toRelationship);
  }
}
