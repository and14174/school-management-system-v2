import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  newId,
  type DomainError,
  type Result,
  type TenantId,
  type UserId,
  err,
  ok,
} from '@sms/kernel';
import { withTenantTx, type Tx } from '@sms/db';
import type { MergePersonsInput } from '../contract.js';
import type { PersonMerge } from '../domain/types.js';
import { toPersonMerge } from '../infrastructure/mappers.js';
import {
  householdMemberTable,
  personAlertTable,
  personIdentifierTable,
  personMergeTable,
  personRoleTable,
  personTable,
  relationshipTable,
} from '../infrastructure/schema.js';
import { resolvePerson } from './resolve-person.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * Merges two `people.person` records into one. Every related row
 * (`person_role`, `household_member`, `relationship` in both directions,
 * `person_identifier`, `person_alert`) is repointed to the survivor; the
 * loser is NEVER deleted, only tombstoned (`merged_into_id` set - see the
 * `0500` migration header, and `resolve-person.ts`, which is how every other
 * read in this module makes that invisible to callers). Everything below
 * runs inside one `withTenantTx`, so a merge either fully happens or not at
 * all.
 *
 * `survivingId`/`mergedId` are resolved through any EXISTING merge chain
 * first (via `resolvePerson`) before anything else happens - if either id
 * already names a tombstone, this merges the current survivors, not the
 * stale ids the caller happened to have. If that resolves both sides to the
 * same person, there is nothing to do (`ConflictError`: they are already
 * the same record).
 */
@Injectable()
export class MergeService {
  async mergePersons(tenantId: TenantId, mergedByUserId: UserId, input: MergePersonsInput): Promise<Result<PersonMerge, DomainError>> {
    if (input.survivingId === input.mergedId) {
      return err(new ValidationError('Cannot merge a person into themselves.'));
    }
    if (!input.reason || input.reason.trim().length === 0) {
      return err(new ValidationError('A merge reason is required.'));
    }

    const ctx = scopedContext(tenantId);

    try {
      return await withTenantTx(ctx, async (db) => {
        const survivorResult = await resolvePerson(db, tenantId, input.survivingId);
        if (!survivorResult.ok) {
          return err(new NotFoundError(`Person ${input.survivingId} not found.`));
        }
        const loserResult = await resolvePerson(db, tenantId, input.mergedId);
        if (!loserResult.ok) {
          return err(new NotFoundError(`Person ${input.mergedId} not found.`));
        }

        const survivorId = survivorResult.value.id;
        const loserId = loserResult.value.id;

        if (survivorId === loserId) {
          return err(new ConflictError('These records have already been merged into one another.'));
        }

        const payload = await this.repointEverything(db, tenantId, survivorId, loserId);

        await db
          .update(personTable)
          .set({ mergedIntoId: survivorId })
          .where(and(eq(personTable.tenantId, tenantId), eq(personTable.id, loserId)));

        const id = newId();
        const rows = await db
          .insert(personMergeTable)
          .values({
            id,
            tenantId,
            survivingPersonId: survivorId,
            mergedPersonId: loserId,
            mergedByUserId,
            reason: input.reason.trim(),
            payload,
          })
          .returning();
        const row = rows[0];
        if (!row) {
          return err(new ConflictError('Insert returned no row.'));
        }
        return ok(toPersonMerge(row));
      });
    } catch (error) {
      return err(toDomainError(error, 'Could not merge persons.') as DomainError);
    }
  }

