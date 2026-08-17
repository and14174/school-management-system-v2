import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { ForbiddenError, err, isSystemContext, newId, ok, type Result, type TenantContext } from '@sms/kernel';
import { getContext, withTenantTx } from '@sms/db';
import { PEOPLE_CONTRACT, type PeopleContract } from '@sms/people';
import type { ColumnMapping, ImportFieldSpec, ImportTarget, ImportTx, RowError } from '@sms/import-export';

/**
 * `apps/api` and `@sms/db` each resolve their own copy of `drizzle-orm`
 * under this workspace's `nodeLinker: hoisted` pnpm layout - two different
 * peer-dependency content hashes for the identical `0.45.2` version (visible
 * via `require.resolve` from each package's directory), the same class of
 * duplicate-module-instance issue `main.ts` already documents for `fastify`
 * plugins. `Tx.execute()`'s parameter type is therefore nominally tied to a
 * DIFFERENT `SQL` class than the one this file's `sql\`...\`` calls
 * construct, even though both behave identically at runtime (same
 * parameterized query text + bound values, dispatched to the same
 * `postgres.js` connection). `as never` bridges the two type identities -
 * exactly the kind of documented, narrow escape hatch `main.ts`'s `as any`
 * casts are for the analogous `fastify` mismatch, not a general-purpose
 * type-safety opt-out.
 */
function execute(tx: ImportTx, query: SQL): Promise<unknown> {
  return tx.execute(query as never);
}

export interface PersonImportRow {
  readonly givenName: string;
  readonly familyName: string;
  readonly preferredName?: string;
  readonly dateOfBirth?: string;
  readonly gender?: string;
  /**
   * Not a `people.person_identifier` FK - that table's `type` CHECK
   * constraint (`0500_people.sql`, an EXISTING migration this module may
   * never edit) only allows `student_number`/`national_id`/`previous_school`/
   * `other`, so a dedicated `'import_external_id'` kind isn't available
   * without touching a migration outside this task's scope. Recorded as
   * `type = 'other'` when present (best-effort, non-fatal on a collision -
   * see `create()`) - the PRIMARY re-import match key is `people.person
   * .match_key` (name + date of birth), which the database already
   * maintains and indexes for exactly this kind of lookup.
   */
  readonly externalId?: string;
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const PERSON_FIELDS: ImportFieldSpec[] = [
  { key: 'givenName', label: 'Given name', required: true, type: 'text' },
  { key: 'familyName', label: 'Family name', required: true, type: 'text' },
  { key: 'preferredName', label: 'Preferred name', required: false, type: 'text' },
  { key: 'dateOfBirth', label: 'Date of birth', required: false, type: 'date' },
  { key: 'gender', label: 'Gender', required: false, type: 'text' },
  { key: 'externalId', label: 'External ID', required: false, type: 'text' },
];

function requireTenantContext(): TenantContext {
  const context = getContext();
  if (!context || isSystemContext(context)) {
    throw new ForbiddenError('people.person import requires a resolved tenant context.');
  }
  return context;
}

/**
 * The concrete `ImportTarget` for `people.person` - registered here, in
 * `apps/api`, and NOT inside `@sms/import-export` (a `type:platform`
 * module that must never depend on `@sms/people`, `type:domain` - see
 * `@sms/import-export`'s `application/import-target-registry.ts` for the
 * inversion this implements, the same pattern `@sms/academic`'s
 * `SectionScopeResolverService` uses for `@sms/access`'s
 * `SECTION_SCOPE_RESOLVER`).
 *
 * `create`/`update` write `people.person`/`people.person_identifier`
 * directly via raw SQL against the `tx` `PipelineService.commit` gives them,
 * rather than going through `PeopleContract.createPerson`/`updatePerson` -
 * deliberately. Those contract methods call `@sms/db`'s `withTenantTx`
 * internally, which always opens a NEW transaction; `AuditContract
 * .withBulkOperation` sets `app.bulk_operation_id` via `SET LOCAL` on ONE
 * specific transaction (the one it hands its callback), so a write through a
 * fresh transaction would land unstamped and therefore outside what
 * `revert()` can undo - see `ImportTarget`'s own doc comment for the full
 * reasoning. This does mean an imported person bypasses
 * `PersonService.createPerson`'s `@sms/custom-fields` validation of
 * `custom_fields` - out of scope for this MVP target (it always writes `{}`),
 * called out in the module report.
 */
@Injectable()
export class PersonImportTarget implements ImportTarget<PersonImportRow> {
  readonly entityType = 'people.person';
  readonly fields = PERSON_FIELDS;

