import type { AcademicYearId, PersonId, TenantId, UserId } from '@sms/kernel';
import type { CreditRules, CreditRuleSet, CreditRuleSetVersion, ReportCard, ReportCardRun, ReportCardRunStatus, ReportCardSnapshot, TranscriptEntry } from '../domain/types.js';
import type { creditRuleSetTable, creditRuleSetVersionTable, reportCardRunTable, reportCardTable, transcriptEntryTable } from './schema.js';

type ReportCardRunRow = typeof reportCardRunTable.$inferSelect;
type ReportCardRow = typeof reportCardTable.$inferSelect;
type TranscriptEntryRow = typeof transcriptEntryTable.$inferSelect;
type CreditRuleSetRow = typeof creditRuleSetTable.$inferSelect;
type CreditRuleSetVersionRow = typeof creditRuleSetVersionTable.$inferSelect;

export function toReportCardRun(row: ReportCardRunRow): ReportCardRun {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    gradingPeriodId: row.gradingPeriodId,
    sectionId: row.sectionId,
    idempotencyKey: row.idempotencyKey,
    status: row.status as ReportCardRunStatus,
    issuedAt: row.issuedAt,
    issuedByUserId: (row.issuedByUserId as UserId | null) ?? null,
    documentCount: row.documentCount,
    bulkOperationId: row.bulkOperationId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toReportCard(row: ReportCardRow): ReportCard {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    reportCardRunId: row.reportCardRunId,
    personId: row.personId as PersonId,
    enrollmentId: row.enrollmentId,
    documentId: row.documentId,
    snapshot: row.snapshot as ReportCardSnapshot,
    gpa: row.gpa,
    createdAt: row.createdAt,
  };
}

export function toTranscriptEntry(row: TranscriptEntryRow): TranscriptEntry {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    personId: row.personId as PersonId,
    academicYearId: row.academicYearId as AcademicYearId,
    termId: row.termId,
    courseId: row.courseId,
    sectionId: row.sectionId,
    courseCode: row.courseCode,
    courseName: row.courseName,
    creditsAttempted: row.creditsAttempted,
    creditsEarned: row.creditsEarned,
    percentage: row.percentage,
    letter: row.letter,
    gpaPoints: row.gpaPoints,
    gradeScaleVersionId: row.gradeScaleVersionId,
    finalisedAt: row.finalisedAt,
  };
}

export function toCreditRuleSet(row: CreditRuleSetRow): CreditRuleSet {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    name: row.name,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toCreditRuleSetVersion(row: CreditRuleSetVersionRow): CreditRuleSetVersion {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    creditRuleSetId: row.creditRuleSetId,
    version: row.version,
    rules: row.rules as CreditRules,
    effectiveFrom: row.effectiveFrom as CreditRuleSetVersion['effectiveFrom'],
    createdAt: row.createdAt,
  };
}
