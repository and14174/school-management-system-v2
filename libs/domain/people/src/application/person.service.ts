import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, ilike, isNull, or, sql } from 'drizzle-orm';
import {
  ConflictError,
  NotFoundError,
  newId,
  todayDateOnly,
  type DomainError,
  type PersonId,
  type Result,
  type TenantId,
  err,
  ok,
} from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import { CUSTOM_FIELDS_CONTRACT, type CustomFieldsContract } from '@sms/custom-fields';
import type { CreatePersonInput, SearchPeopleInput, UpdatePersonInput } from '../contract.js';
import type { PageResult, Person } from '../domain/types.js';
import { toPerson } from '../infrastructure/mappers.js';
import { personRoleTable, personTable } from '../infrastructure/schema.js';
import { resolvePerson } from './resolve-person.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/** The `entity_type` `@sms/custom-fields` field definitions for a person are registered under. */
export const PERSON_ENTITY_TYPE = 'people.person';

@Injectable()
export class PersonService {
  constructor(@Inject(CUSTOM_FIELDS_CONTRACT) private readonly customFields: CustomFieldsContract) {}

  async createPerson(tenantId: TenantId, input: CreatePersonInput): Promise<Result<Person, DomainError>> {
    const validated = await this.customFields.validate(tenantId, PERSON_ENTITY_TYPE, input.customFields ?? {});
    if (!validated.ok) {
      return validated;
    }

    const ctx = scopedContext(tenantId);
    const id = newId();

    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(personTable)
          .values({
            id,
            tenantId,
            givenName: input.givenName,
            familyName: input.familyName,
            preferredName: input.preferredName ?? null,
            dateOfBirth: input.dateOfBirth ?? null,
            gender: input.gender ?? null,
            photoFileId: input.photoFileId ?? null,
            customFields: validated.value,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new ConflictError('Insert returned no row.'));
      }
      return ok(toPerson(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create person "${input.givenName} ${input.familyName}".`) as DomainError);
    }
  }

  /** Resolves `id` through any merge chain first (see `resolvePerson`) - callers never have to know a merge happened. */
  async getPerson(tenantId: TenantId, id: PersonId): Promise<Result<Person, NotFoundError>> {
    const ctx = scopedContext(tenantId);
    return withTenantTx(ctx, (db) => resolvePerson(db, tenantId, id));
  }

  async updatePerson(tenantId: TenantId, id: PersonId, input: UpdatePersonInput): Promise<Result<Person, DomainError>> {
    const ctx = scopedContext(tenantId);

    const existingResult = await withTenantTx(ctx, (db) => resolvePerson(db, tenantId, id));
    if (!existingResult.ok) {
      return existingResult;
    }
    const existing = existingResult.value;

    const mergedCustomFields = input.customFields !== undefined ? { ...existing.customFields, ...input.customFields } : existing.customFields;
    const validated = await this.customFields.validate(tenantId, PERSON_ENTITY_TYPE, mergedCustomFields);
    if (!validated.ok) {
      return validated;
    }

    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(personTable)
          .set({
            ...(input.givenName !== undefined ? { givenName: input.givenName } : {}),
            ...(input.familyName !== undefined ? { familyName: input.familyName } : {}),
            ...(input.preferredName !== undefined ? { preferredName: input.preferredName } : {}),
            ...(input.dateOfBirth !== undefined ? { dateOfBirth: input.dateOfBirth } : {}),
            ...(input.gender !== undefined ? { gender: input.gender } : {}),
            ...(input.photoFileId !== undefined ? { photoFileId: input.photoFileId } : {}),
            customFields: validated.value,
          })
          // Write against the SURVIVOR's real id (existing.id), not the
          // caller-supplied id - it may have named a now-merged tombstone,
          // and resolvePerson above already followed that chain.
          .where(and(eq(personTable.tenantId, tenantId), eq(personTable.id, existing.id)))
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError(`Person ${id} not found.`));
      }
      return ok(toPerson(row));
    } catch (error) {
      return err(toDomainError(error, `Could not update person ${id}.`) as DomainError);
    }
  }

  /**
   * Free-text name search plus optional role/campus filters. Tombstoned
   * records (`merged_into_id is not null`) are never returned - a merge
   * loser is reachable only via `getPerson` on its own id (which resolves to
   * the survivor), never as a distinct search result. Ordered by `id`
   * (UUIDv7, so this is creation order) rather than text-match relevance -
   * a deliberate simplification for a stable, simple keyset cursor; a
   * relevance-ranked cursor would need to encode the ranking score itself,
   * which is future work if the ordering-by-relevance need becomes real.
   */
  async searchPeople(tenantId: TenantId, input: SearchPeopleInput): Promise<PageResult<Person>> {
    const ctx = scopedContext(tenantId);
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);

    // Two exclusions, for two different reasons:
    //   mergedIntoId - a merge loser is reachable only via getPerson on its own
    //                  id (which resolves to the survivor), never as a result.
    //   archivedAt   - withdrawn from view without being deleted, e.g. by a
    //                  reverted import (see migration 0502). The row still
    //                  resolves by id, but it must not appear in any listing:
    //                  a school that reverts a bad import expects those people
    //                  to be gone from the product.
    const conditions = [
      eq(personTable.tenantId, tenantId),
      isNull(personTable.mergedIntoId),
      isNull(personTable.archivedAt),
    ];

    if (input.query) {
      const pattern = `%${input.query.trim()}%`;
      conditions.push(
        or(
          ilike(personTable.givenName, pattern),
          ilike(personTable.familyName, pattern),
          ilike(personTable.preferredName, pattern),
          sql`${personTable.nameNormalized} % lower(unaccent(${input.query.trim()}))`,
        )!,
      );
    }

    if (input.cursor) {
      conditions.push(gt(personTable.id, input.cursor));
    }

    const rows = await withTenantTx(ctx, (db) => {
      if (input.role || input.campusId) {
        const today = todayDateOnly();
        const roleConditions = [eq(personRoleTable.tenantId, tenantId)];
        if (input.role) {
          roleConditions.push(eq(personRoleTable.role, input.role));
        }
        if (input.campusId) {
          roleConditions.push(eq(personRoleTable.campusId, input.campusId));
        }
        return db
          .selectDistinct({ person: personTable })
          .from(personTable)
          .innerJoin(
            personRoleTable,
            and(
              eq(personRoleTable.personId, personTable.id),
              ...roleConditions,
              sql`${personRoleTable.validFrom} <= ${today}`,
              sql`(${personRoleTable.validTo} is null or ${personRoleTable.validTo} >= ${today})`,
            ),
          )
          .where(and(...conditions))
          .orderBy(asc(personTable.id))
          .limit(limit + 1)
          .then((results) => results.map((r) => r.person));
      }
      return db
        .select()
        .from(personTable)
        .where(and(...conditions))
        .orderBy(asc(personTable.id))
        .limit(limit + 1);
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1]!.id : null;

    return { items: page.map(toPerson), nextCursor };
  }
}
