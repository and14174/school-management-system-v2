import type { AcademicYearId, CampusId, DateOnly, PersonId, TenantId, UserId } from '@sms/kernel';
import type { Application, ApplicationDecision, ApplicationStage, ApplicationStageEvent, DecisionOutcome } from '../domain/types.js';
import type { applicationDecisionTable, applicationStageHistoryTable, applicationTable } from './schema.js';

type ApplicationRow = typeof applicationTable.$inferSelect;
type StageHistoryRow = typeof applicationStageHistoryTable.$inferSelect;
type DecisionRow = typeof applicationDecisionTable.$inferSelect;

export function toApplication(row: ApplicationRow): Application {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    personId: (row.personId as PersonId | null) ?? null,
    applicantGivenName: row.applicantGivenName,
    applicantFamilyName: row.applicantFamilyName,
    applicantDateOfBirth: (row.applicantDateOfBirth as DateOnly | null) ?? null,
    applicantGender: row.applicantGender,
    guardianName: row.guardianName,
    guardianEmail: row.guardianEmail,
    guardianPhone: row.guardianPhone,
    desiredAcademicYearId: row.desiredAcademicYearId as AcademicYearId,
    desiredCampusId: row.desiredCampusId as CampusId,
    desiredGradeLevelId: row.desiredGradeLevelId,
    source: row.source,
    currentStage: row.currentStage as ApplicationStage,
    convertedAt: row.convertedAt ?? null,
    convertedEnrollmentId: row.convertedEnrollmentId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toStageEvent(row: StageHistoryRow): ApplicationStageEvent {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    applicationId: row.applicationId,
    fromStage: (row.fromStage as ApplicationStage | null) ?? null,
    toStage: row.toStage as ApplicationStage,
    note: row.note,
    actorUserId: (row.actorUserId as UserId | null) ?? null,
    occurredOn: row.occurredOn as DateOnly,
    createdAt: row.createdAt,
  };
}

export function toDecision(row: DecisionRow): ApplicationDecision {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    applicationId: row.applicationId,
    fromStage: row.fromStage as ApplicationStage,
    outcome: row.outcome as DecisionOutcome,
    reason: row.reason,
    decidedByUserId: (row.decidedByUserId as UserId | null) ?? null,
    decidedOn: row.decidedOn as DateOnly,
    createdAt: row.createdAt,
  };
}
