import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { NotFoundError, newId, type DomainError, type PersonId, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx, type Tx } from '@sms/db';
import type { AddContactPointInput, UpdateContactPointInput } from '../contract.js';
import type { ContactPoint } from '../domain/types.js';
import { toContactPoint } from '../infrastructure/mappers.js';
import { contactPointTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * Real email/phone addresses for a person - see the `0503` migration
 * header. Same shape as `IdentifierService`, with one extra responsibility:
 * `contact_point_one_primary_per_kind_idx` (a partial unique index on
 * `(tenant_id, person_id, kind) where is_primary and archived_at is null`)
 * allows at most one primary per (person, kind), so setting `isPrimary: true`
 * here first demotes any existing non-archived primary of the same kind IN
 * THE SAME TRANSACTION as the write that sets the new one - never left as a
 * two-step "clear then set" a caller could interleave with, and never left
 * to the index to reject after the fact.
 */
@Injectable()
export class ContactPointService {
  /** Demotes any current non-archived primary of `kind` for `personId`, EXCLUDING `exceptId` (the row about to become primary, when updating in place). Must run inside the same tx as the write that sets the new primary. */
  private async demoteExistingPrimary(
    tx: Tx,
    tenantId: TenantId,
    personId: PersonId,
    kind: string,
    exceptId: string | null,
  ): Promise<void> {
    await tx
      .update(contactPointTable)
      .set({ isPrimary: false })
      .where(
        and(
          eq(contactPointTable.tenantId, tenantId),
          eq(contactPointTable.personId, personId),
          eq(contactPointTable.kind, kind),
          eq(contactPointTable.isPrimary, true),
          isNull(contactPointTable.archivedAt),
          ...(exceptId ? [ne(contactPointTable.id, exceptId)] : []),
        ),
      );
  }

  async addContactPoint(tenantId: TenantId, input: AddContactPointInput): Promise<Result<ContactPoint, DomainError>> {
    const ctx = scopedContext(tenantId);
    const id = newId();
    const isPrimary = input.isPrimary ?? false;
    try {
      const row = await withTenantTx(ctx, async (db) => {
        if (isPrimary) {
          await this.demoteExistingPrimary(db, tenantId, input.personId, input.kind, null);
        }
        const rows = await db
          .insert(contactPointTable)
          .values({
            id,
            tenantId,
            personId: input.personId,
            kind: input.kind,
            value: input.value,
            label: input.label ?? null,
            isPrimary,
          })
          .returning();
        return rows[0];
      });
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toContactPoint(row));
    } catch (error) {
      return err(toDomainError(error, `Could not add "${input.kind}" contact point.`) as DomainError);
    }
  }

  /** Non-archived contact points for one person, newest first. */
  async listContactPoints(tenantId: TenantId, personId: PersonId): Promise<ContactPoint[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(contactPointTable)
        .where(
          and(eq(contactPointTable.tenantId, tenantId), eq(contactPointTable.personId, personId), isNull(contactPointTable.archivedAt)),
        )
        .orderBy(desc(contactPointTable.createdAt)),
    );
    return rows.map(toContactPoint);
  }

  /**
   * Non-archived contact points for MANY people in one query, keyed by
   * `personId` - see the contract's own doc comment for why this exists (the
   * guardian recipient resolver would otherwise call `listContactPoints` once
   * per relationship and N+1). Every requested id is present in the returned
   * map, even with an empty array, so "no contact points on file" is
   * distinguishable from "not asked about".
   */
  async listContactPointsForPeople(tenantId: TenantId, personIds: PersonId[]): Promise<Map<PersonId, ContactPoint[]>> {
    const result = new Map<PersonId, ContactPoint[]>();
    for (const personId of personIds) {
      result.set(personId, []);
    }
    if (personIds.length === 0) {
      return result;
    }

    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(contactPointTable)
        .where(
          and(
            eq(contactPointTable.tenantId, tenantId),
            inArray(contactPointTable.personId, personIds),
            isNull(contactPointTable.archivedAt),
          ),
        )
        .orderBy(desc(contactPointTable.createdAt)),
    );

    for (const row of rows) {
      const point = toContactPoint(row);
      const bucket = result.get(point.personId);
      if (bucket) {
        bucket.push(point);
      } else {
        result.set(point.personId, [point]);
      }
    }
    return result;
  }

  async updateContactPoint(tenantId: TenantId, id: string, input: UpdateContactPointInput): Promise<Result<ContactPoint, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const row = await withTenantTx(ctx, async (db) => {
        const [existing] = await db
          .select()
          .from(contactPointTable)
          .where(and(eq(contactPointTable.tenantId, tenantId), eq(contactPointTable.id, id)))
          .limit(1);
        if (!existing) {
          return undefined;
        }

        if (input.isPrimary === true) {
          await this.demoteExistingPrimary(db, tenantId, existing.personId as PersonId, existing.kind, id);
        }

        const rows = await db
          .update(contactPointTable)
          .set({
            ...(input.value !== undefined ? { value: input.value } : {}),
            ...(input.label !== undefined ? { label: input.label } : {}),
            ...(input.isPrimary !== undefined ? { isPrimary: input.isPrimary } : {}),
            ...(input.verifiedAt !== undefined ? { verifiedAt: input.verifiedAt } : {}),
          })
          .where(and(eq(contactPointTable.tenantId, tenantId), eq(contactPointTable.id, id)))
          .returning();
        return rows[0];
      });
      if (!row) {
        return err(new NotFoundError(`Contact point ${id} not found.`));
      }
      return ok(toContactPoint(row));
    } catch (error) {
      return err(toDomainError(error, `Could not update contact point ${id}.`) as DomainError);
    }
  }

  /** Archives (never deletes) - see the `0503` migration header. */
  async archiveContactPoint(tenantId: TenantId, id: string): Promise<Result<void, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(contactPointTable)
          .set({ archivedAt: new Date() })
          .where(and(eq(contactPointTable.tenantId, tenantId), eq(contactPointTable.id, id), isNull(contactPointTable.archivedAt)))
          .returning(),
      );
      if (rows.length === 0) {
        return err(new NotFoundError(`Contact point ${id} not found (or already archived).`));
      }
      return ok(undefined);
    } catch (error) {
      return err(toDomainError(error, `Could not archive contact point ${id}.`) as DomainError);
    }
  }
}
