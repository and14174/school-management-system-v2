import { eq } from 'drizzle-orm';
import { NotFoundError, type PersonId, type Result, type TenantId, err, ok } from '@sms/kernel';
import type { Tx } from '@sms/db';
import { toPerson } from '../infrastructure/mappers.js';
import { personTable } from '../infrastructure/schema.js';
import type { Person } from '../domain/types.js';

/**
 * A merge is never deleted, only tombstoned (`people.person.merged_into_id`
 * set - see the `0500` migration header): old ids appear in URLs, exports
 * and external integrations, and must keep resolving forever. Every read
 * path in this module goes through this function first so a caller never
 * has to know a merge happened - it just always gets the current survivor.
 *
 * Follows the `merged_into_id` chain to its end, inside the SAME transaction
 * `fn` is already running in (so a caller mid-write sees a consistent view).
 * Guards against a cycle (which should be structurally impossible -
 * `MergeService` refuses to create one - but a guard here costs nothing and
 * turns "infinite loop" into a clean, diagnosable error if that invariant is
 * ever broken by a bug or a direct SQL edit).
 */
export async function resolvePerson(tx: Tx, tenantId: TenantId, id: PersonId): Promise<Result<Person, NotFoundError>> {
  const visited = new Set<string>();
  let currentId: string = id;

  for (let hop = 0; hop <= 50; hop += 1) {
    if (visited.has(currentId)) {
      return err(new NotFoundError(`Person ${id} could not be resolved: merge chain starting at ${currentId} cycles back on itself.`));
    }
    visited.add(currentId);

    const rows = await tx.select().from(personTable).where(eq(personTable.id, currentId)).limit(1);
    const row = rows[0];
    if (!row || row.tenantId !== tenantId) {
      return err(new NotFoundError(`Person ${id} not found.`));
    }
    if (!row.mergedIntoId) {
      return ok(toPerson(row));
    }
    currentId = row.mergedIntoId;
  }

  return err(new NotFoundError(`Person ${id} could not be resolved: merge chain exceeded 50 hops.`));
}
