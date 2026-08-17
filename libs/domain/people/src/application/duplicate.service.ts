import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { PersonId, TenantId } from '@sms/kernel';
import { withTenantTx, type Tx } from '@sms/db';
import type { FindDuplicatesInput } from '../contract.js';
import type { DuplicateCandidate, Person } from '../domain/types.js';
import { toPerson } from '../infrastructure/mappers.js';
import { personTable } from '../infrastructure/schema.js';
import { resolvePerson } from './resolve-person.js';
import { scopedContext } from './scoped-context.js';

// Scoring weights. Each signal contributes independently and the total is
// capped at 1.0 - an exact match_key hit alone (same normalised name AND
// date of birth) is already a strong signal; trigram name similarity,
// a shared identifier value, and a shared household each add further
// evidence on top of - or instead of - an exact match.
const EXACT_MATCH_WEIGHT = 0.6;
const SAME_DATE_OF_BIRTH_WEIGHT = 0.35;
const TRIGRAM_WEIGHT = 0.4;
const SHARED_IDENTIFIER_WEIGHT = 0.3;
const SHARED_HOUSEHOLD_WEIGHT = 0.2;
// pg_trgm's own conventional default (`similarity_threshold` GUC default) -
// candidates below this are not even considered, so a merely coincidental
// three-letter overlap between two unrelated names never surfaces.
const TRIGRAM_THRESHOLD = 0.25;
const MAX_CANDIDATES = 20;
// A candidate whose total score doesn't clear this is not worth showing -
// distinguishes "no real signal" from "one weak signal happened to fire".
const MIN_REPORTABLE_SCORE = 0.2;

interface BaseIdentity {
  readonly excludeId: string | null;
  readonly matchKey: string;
  readonly nameNormalized: string;
  readonly dateOfBirth: string | null;
}

interface DuplicateCandidateRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly given_name: string;
  readonly family_name: string;
  readonly preferred_name: string | null;
  readonly date_of_birth: string | null;
  readonly gender: string | null;
  readonly photo_file_id: string | null;
  readonly custom_fields: unknown;
  readonly merged_into_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly exact_match: boolean;
  readonly same_date_of_birth: boolean;
  readonly trgm_score: number | string | null;
  readonly shares_identifier: boolean;
  readonly shares_household: boolean;
}

function rawRowToPerson(row: DuplicateCandidateRow): Person {
  // Built from a raw `db.execute(sql\`...\`)` row (snake_case columns, no
  // static type from drizzle) rather than a `db.select().from(personTable)`
  // row - shaped to match `toPerson`'s expected input regardless.
  return toPerson({
    id: row.id,
    tenantId: row.tenant_id,
    givenName: row.given_name,
    familyName: row.family_name,
    preferredName: row.preferred_name,
    dateOfBirth: row.date_of_birth,
    gender: row.gender,
    photoFileId: row.photo_file_id,
    customFields: row.custom_fields,
    mergedIntoId: row.merged_into_id,
    nameNormalized: null,
    matchKey: null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  } as unknown as Parameters<typeof toPerson>[0]);
}

/**
 * Duplicate detection: finds people in the same tenant who plausibly
 * describe the same human as `input` (either an existing `personId`, or a
 * not-yet-created candidate name/date-of-birth for a pre-create check).
 * Scores candidates from four independent signals - see the weight
 * constants above - and returns them ranked highest-first. Tombstoned
 * records (already-merged losers) are never returned as candidates: a
 * merge has already resolved that duplicate.
 */
