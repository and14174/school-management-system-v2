import { Injectable } from '@nestjs/common';
import { and, asc, eq, lte, or, isNull, gte } from 'drizzle-orm';
import {
  NotFoundError,
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
import type { AssignTeacherInput, EndTeacherAssignmentInput } from '../contract.js';
import type { Section, SectionTeacher } from '../domain/types.js';
import { toSection, toSectionTeacher } from '../infrastructure/mappers.js';
import { sectionTable, sectionTeacherTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

@Injectable()
export class SectionTeacherService {
  /**
   * `section_teacher_no_overlap` (see the `0600` migration) rejects an
   * overlapping assignment of the SAME (section, person, role), surfacing as
   * a `ConflictError` via `toDomainError` - same shape as `@sms/people`'s
   * `RoleService.assignRole`.
   */
  async assignTeacher(tenantId: TenantId, input: AssignTeacherInput): Promise<Result<SectionTeacher, DomainError>> {
    const ctx = scopedContext(tenantId);
    const validFrom = input.validFrom ?? todayDateOnly();
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(sectionTeacherTable)
          .values({
            id: newId(),
            tenantId,
            sectionId: input.sectionId,
            personId: input.personId,
            role: input.role ?? 'lead',
            validFrom,
            validTo: input.validTo ?? null,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toSectionTeacher(row));
    } catch (error) {
      return err(toDomainError(error, 'Could not assign teacher.') as DomainError);
    }
  }

  /** Ends the currently-effective assignment as of `asOf` (default today) by setting `valid_to`, never deleting the row. */
  async endTeacherAssignment(tenantId: TenantId, input: EndTeacherAssignmentInput): Promise<Result<void, DomainError>> {
    const ctx = scopedContext(tenantId);
    const asOf = input.asOf ?? todayDateOnly();

    const conditions = [
      eq(sectionTeacherTable.tenantId, tenantId),
      eq(sectionTeacherTable.sectionId, input.sectionId),
      eq(sectionTeacherTable.personId, input.personId),
    ];
    if (input.role) {
      conditions.push(eq(sectionTeacherTable.role, input.role));
    }

    try {
      const rows = await withTenantTx(ctx, (db) =>
        db.update(sectionTeacherTable).set({ validTo: asOf }).where(and(...conditions)).returning(),
      );
      if (rows.length === 0) {
        return err(new NotFoundError(`No matching teacher assignment for section ${input.sectionId}, person ${input.personId}.`));
      }
      return ok(undefined);
    } catch (error) {
      return err(toDomainError(error, 'Could not end teacher assignment.') as DomainError);
    }
  }

  /** Sections `personId` currently teaches (or as of `asOf`), via `academic.section_teacher` joined to `academic.section`. */
  async listSectionsForTeacher(tenantId: TenantId, personId: PersonId, asOf?: DateOnly): Promise<Section[]> {
    const ctx = scopedContext(tenantId);
    const resolveDate = asOf ?? todayDateOnly();
    const rows = await withTenantTx(ctx, (db) =>
      db
        .selectDistinct({ section: sectionTable })
        .from(sectionTeacherTable)
        .innerJoin(sectionTable, eq(sectionTable.id, sectionTeacherTable.sectionId))
        .where(
          and(
            eq(sectionTeacherTable.tenantId, tenantId),
            eq(sectionTeacherTable.personId, personId),
            lte(sectionTeacherTable.validFrom, resolveDate),
            or(isNull(sectionTeacherTable.validTo), gte(sectionTeacherTable.validTo, resolveDate)),
          ),
        )
        .orderBy(asc(sectionTable.code)),
    );
    return rows.map((r) => toSection(r.section));
  }

  async listTeachersForSection(tenantId: TenantId, sectionId: string, asOf?: DateOnly): Promise<SectionTeacher[]> {
    const ctx = scopedContext(tenantId);
    const resolveDate = asOf ?? todayDateOnly();
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(sectionTeacherTable)
        .where(
          and(
            eq(sectionTeacherTable.tenantId, tenantId),
            eq(sectionTeacherTable.sectionId, sectionId),
            lte(sectionTeacherTable.validFrom, resolveDate),
            or(isNull(sectionTeacherTable.validTo), gte(sectionTeacherTable.validTo, resolveDate)),
          ),
        )
        .orderBy(asc(sectionTeacherTable.role)),
    );
    return rows.map(toSectionTeacher);
  }
}
