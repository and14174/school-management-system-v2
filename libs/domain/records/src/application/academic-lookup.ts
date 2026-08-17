import { and, eq, inArray, lte, or, isNull, gte } from 'drizzle-orm';
import { withTenantTx } from '@sms/db';
import type { AcademicYearId, DateOnly, PersonId, TenantContext, TenantId } from '@sms/kernel';
import { assignmentRef, academicYearRef, courseRef, enrollmentRef, gradingPeriodRef, sectionEnrollmentRef, sectionRef, termRef } from '../infrastructure/foreign-schema.js';

/**
 * Read-only cross-schema lookups this module needs but has no
 * `@sms/academic`/`@sms/enrollment` contract method for (a single grading
 * period/term by id with its term/year names, a batch of sections' course
 * info, a person's enrolment row for a year). See
 * `infrastructure/foreign-schema.ts`'s own comment for why these go through
 * partial, read-only drizzle table refs rather than the raw `sql` tag
 * `@sms/gradebook`/`@sms/attendance` use for the same purpose.
 */

export interface GradingPeriodContext {
  readonly id: string;
  readonly name: string;
  readonly startsOn: DateOnly;
  readonly endsOn: DateOnly;
  readonly termId: string;
  readonly termName: string;
  readonly academicYearId: AcademicYearId;
  readonly academicYearName: string;
}

export async function getGradingPeriodContext(ctx: TenantContext, tenantId: TenantId, gradingPeriodId: string): Promise<GradingPeriodContext | null> {
  const rows = await withTenantTx(ctx, (db) =>
    db
      .select({
        id: gradingPeriodRef.id,
        name: gradingPeriodRef.name,
        startsOn: gradingPeriodRef.startsOn,
        endsOn: gradingPeriodRef.endsOn,
        termId: termRef.id,
        termName: termRef.name,
        academicYearId: academicYearRef.id,
        academicYearName: academicYearRef.name,
      })
      .from(gradingPeriodRef)
      .innerJoin(termRef, eq(termRef.id, gradingPeriodRef.termId))
      .innerJoin(academicYearRef, eq(academicYearRef.id, termRef.academicYearId))
      .where(and(eq(gradingPeriodRef.tenantId, tenantId), eq(gradingPeriodRef.id, gradingPeriodId)))
      .limit(1),
  );
  const row = rows[0];
  if (!row || !row.id || !row.name || !row.startsOn || !row.endsOn || !row.termId || !row.termName || !row.academicYearId || !row.academicYearName) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    startsOn: row.startsOn as DateOnly,
    endsOn: row.endsOn as DateOnly,
    termId: row.termId,
    termName: row.termName,
    academicYearId: row.academicYearId as AcademicYearId,
    academicYearName: row.academicYearName,
  };
}

/** The term's academic year, when only a `termId` (no grading period) is on hand - used by `finaliseTranscriptEntries`. */
export async function getTermAcademicYearId(ctx: TenantContext, tenantId: TenantId, termId: string): Promise<AcademicYearId | null> {
  const rows = await withTenantTx(ctx, (db) =>
    db
      .select({ academicYearId: termRef.academicYearId })
      .from(termRef)
      .where(and(eq(termRef.tenantId, tenantId), eq(termRef.id, termId)))
      .limit(1),
  );
  const row = rows[0];
  return row?.academicYearId ? (row.academicYearId as AcademicYearId) : null;
}

export interface SectionCourseInfo {
  readonly sectionId: string;
  readonly courseId: string;
  readonly courseCode: string;
  readonly courseName: string;
  readonly credits: number | null;
  readonly termId: string;
}

/** Batch course info for every section in `sectionIds` - one round trip regardless of student roster/report card size. */
export async function getSectionCourseInfoMap(ctx: TenantContext, tenantId: TenantId, sectionIds: readonly string[]): Promise<Map<string, SectionCourseInfo>> {
  if (sectionIds.length === 0) return new Map();

  const rows = await withTenantTx(ctx, (db) =>
    db
      .select({
        sectionId: sectionRef.id,
        courseId: courseRef.id,
        courseCode: courseRef.code,
        courseName: courseRef.name,
        credits: courseRef.credits,
        termId: sectionRef.termId,
      })
      .from(sectionRef)
      .innerJoin(courseRef, eq(courseRef.id, sectionRef.courseId))
      .where(and(eq(sectionRef.tenantId, tenantId), inArray(sectionRef.id, [...sectionIds]))),
  );

  const map = new Map<string, SectionCourseInfo>();
  for (const row of rows) {
    if (!row.sectionId || !row.courseId || !row.courseCode || !row.courseName || !row.termId) continue;
    map.set(row.sectionId, {
      sectionId: row.sectionId,
      courseId: row.courseId,
      courseCode: row.courseCode,
      courseName: row.courseName,
      credits: row.credits,
      termId: row.termId,
    });
  }
  return map;
}

