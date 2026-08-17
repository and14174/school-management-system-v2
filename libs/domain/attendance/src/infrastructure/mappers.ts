import type { DateOnly, PersonId, TenantId, UserId } from '@sms/kernel';
import type {
  AttendanceCategory,
  AttendanceCode,
  AttendanceCorrection,
  AttendanceRecord,
  AttendanceSubmission,
  CorrectionStatus,
} from '../domain/types.js';
import type { codeTable, correctionTable, recordTable, submissionTable } from './schema.js';

type CodeRow = typeof codeTable.$inferSelect;
type RecordRow = typeof recordTable.$inferSelect;
type CorrectionRow = typeof correctionTable.$inferSelect;
type SubmissionRow = typeof submissionTable.$inferSelect;

export function toCode(row: CodeRow): AttendanceCode {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    code: row.code,
    label: row.label,
    category: row.category as AttendanceCategory,
    countsAsPresent: row.countsAsPresent,
    isDefault: row.isDefault,
    requiresReason: row.requiresReason,
    sequence: row.sequence,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toRecord(row: RecordRow): AttendanceRecord {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    personId: row.personId as PersonId,
    sectionId: row.sectionId,
    sectionMeetingId: row.sectionMeetingId,
    date: row.date as DateOnly,
    codeId: row.codeId,
    minutesLate: row.minutesLate,
    note: row.note,
    markedByUserId: (row.markedByUserId as UserId | null) ?? null,
    markedAt: row.markedAt,
  };
}

export function toCorrection(row: CorrectionRow): AttendanceCorrection {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    recordId: row.recordId,
    fromCodeId: row.fromCodeId,
    toCodeId: row.toCodeId,
    reason: row.reason,
    requestedByUserId: (row.requestedByUserId as UserId | null) ?? null,
    status: row.status as CorrectionStatus,
    decidedByUserId: (row.decidedByUserId as UserId | null) ?? null,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
  };
}

export function toSubmission(row: SubmissionRow): AttendanceSubmission {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    idempotencyKey: row.idempotencyKey,
    sectionMeetingId: row.sectionMeetingId,
    date: row.date as DateOnly,
    submittedByUserId: (row.submittedByUserId as UserId | null) ?? null,
    recordCount: row.recordCount,
    createdAt: row.createdAt,
  };
}
