import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  NotFoundError,
  ValidationError,
  newId,
  todayDateOnly,
  type AcademicYearId,
  type CampusId,
  type DateOnly,
  type DomainError,
  type PersonId,
  type Result,
  type TenantId,
  err,
  ok,
} from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import { OUTBOX_CONTRACT, type OutboxContract } from '@sms/outbox';
import { PEOPLE_CONTRACT, type PeopleContract } from '@sms/people';
import { ENROLLMENT_CONTRACT, type EnrollmentContract } from '@sms/enrollment';
import type { RecordDecisionInput, RecordDecisionResult } from '../contract.js';
import { isLegalDecision, type Application, type ApplicationStage, type ConversionOutcome } from '../domain/types.js';
import { toApplication, toDecision } from '../infrastructure/mappers.js';
import { applicationDecisionTable, applicationTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * The `admissions.application:decide`-gated half of this module: recording a
 * consequential outcome (offered/accepted/rejected/withdrawn), and - only for
 * `accepted` - handing the applicant to `@sms/enrollment`.
 *
 * Reaches `@sms/people`/`@sms/enrollment` through their PUBLIC CONTRACTS
 * (`PEOPLE_CONTRACT`/`ENROLLMENT_CONTRACT`), never this module's own tables
 * directly - both are `type:domain`, so importing a sibling's published
 * contract is the established pattern (`@sms/attendance` reaches
 * `@sms/academic`/`@sms/people` the same way; `@sms/records`' `ReportCardService`
 * is the closest precedent for injecting TWO sibling contracts like this).
 */
@Injectable()
export class DecisionService {
  constructor(
    @Inject(OUTBOX_CONTRACT) private readonly outbox: OutboxContract,
    @Inject(PEOPLE_CONTRACT) private readonly people: PeopleContract,
    @Inject(ENROLLMENT_CONTRACT) private readonly enrollment: EnrollmentContract,
  ) {}

  /**
   * Validates the decision is legal (see `isLegalDecision`), then appends an
   * `ApplicationDecision` and updates `currentStage` in the SAME transaction,
   * publishing `admissions.decision_recorded` through `OutboxContract.publish`
   * in that same transaction too - never a fire-and-forget call after commit.
   *
   * `outcome === 'accepted'` gets special, IDEMPOTENT handling: if the
   * application is ALREADY `accepted` (a double-clicked/retried accept
   * call), no new decision row is written - the most recent `accepted`
   * decision is returned instead - and `ensureConverted` below is what makes
   * the enrolment/person side of it idempotent too. Every other outcome, and
   * every OTHER attempt to decide an application already in a terminal
   * stage, is rejected as an illegal transition (see `isLegalDecision`) -
   * this idempotent-replay carve-out exists ONLY for `accepted`, because
   * that is the one outcome with real side effects (creating a person and an
   * enrolment) that must never happen twice.
   */
  async recordDecision(tenantId: TenantId, input: RecordDecisionInput): Promise<Result<RecordDecisionResult, DomainError>> {
    const ctx = scopedContext(tenantId);

    try {
      const stageResult = await withTenantTx(ctx, async (db) => {
        const rows = await db
          .select()
          .from(applicationTable)
          .where(and(eq(applicationTable.tenantId, tenantId), eq(applicationTable.id, input.applicationId)))
          .for('update');
        const current = rows[0];
        if (!current) {
          return err(new NotFoundError(`Application ${input.applicationId} not found.`));
        }

        const fromStage = current.currentStage as ApplicationStage;

        if (input.outcome === 'accepted' && fromStage === 'accepted') {
          const lastAcceptedRows = await db
            .select()
            .from(applicationDecisionTable)
            .where(
              and(
                eq(applicationDecisionTable.tenantId, tenantId),
                eq(applicationDecisionTable.applicationId, input.applicationId),
                eq(applicationDecisionTable.outcome, 'accepted'),
              ),
            )
            .orderBy(desc(applicationDecisionTable.createdAt))
            .limit(1);
          const lastAccepted = lastAcceptedRows[0];
          if (!lastAccepted) {
            // Should be unreachable: currentStage is only ever set to
            // 'accepted' by this same method inserting an 'accepted' row
            // first. Surfacing loudly rather than silently fabricating one.
            return err(new NotFoundError(`Application ${input.applicationId} is "accepted" but has no accepted decision row.`));
          }
          return ok({ application: toApplication(current), decision: toDecision(lastAccepted), isReplay: true });
        }

        if (!isLegalDecision(fromStage, input.outcome)) {
          return err(
            new ValidationError(`Cannot record decision "${input.outcome}" for application ${input.applicationId} in stage "${fromStage}".`),
          );
        }

        const decidedOn = input.decidedOn ?? todayDateOnly();
        const decisionRows = await db
          .insert(applicationDecisionTable)
          .values({
            id: newId(),
            tenantId,
            applicationId: input.applicationId,
            fromStage,
            outcome: input.outcome,
            reason: input.reason ?? null,
            decidedByUserId: ctx.actorUserId ?? ctx.userId ?? null,
            decidedOn,
          })
          .returning();
        const insertedDecision = decisionRows[0];
        if (!insertedDecision) {
          throw new NotFoundError('Insert returned no row.');
        }

        const updatedRows = await db
          .update(applicationTable)
          .set({ currentStage: input.outcome })
          .where(and(eq(applicationTable.tenantId, tenantId), eq(applicationTable.id, input.applicationId)))
          .returning();
        const updated = updatedRows[0];
        if (!updated) {
          return err(new NotFoundError(`Application ${input.applicationId} not found.`));
        }

        await this.outbox.publish(db, {
          topic: 'admissions.decision_recorded',
          payload: {
            applicationId: input.applicationId,
            fromStage,
            outcome: input.outcome,
            decisionId: insertedDecision.id,
          },
        });

        return ok({ application: toApplication(updated), decision: toDecision(insertedDecision), isReplay: false });
      });

      if (!stageResult.ok) {
        return err(stageResult.error);
      }

      let conversion: ConversionOutcome | null = null;
      let application = stageResult.value.application;
      if (input.outcome === 'accepted') {
        const convertResult = await this.ensureConverted(tenantId, application);
        if (!convertResult.ok) {
          return err(convertResult.error);
        }
        conversion = convertResult.value;
        // Reflect the (possibly just-written) person_id/converted_enrollment_id
        // in the returned Application without a redundant re-select.
        application = {
          ...application,
          personId: conversion.personId ?? application.personId,
          convertedEnrollmentId: conversion.enrollmentId ?? application.convertedEnrollmentId,
          convertedAt: application.convertedAt ?? new Date(),
        };
      }

      return ok({ application, decision: stageResult.value.decision, conversion });
    } catch (error) {
      return err(toDomainError(error, `Could not record a decision for application ${input.applicationId}.`) as DomainError);
    }
  }

  /**
   * Hands an accepted applicant to `@sms/enrollment` - idempotently. See this
   * module's `1500` migration header, point 3, for the full reasoning; in
   * short:
   *
   *   1. `UPDATE admissions.application SET converted_at = now() WHERE ...
   *      AND converted_at IS NULL RETURNING *` is the check-and-claim, done
   *      as ONE atomic statement - two concurrent callers can never both
   *      claim the same application, no separate SELECT-then-INSERT race.
   *   2. If nothing was claimed (0 rows), this application was ALREADY
   *      converted by an earlier call - re-read it and return the recorded
   *      `personId`/`enrollmentId` with `alreadyConverted: true`. No new
   *      person, no new enrolment.
   *   3. Otherwise, this call won the claim: reuse `application.personId` if
   *      the family was already known (see `SubmitApplicationInput.personId`),
   *      else create one via `PEOPLE_CONTRACT.createPerson` and record it
   *      immediately; then create the enrolment via
   *      `ENROLLMENT_CONTRACT.enrolStudent` (whose own
   *      `(tenant, person, academic_year)` uniqueness is a second,
   *      independent guard) and record its id immediately. Each write-back
   *      happens as soon as its step succeeds, keeping the window between
   *      "claimed" and "fully recorded" as small as this cross-module
   *      handoff can make it.
   */
  private async ensureConverted(tenantId: TenantId, application: Application): Promise<Result<ConversionOutcome, DomainError>> {
    const ctx = scopedContext(tenantId);

    const claimRows = await withTenantTx(ctx, (db) =>
      db
        .update(applicationTable)
        .set({ convertedAt: new Date() })
        .where(and(eq(applicationTable.tenantId, tenantId), eq(applicationTable.id, application.id), isNull(applicationTable.convertedAt)))
        .returning(),
    );

    if (claimRows.length === 0) {
      const rows = await withTenantTx(ctx, (db) =>
        db.select().from(applicationTable).where(and(eq(applicationTable.tenantId, tenantId), eq(applicationTable.id, application.id))).limit(1),
      );
      const existing = rows[0];
      return ok({
        personId: (existing?.personId as PersonId | null) ?? null,
        enrollmentId: existing?.convertedEnrollmentId ?? null,
        alreadyConverted: true,
      });
    }

    const claimed = claimRows[0]!;
    let personId = claimed.personId as PersonId | null;

    if (!personId) {
      const created = await this.people.createPerson({
        givenName: claimed.applicantGivenName,
        familyName: claimed.applicantFamilyName,
        dateOfBirth: (claimed.applicantDateOfBirth as DateOnly | null) ?? null,
        gender: claimed.applicantGender ?? null,
      });
      if (!created.ok) {
        return err(created.error);
      }
      personId = created.value.id;

      await withTenantTx(ctx, (db) =>
        db.update(applicationTable).set({ personId }).where(and(eq(applicationTable.tenantId, tenantId), eq(applicationTable.id, application.id))),
      );
    }

    const enrolled = await this.enrollment.enrolStudent({
      personId,
      academicYearId: claimed.desiredAcademicYearId as AcademicYearId,
      campusId: claimed.desiredCampusId as CampusId,
      gradeLevelId: claimed.desiredGradeLevelId,
    });
    if (!enrolled.ok) {
      return err(enrolled.error);
    }

    await withTenantTx(ctx, (db) =>
      db
        .update(applicationTable)
        .set({ convertedEnrollmentId: enrolled.value.id })
        .where(and(eq(applicationTable.tenantId, tenantId), eq(applicationTable.id, application.id))),
    );

    return ok({ personId, enrollmentId: enrolled.value.id, alreadyConverted: false });
  }
}