/** The person's `enrollment.enrollment` row for this academic year, if any - `records.report_card.enrollment_id` is nullable precisely because this can legitimately come back `null` (a student with grades but no matching enrolment record). */
export async function getEnrollmentId(ctx: TenantContext, tenantId: TenantId, personId: string, academicYearId: string): Promise<string | null> {
  const rows = await withTenantTx(ctx, (db) =>
    db
      .select({ id: enrollmentRef.id })
      .from(enrollmentRef)
      .where(and(eq(enrollmentRef.tenantId, tenantId), eq(enrollmentRef.personId, personId), eq(enrollmentRef.academicYearId, academicYearId)))
      .limit(1),
  );
  return rows[0]?.id ?? null;
}

/** The person's `grade_level_id` for this academic year, if enrolled - used by `checkPromotionEligibility` to resolve a `CreditRules.gradeLevelOverrides` entry. */
export async function getEnrollmentGradeLevelId(ctx: TenantContext, tenantId: TenantId, personId: string, academicYearId: string): Promise<string | null> {
  const rows = await withTenantTx(ctx, (db) =>
    db
      .select({ gradeLevelId: enrollmentRef.gradeLevelId })
      .from(enrollmentRef)
      .where(and(eq(enrollmentRef.tenantId, tenantId), eq(enrollmentRef.personId, personId), eq(enrollmentRef.academicYearId, academicYearId)))
      .limit(1),
  );
  return rows[0]?.gradeLevelId ?? null;
}

/** Every currently-enrolled student in `sectionId` as of `asOf` - same query `@sms/gradebook`'s `ScoreService.calculateSectionGrades` uses for `academic.section_enrollment`, mirrored here for `issueReportCards`' section-scoped roster. */
export async function getSectionRoster(ctx: TenantContext, tenantId: TenantId, sectionId: string, asOf: DateOnly): Promise<PersonId[]> {
  const rows = await withTenantTx(ctx, (db) =>
    db
      .select({ personId: sectionEnrollmentRef.personId })
      .from(sectionEnrollmentRef)
      .where(
        and(
          eq(sectionEnrollmentRef.tenantId, tenantId),
          eq(sectionEnrollmentRef.sectionId, sectionId),
          lte(sectionEnrollmentRef.validFrom, asOf),
          or(isNull(sectionEnrollmentRef.validTo), gte(sectionEnrollmentRef.validTo, asOf)),
        ),
      ),
  );
  return [...new Set(rows.map((row) => row.personId).filter((id): id is string => id !== null))] as PersonId[];
}

/** Every currently-enrolled student with at least one assignment in `gradingPeriodId`, across every section - the "whole school" roster `issueReportCards` uses when no `sectionId` narrows it. */
export async function getGradingPeriodRoster(ctx: TenantContext, tenantId: TenantId, gradingPeriodId: string, asOf: DateOnly): Promise<PersonId[]> {
  const rows = await withTenantTx(ctx, (db) =>
    db
      .selectDistinct({ personId: sectionEnrollmentRef.personId })
      .from(assignmentRef)
      .innerJoin(
        sectionEnrollmentRef,
        and(eq(sectionEnrollmentRef.tenantId, assignmentRef.tenantId), eq(sectionEnrollmentRef.sectionId, assignmentRef.sectionId)),
      )
      .where(
        and(
          eq(assignmentRef.tenantId, tenantId),
          eq(assignmentRef.gradingPeriodId, gradingPeriodId),
          lte(sectionEnrollmentRef.validFrom, asOf),
          or(isNull(sectionEnrollmentRef.validTo), gte(sectionEnrollmentRef.validTo, asOf)),
        ),
      ),
  );
  return rows.map((row) => row.personId).filter((id): id is string => id !== null) as PersonId[];
}