  constructor(@Inject(PEOPLE_CONTRACT) private readonly people: PeopleContract) {}

  async parseRow(raw: Record<string, string>, mapping: ColumnMapping): Promise<Result<PersonImportRow, RowError[]>> {
    const errors: RowError[] = [];

    const get = (key: string): string | undefined => {
      const header = mapping[key];
      if (!header) return undefined;
      const value = raw[header];
      return value === undefined ? undefined : value.trim();
    };

    const givenName = get('givenName');
    if (!givenName) {
      errors.push({ field: 'givenName', message: 'Given name is required.' });
    }
    const familyName = get('familyName');
    if (!familyName) {
      errors.push({ field: 'familyName', message: 'Family name is required.' });
    }

    let dateOfBirth: string | undefined;
    const dateOfBirthRaw = get('dateOfBirth');
    if (dateOfBirthRaw) {
      if (!DATE_ONLY_PATTERN.test(dateOfBirthRaw)) {
        errors.push({ field: 'dateOfBirth', message: 'Date of birth must be a YYYY-MM-DD date.' });
      } else {
        dateOfBirth = dateOfBirthRaw;
      }
    }

    if (errors.length > 0) {
      return err(errors);
    }

    return ok({
      givenName: givenName!,
      familyName: familyName!,
      preferredName: get('preferredName') || undefined,
      dateOfBirth,
      gender: get('gender') || undefined,
      externalId: get('externalId') || undefined,
    });
  }

  async findExisting(row: PersonImportRow, tx?: ImportTx): Promise<{ id: string } | null> {
    const query = sql`
      select id from people.person
      where merged_into_id is null
        and match_key = lower(unaccent(${row.givenName} || ' ' || ${row.familyName})) || '|' || coalesce(${row.dateOfBirth ?? null}, '')
      limit 1
    `;

    const rows = tx
      ? ((await execute(tx, query)) as unknown as Array<{ id: string }>)
      : ((await withTenantTx(requireTenantContext(), (t) => execute(t, query))) as unknown as Array<{ id: string }>);

    const found = rows[0];
    return found ? { id: found.id } : null;
  }

  async create(row: PersonImportRow, tx: ImportTx): Promise<{ id: string }> {
    const tenantId = requireTenantContext().tenantId;
    const id = newId();

    await execute(
      tx,
      sql`
      insert into people.person (id, tenant_id, given_name, family_name, preferred_name, date_of_birth, gender, custom_fields)
      values (${id}, ${tenantId}, ${row.givenName}, ${row.familyName}, ${row.preferredName ?? null}, ${row.dateOfBirth ?? null}, ${row.gender ?? null}, '{}'::jsonb)
    `,
    );

    if (row.externalId) {
      try {
        await execute(
          tx,
          sql`
          insert into people.person_identifier (id, tenant_id, person_id, type, value)
          values (${newId()}, ${tenantId}, ${id}, 'other', ${row.externalId})
        `,
        );
      } catch {
        // (tenant_id, type, value) already claimed by another person's
        // 'other' identifier - non-fatal, see PersonImportRow.externalId's
        // own comment. The person row above is still created.
      }
    }

    return { id };
  }

  async update(id: string, row: PersonImportRow, tx: ImportTx): Promise<void> {
    const tenantId = requireTenantContext().tenantId;

    await execute(
      tx,
      sql`
      update people.person
      set given_name = ${row.givenName},
          family_name = ${row.familyName},
          preferred_name = ${row.preferredName ?? null},
          date_of_birth = ${row.dateOfBirth ?? null},
          gender = ${row.gender ?? null}
      where id = ${id} and tenant_id = ${tenantId}
    `,
    );
  }

  async *list(): AsyncIterable<Record<string, unknown>> {
    let cursor: string | null = null;
    do {
      const page = await this.people.searchPeople(cursor ? { limit: 100, cursor } : { limit: 100 });
      for (const person of page.items) {
        yield {
          givenName: person.givenName,
          familyName: person.familyName,
          preferredName: person.preferredName ?? '',
          dateOfBirth: person.dateOfBirth ?? '',
          gender: person.gender ?? '',
        };
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
}