@Injectable()
export class DuplicateService {
  async findPotentialDuplicates(tenantId: TenantId, input: FindDuplicatesInput): Promise<DuplicateCandidate[]> {
    const ctx = scopedContext(tenantId);

    return withTenantTx(ctx, async (db) => {
      const base = await this.resolveBaseIdentity(db, tenantId, input);
      if (!base) {
        return [];
      }

      const excludeClause = base.excludeId === null ? sql`true` : sql`p.id <> ${base.excludeId}`;
      const identifierClause =
        base.excludeId === null
          ? sql`false`
          : sql`exists (
              select 1 from people.person_identifier pi1
              join people.person_identifier pi2
                on pi1.type = pi2.type and pi1.value = pi2.value and pi1.tenant_id = pi2.tenant_id
              where pi1.person_id = p.id and pi2.person_id = ${base.excludeId} and pi1.tenant_id = ${tenantId}
            )`;
      const householdClause =
        base.excludeId === null
          ? sql`false`
          : sql`exists (
              select 1 from people.household_member hm1
              join people.household_member hm2
                on hm1.household_id = hm2.household_id and hm1.tenant_id = hm2.tenant_id
              where hm1.person_id = p.id and hm2.person_id = ${base.excludeId} and hm1.tenant_id = ${tenantId}
            )`;

      // A shared date of birth is scored as its OWN signal (not just as one
      // half of match_key) - a name typo ("Alexander" vs "Alexandar") should
      // not have to also be an exact string match to benefit from the two
      // people plainly sharing a birthdate, which alone is already a strong,
      // independent piece of evidence.
      const sameDobClause = base.dateOfBirth === null ? sql`false` : sql`p.date_of_birth = ${base.dateOfBirth}::date`;

      const rawRows = await db.execute(sql`
        select
          p.id, p.tenant_id, p.given_name, p.family_name, p.preferred_name, p.date_of_birth, p.gender,
          p.photo_file_id, p.custom_fields, p.merged_into_id, p.created_at, p.updated_at,
          (p.match_key = ${base.matchKey}) as exact_match,
          (${sameDobClause}) as same_date_of_birth,
          coalesce(similarity(p.name_normalized, ${base.nameNormalized}), 0) as trgm_score,
          (${identifierClause}) as shares_identifier,
          (${householdClause}) as shares_household
        from people.person p
        where p.tenant_id = ${tenantId}
          and p.merged_into_id is null
          and (${excludeClause})
          and (
            p.match_key = ${base.matchKey}
            or similarity(p.name_normalized, ${base.nameNormalized}) > ${TRIGRAM_THRESHOLD}
          )
        order by exact_match desc, trgm_score desc
        limit ${MAX_CANDIDATES}
      `);
      const rows = rawRows as unknown as DuplicateCandidateRow[];

      const scored: DuplicateCandidate[] = [];
      for (const row of rows) {
        const reasons: string[] = [];
        let score = 0;

        if (row.exact_match) {
          score += EXACT_MATCH_WEIGHT;
          reasons.push('exact name + date of birth match');
        } else if (row.same_date_of_birth) {
          // Only counted separately when NOT an exact match - exact_match
          // already implies the same date of birth (it is half of match_key),
          // so adding both would double-count the same fact.
          score += SAME_DATE_OF_BIRTH_WEIGHT;
          reasons.push('same date of birth');
        }

        const trgmScore = Number(row.trgm_score) || 0;
        if (trgmScore > 0) {
          score += trgmScore * TRIGRAM_WEIGHT;
          if (!row.exact_match) {
            reasons.push(`similar name (${Math.round(trgmScore * 100)}% match)`);
          }
        }

        if (row.shares_identifier) {
          score += SHARED_IDENTIFIER_WEIGHT;
          reasons.push('shares an identifier (e.g. the same student or national id)');
        }

        if (row.shares_household) {
          score += SHARED_HOUSEHOLD_WEIGHT;
          reasons.push('shares a household');
        }

        if (score < MIN_REPORTABLE_SCORE) {
          continue;
        }

        scored.push({ person: rawRowToPerson(row), score: Math.min(score, 1), reasons });
      }

      scored.sort((a, b) => b.score - a.score);
      return scored;
    });
  }

  private async resolveBaseIdentity(db: Tx, tenantId: TenantId, input: FindDuplicatesInput): Promise<BaseIdentity | null> {
    if ('personId' in input) {
      const resolved = await resolvePerson(db, tenantId, input.personId as PersonId);
      if (!resolved.ok) {
        return null;
      }
      const rows = await db
        .select()
        .from(personTable)
        .where(and(eq(personTable.tenantId, tenantId), eq(personTable.id, resolved.value.id)))
        .limit(1);
      const row = rows[0];
      if (!row) {
        return null;
      }
      return {
        excludeId: row.id,
        matchKey: row.matchKey ?? '',
        nameNormalized: row.nameNormalized ?? '',
        dateOfBirth: row.dateOfBirth,
      };
    }

    const computedRows = await db.execute(sql`
      select
        lower(unaccent(${input.givenName} || ' ' || ${input.familyName})) as name_normalized,
        lower(unaccent(${input.givenName} || ' ' || ${input.familyName}))
          || '|' || coalesce(${input.dateOfBirth ?? null}::date::text, '') as match_key
    `);
    const computed = (computedRows as unknown as Array<{ name_normalized: string; match_key: string }>)[0];
    if (!computed) {
      return null;
    }
    return {
      excludeId: null,
      matchKey: computed.match_key,
      nameNormalized: computed.name_normalized,
      dateOfBirth: input.dateOfBirth ?? null,
    };
  }
}
