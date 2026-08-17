import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import {
  ConflictError,
  NotFoundError,
  formatDateOnly,
  newId,
  todayDateOnly,
  type DateOnly,
  type DomainError,
  type PersonId,
  type Result,
  type TenantId,
  err,
  ok,
} from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { EndEnrollmentInput, EnrolStudentInput, TransferStudentInput, TransferStudentResult } from '../contract.js';
import type { SectionEnrollment, SectionEnrollmentStatus, SectionStudent } from '../domain/types.js';
import { toSectionEnrollment } from '../infrastructure/mappers.js';
import { sectionEnrollmentTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/** The calendar day before `date` - used to end-date a transferred-out enrollment so the old and new section never overlap on the same day. */
function dayBefore(date: DateOnly): DateOnly {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(year, month - 1, day);
  shifted.setDate(shifted.getDate() - 1);
  return formatDateOnly(shifted);
}

/**
 * Row shape of `listStudentsInSection`'s raw join query. A `type` alias
 * (object type literal), not an `interface` - `db.execute<T>`'s generic
 * constraint needs `T`'s implicit index signature, which TypeScript only
 * infers for a fresh object type literal, never for a named `interface`
 * declaration (same reason every other raw-SQL row shape in this codebase,
 * e.g. `@sms/access`'s `allCampusIds`, is written as `{ id: string }` inline
 * rather than as an interface).
 */
type RosterRow = {
  readonly enrollment_id: string;
  readonly person_id: string;
  readonly given_name: string;
  readonly family_name: string;
  readonly valid_from: string;
  readonly valid_to: string | null;
  readonly status: string;
};

@Injectable()
export class SectionEnrollmentService {
  /**
   * `section_enrollment_no_overlap` (see the `0600` migration) rejects an
   * overlapping enrollment of the SAME (section, person), surfacing as a
   * `ConflictError` via `toDomainError`. Writes are additionally gated by
   * `tenancy.assert_year_writable` in the database, resolved via
   * `section_id -> section.term_id -> term.academic_year_id`.
   */
  async enrolStudent(tenantId: TenantId, input: EnrolStudentInput): Promise<Result<SectionEnrollment, DomainError>> {
    const ctx = scopedContext(tenantId);
    const validFrom = input.validFrom ?? todayDateOnly();
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(sectionEnrollmentTable)
          .values({
            id: newId(),
            tenantId,
            sectionId: input.sectionId,
            personId: input.personId,
            validFrom,
            status: 'active',
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toSectionEnrollment(row));
    } catch (error) {
      return err(toDomainError(error, 'Could not enrol student.') as DomainError);
    }
  }

  /** Ends the currently-effective enrollment as of `asOf` (default today) by setting `valid_to`, never deleting the row. */
  async endEnrollment(tenantId: TenantId, input: EndEnrollmentInput): Promise<Result<void, DomainError>> {
    const ctx = scopedContext(tenantId);
    const asOf = input.asOf ?? todayDateOnly();

    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(sectionEnrollmentTable)
          .set({ validTo: asOf, status: input.status ?? 'withdrawn' })
          .where(
            and(
              eq(sectionEnrollmentTable.tenantId, tenantId),
              eq(sectionEnrollmentTable.sectionId, input.sectionId),
              eq(sectionEnrollmentTable.personId, input.personId),
              isNull(sectionEnrollmentTable.validTo),
            ),
          )
          .returning(),
      );
      if (rows.length === 0) {
        return err(new NotFoundError(`No open enrollment for section ${input.sectionId}, person ${input.personId}.`));
      }
      return ok(undefined);
    } catch (error) {
      return err(toDomainError(error, 'Could not end enrollment.') as DomainError);
    }
  }

  /**
   * Ends the student's OPEN enrollment in `fromSectionId` the day before
   * `effectiveFrom` and creates a new one in `toSectionId` starting
   * `effectiveFrom`, in a SINGLE `withTenantTx` - both writes commit
   * together or not at all, so a mid-transfer failure can never leave a
   * student enrolled nowhere (or, worse, in both sections at once). The old
   * row is end-dated, never deleted: last term's gradebook must not change
   * when a student later moves (see the `0600` migration header).
   */
  async transferStudent(tenantId: TenantId, input: TransferStudentInput): Promise<Result<TransferStudentResult, DomainError>> {
    const ctx = scopedContext(tenantId);
    const effectiveFrom = input.effectiveFrom ?? todayDateOnly();
    const endOldOn = dayBefore(effectiveFrom);

    try {
      const result = await withTenantTx(ctx, async (db) => {
        const endedRows = await db
          .update(sectionEnrollmentTable)
          .set({ validTo: endOldOn, status: 'transferred' })
          .where(
            and(
              eq(sectionEnrollmentTable.tenantId, tenantId),
              eq(sectionEnrollmentTable.sectionId, input.fromSectionId),
              eq(sectionEnrollmentTable.personId, input.personId),
              isNull(sectionEnrollmentTable.validTo),
            ),
          )
          .returning();
        const endedRow = endedRows[0];
        if (!endedRow) {
          throw new NotFoundError(`No open enrollment for person ${input.personId} in section ${input.fromSectionId}.`);
        }

        const createdRows = await db
          .insert(sectionEnrollmentTable)
          .values({
            id: newId(),
            tenantId,
            sectionId: input.toSectionId,
            personId: input.personId,
            validFrom: effectiveFrom,
            status: 'active',
          })
          .returning();
        const createdRow = createdRows[0];
        if (!createdRow) {
          throw new ConflictError('Transfer insert returned no row.');
        }

        return { endedEnrollment: toSectionEnrollment(endedRow), newEnrollment: toSectionEnrollment(createdRow) };
      });
      return ok(result);
    } catch (error) {
      return err(toDomainError(error, 'Could not transfer student.') as DomainError);
    }
  }

  /** Students currently enrolled in `sectionId` (or as of `asOf`), enriched with name fields from `people.person`. */
  async listStudentsInSection(tenantId: TenantId, sectionId: string, asOf?: DateOnly): Promise<SectionStudent[]> {
    const ctx = scopedContext(tenantId);
    const resolveDate = asOf ?? todayDateOnly();

    // Joins to people.person by raw SQL rather than through PeopleContract
    // (a one-record-at-a-time port, unsuited to a roster query) - same
    // precedent as @sms/access's AbilityService.allCampusIds reading
    // tenancy.campus directly: this package can only reach a sibling
    // module's PUBLIC entrypoint, never its internal schema module, but a
    // raw cross-schema SQL read is a separate, already-established escape
    // hatch (see also @sms/people's seed.ts touching identity.membership).
    const rows = await withTenantTx(ctx, (db) =>
      db.execute<RosterRow>(sql`
        select se.id as enrollment_id, se.person_id, p.given_name, p.family_name, se.valid_from, se.valid_to, se.status
        from academic.section_enrollment se
        join people.person p on p.id = se.person_id
        where se.tenant_id = ${tenantId}
          and se.section_id = ${sectionId}
          and se.valid_from <= ${resolveDate}
          and (se.valid_to is null or se.valid_to >= ${resolveDate})
        order by p.family_name, p.given_name
      `),
    );

    return (rows as unknown as RosterRow[]).map((row) => ({
      enrollmentId: row.enrollment_id,
      personId: row.person_id as PersonId,
      givenName: row.given_name,
      familyName: row.family_name,
      validFrom: row.valid_from as DateOnly,
      validTo: (row.valid_to as DateOnly | null) ?? null,
      status: row.status as SectionEnrollmentStatus,
    }));
  }

  async listByPerson(tenantId: TenantId, personId: PersonId, asOf?: DateOnly): Promise<SectionEnrollment[]> {
    const ctx = scopedContext(tenantId);
    const resolveDate = asOf ?? todayDateOnly();
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(sectionEnrollmentTable)
        .where(
          and(
            eq(sectionEnrollmentTable.tenantId, tenantId),
            eq(sectionEnrollmentTable.personId, personId),
            lte(sectionEnrollmentTable.validFrom, resolveDate),
            or(isNull(sectionEnrollmentTable.validTo), gte(sectionEnrollmentTable.validTo, resolveDate)),
          ),
        )
        .orderBy(asc(sectionEnrollmentTable.validFrom)),
    );
    return rows.map(toSectionEnrollment);
  }
}
