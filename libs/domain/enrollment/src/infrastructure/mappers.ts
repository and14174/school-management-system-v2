import type { AcademicYearId, CampusId, DateOnly, PersonId, TenantId, UserId } from '@sms/kernel';
import type { Enrollment, EnrollmentStatus, RolloverRun, RolloverRunStatus, StatusEvent } from '../domain/types.js';
import type { enrollmentTable, rolloverRunTable, statusEventTable } from './schema.js';

type EnrollmentRow = typeof enrollmentTable.$inferSelect;
type StatusEventRow = typeof statusEventTable.$inferSelect;
type RolloverRunRow = typeof rolloverRunTable.$inferSelect;

export function toEnrollment(row: EnrollmentRow): Enrollment {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    personId: row.personId as PersonId,
    academicYearId: row.academicYearId as AcademicYearId,
    campusId: row.campusId as CampusId,
    gradeLevelId: row.gradeLevelId,
    studentNumber: row.studentNumber,
    status: row.status as EnrollmentStatus,
    enrolledOn: row.enrolledOn as DateOnly,
    exitedOn: (row.exitedOn as DateOnly | null) ?? null,
    exitReason: row.exitReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toStatusEvent(row: StatusEventRow): StatusEvent {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    enrollmentId: row.enrollmentId,
    fromStatus: (row.fromStatus as EnrollmentStatus | null) ?? null,
    toStatus: row.toStatus as EnrollmentStatus,
    effectiveOn: row.effectiveOn as DateOnly,
    reason: row.reason,
    actorUserId: (row.actorUserId as UserId | null) ?? null,
    createdAt: row.createdAt,
  };
}

export function toRolloverRun(row: RolloverRunRow): RolloverRun {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    fromAcademicYearId: row.fromAcademicYearId as AcademicYearId,
    toAcademicYearId: row.toAcademicYearId as AcademicYearId,
    bulkOperationId: row.bulkOperationId,
    status: row.status as RolloverRunStatus,
    counts: row.counts as Record<string, unknown>,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? null,
  };
}