  /**
   * Repoints every table that references `loserId` to `survivorId`. Where a
   * repoint could collide with a row the survivor already has (an
   * overlapping identical role, an overlapping household membership, a
   * duplicate identifier, a duplicate relationship, a now-self-referential
   * relationship), the conflicting LOSER row is dropped first - the
   * survivor's own row already covers that fact, so nothing is lost, only
   * de-duplicated. Returns a summary `payload` for `person_merge.payload`.
   */
  private async repointEverything(
    db: Tx,
    tenantId: TenantId,
    survivorId: string,
    loserId: string,
  ): Promise<Record<string, unknown>> {
    // person_role: drop loser roles that would overlap an identical role the
    // survivor already holds (person_role_no_overlap), then repoint the rest.
    await db.execute(sql`
      delete from people.person_role lr
      using people.person_role sr
      where lr.tenant_id = ${tenantId} and lr.person_id = ${loserId}
        and sr.tenant_id = ${tenantId} and sr.person_id = ${survivorId}
        and sr.role = lr.role
        and daterange(sr.valid_from, coalesce(sr.valid_to, 'infinity'::date), '[]')
          && daterange(lr.valid_from, coalesce(lr.valid_to, 'infinity'::date), '[]')
    `);
    const roleRows = await db
      .update(personRoleTable)
      .set({ personId: survivorId })
      .where(and(eq(personRoleTable.tenantId, tenantId), eq(personRoleTable.personId, loserId)))
      .returning({ id: personRoleTable.id });

    // household_member: same shape - drop overlapping-duplicate loser rows, repoint the rest.
    await db.execute(sql`
      delete from people.household_member lm
      using people.household_member sm
      where lm.tenant_id = ${tenantId} and lm.person_id = ${loserId}
        and sm.tenant_id = ${tenantId} and sm.person_id = ${survivorId}
        and sm.household_id = lm.household_id
        and daterange(sm.valid_from, coalesce(sm.valid_to, 'infinity'::date), '[]')
          && daterange(lm.valid_from, coalesce(lm.valid_to, 'infinity'::date), '[]')
    `);
    const householdRows = await db
      .update(householdMemberTable)
      .set({ personId: survivorId })
      .where(and(eq(householdMemberTable.tenantId, tenantId), eq(householdMemberTable.personId, loserId)))
      .returning({ id: householdMemberTable.id });

    // relationship: a relationship BETWEEN the survivor and the loser becomes
    // meaningless (self-referential) once merged - drop it outright, in
    // either direction, before repointing anything else.
    await db.execute(sql`
      delete from people.relationship
      where tenant_id = ${tenantId}
        and ((from_person_id = ${loserId} and to_person_id = ${survivorId})
          or (from_person_id = ${survivorId} and to_person_id = ${loserId}))
    `);
    // Drop loser relationships that would duplicate one the survivor already
    // has after repointing (unique (tenant_id, from, to, type)).
    await db.execute(sql`
      delete from people.relationship lrel
      using people.relationship srel
      where lrel.tenant_id = ${tenantId} and lrel.from_person_id = ${loserId}
        and srel.tenant_id = ${tenantId} and srel.from_person_id = ${survivorId}
        and srel.to_person_id = lrel.to_person_id and srel.type = lrel.type
    `);
    await db.execute(sql`
      delete from people.relationship lrel
      using people.relationship srel
      where lrel.tenant_id = ${tenantId} and lrel.to_person_id = ${loserId}
        and srel.tenant_id = ${tenantId} and srel.to_person_id = ${survivorId}
        and srel.from_person_id = lrel.from_person_id and srel.type = lrel.type
    `);
    const relationshipFromRows = await db
      .update(relationshipTable)
      .set({ fromPersonId: survivorId })
      .where(and(eq(relationshipTable.tenantId, tenantId), eq(relationshipTable.fromPersonId, loserId)))
      .returning({ id: relationshipTable.id });
    const relationshipToRows = await db
      .update(relationshipTable)
      .set({ toPersonId: survivorId })
      .where(and(eq(relationshipTable.tenantId, tenantId), eq(relationshipTable.toPersonId, loserId)))
      .returning({ id: relationshipTable.id });

    // person_identifier: drop loser identifiers duplicating one the survivor
    // already holds (unique (tenant_id, type, value)), repoint the rest.
    await db.execute(sql`
      delete from people.person_identifier li
      using people.person_identifier si
      where li.tenant_id = ${tenantId} and li.person_id = ${loserId}
        and si.tenant_id = ${tenantId} and si.person_id = ${survivorId}
        and si.type = li.type and si.value = li.value
    `);
    const identifierRows = await db
      .update(personIdentifierTable)
      .set({ personId: survivorId })
      .where(and(eq(personIdentifierTable.tenantId, tenantId), eq(personIdentifierTable.personId, loserId)))
      .returning({ id: personIdentifierTable.id });

    // person_alert: no uniqueness constraint - a plain repoint is always safe.
    const alertRows = await db
      .update(personAlertTable)
      .set({ personId: survivorId })
      .where(and(eq(personAlertTable.tenantId, tenantId), eq(personAlertTable.personId, loserId)))
      .returning({ id: personAlertTable.id });

    return {
      repointedRoles: roleRows.length,
      repointedHouseholdMemberships: householdRows.length,
      repointedRelationshipsFrom: relationshipFromRows.length,
      repointedRelationshipsTo: relationshipToRows.length,
      repointedIdentifiers: identifierRows.length,
      repointedAlerts: alertRows.length,
    };
  }
}
