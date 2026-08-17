import type { AcademicYearId, CampusId, DateOnly, PersonId, TenantId, UserId } from '@sms/kernel';

/**
 * The full pipeline, in the order a "normal" application moves through it.
 * `enquiry`/`applied`/`assessment` are reached by a `moveStage` (clerical,
 * `admissions.application:write`); `offered`/`accepted`/`rejected`/
 * `withdrawn` are reached by a `recordDecision` (consequential,
 * `admissions.application:decide`) - see `STAGE_MOVE_TRANSITIONS`/
 * `DECISION_TRANSITIONS` below and this module's `1500` migration header.
 */
export type ApplicationStage = 'enquiry' | 'applied' | 'assessment' | 'offered' | 'accepted' | 'rejected' | 'withdrawn';
export const APPLICATION_STAGES: readonly ApplicationStage[] = [
  'enquiry',
  'applied',
  'assessment',
  'offered',
  'accepted',
  'rejected',
  'withdrawn',
];

/** What a decision RECORDS - a subset of `ApplicationStage`: the four consequential outcomes. */
export type DecisionOutcome = 'offered' | 'accepted' | 'rejected' | 'withdrawn';
export const DECISION_OUTCOMES: readonly DecisionOutcome[] = ['offered', 'accepted', 'rejected', 'withdrawn'];

/**
 * Clerical pipeline progression only - `admissions.application:write`-gated
 * (see `ApplicationRecordService.moveStage`). "Recording an applicant's
 * details is clerical work" (module brief) - nothing here is a judgment call,
 * so it never reaches a decision outcome directly; `assessment` is as far as
 * a stage move goes; a `RecordDecisionInput` is what takes it further.
 */
const STAGE_MOVE_TRANSITIONS: Record<ApplicationStage, ReadonlySet<ApplicationStage>> = {
  enquiry: new Set<ApplicationStage>(['applied']),
  applied: new Set<ApplicationStage>(['assessment']),
  assessment: new Set<ApplicationStage>([]),
  offered: new Set<ApplicationStage>([]),
  accepted: new Set<ApplicationStage>([]),
  rejected: new Set<ApplicationStage>([]),
  withdrawn: new Set<ApplicationStage>([]),
};

/** Whether `from -> to` is a legal CLERICAL stage move - see `STAGE_MOVE_TRANSITIONS`' own comment. */
export function isLegalStageMove(from: ApplicationStage, to: ApplicationStage): boolean {
  return STAGE_MOVE_TRANSITIONS[from].has(to);
}

/**
 * Consequential moves - `admissions.application:decide`-gated (see
 * `DecisionService.recordDecision`). "Making an offer is not [clerical]"
 * (module brief). `accepted -> withdrawn` is the one legal REVERSAL edge (a
 * family declines an offer they already accepted, or the school rescinds) -
 * it is recorded as a brand-new `application_decision` row, never an edit of
 * the `accepted` row (see this module's `1500` migration header). `rejected`
 * and `withdrawn` are fully terminal: no legal decision moves them anywhere.
 */
const DECISION_TRANSITIONS: Record<ApplicationStage, ReadonlySet<DecisionOutcome>> = {
  enquiry: new Set<DecisionOutcome>(['withdrawn']),
  applied: new Set<DecisionOutcome>(['withdrawn']),
  assessment: new Set<DecisionOutcome>(['offered', 'rejected', 'withdrawn']),
  offered: new Set<DecisionOutcome>(['accepted', 'rejected', 'withdrawn']),
  accepted: new Set<DecisionOutcome>(['withdrawn']),
  rejected: new Set<DecisionOutcome>([]),
  withdrawn: new Set<DecisionOutcome>([]),
};

/** Whether `from -> outcome` is a legal decision - see `DECISION_TRANSITIONS`' own comment. */
export function isLegalDecision(from: ApplicationStage, outcome: DecisionOutcome): boolean {
  return DECISION_TRANSITIONS[from].has(outcome);
}

/**
 * Mirrors `admissions.application`. One row per applicant enquiry/
 * application - the applicant's OWN details, never a `people.person` (see
 * this module's `1500` migration header, point 1). `currentStage` is
 * denormalised from the newest `ApplicationStageEvent`/`ApplicationDecision`
 * for this application - never written on its own.
 */
export interface Application {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly personId: PersonId | null;
  readonly applicantGivenName: string;
  readonly applicantFamilyName: string;
  readonly applicantDateOfBirth: DateOnly | null;
  readonly applicantGender: string | null;
  readonly guardianName: string | null;
  readonly guardianEmail: string | null;
  readonly guardianPhone: string | null;
  readonly desiredAcademicYearId: AcademicYearId;
  readonly desiredCampusId: CampusId;
  readonly desiredGradeLevelId: string;
  readonly source: string | null;
  readonly currentStage: ApplicationStage;
  readonly convertedAt: Date | null;
  readonly convertedEnrollmentId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `admissions.application_stage_history` - the append-only clerical pipeline trail. `fromStage: null` marks the very first event (application submission). */
export interface ApplicationStageEvent {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly applicationId: string;
  readonly fromStage: ApplicationStage | null;
  readonly toStage: ApplicationStage;
  readonly note: string | null;
  readonly actorUserId: UserId | null;
  readonly occurredOn: DateOnly;
  readonly createdAt: Date;
}

/** Mirrors `admissions.application_decision` - the append-only decision trail: who decided what, when, and why. */
export interface ApplicationDecision {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly applicationId: string;
  readonly fromStage: ApplicationStage;
  readonly outcome: DecisionOutcome;
  readonly reason: string | null;
  readonly decidedByUserId: UserId | null;
  readonly decidedOn: DateOnly;
  readonly createdAt: Date;
}

/**
 * What `recordDecision(outcome: 'accepted')` did (or found already done) to
 * hand the applicant to `@sms/enrollment` - see `DecisionService.
 * ensureConverted`. `null` for every other outcome (offered/rejected/
 * withdrawn never convert anything).
 */
export interface ConversionOutcome {
  readonly personId: PersonId | null;
  readonly enrollmentId: string | null;
  /** `true` when this call found the application ALREADY converted (a retried/double-clicked accept) and performed no new writes - see the `1500` migration header, point 3. */
  readonly alreadyConverted: boolean;
}

export interface ApplicationPage {
  readonly items: readonly Application[];
  readonly nextCursor: string | null;
}
