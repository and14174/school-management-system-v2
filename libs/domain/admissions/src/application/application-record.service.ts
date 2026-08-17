import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, ilike, or } from 'drizzle-orm';
import { NotFoundError, ValidationError, newId, todayDateOnly, type DomainError, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import { OUTBOX_CONTRACT, type OutboxContract } from '@sms/outbox';
import type { ListApplicationsInput, MoveStageInput, SubmitApplicationInput } from '../contract.js';
import { isLegalStageMove, type Application, type ApplicationDecision, type ApplicationPage, type ApplicationStage, type ApplicationStageEvent } from '../domain/types.js';
import { toApplication, toDecision, toStageEvent } from '../infrastructure/mappers.js';
import { applicationDecisionTable, applicationStageHistoryTable, applicationTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/**
 * Creation, clerical pipeline progression, and every read - the `:write`/
 * `:read`-gated half of this module. `:decide`-gated writes (offer/accept/
 * reject/withdraw and the accept -> enrolment handoff) live in
 * `DecisionService` instead - see the module contract's own comment for why
 * the split.
 */
@Injectable()
export class ApplicationRecordService {
  constructor(@Inject(OUTBOX_CONTRACT) private readonly outbox: OutboxContract) {}

  /**
   * Creates a new `enquiry`-stage application and writes its opening
   * `ApplicationStageEvent` (`fromStage: null`) and the
   * `admissions.application_submitted` outbox event in the SAME transaction -
   * never a fire-and-forget call after commit, per `@sms/outbox`'s
   * `OutboxContract.publish` doc comment.
   *
   * Requires an ambient tenant context (`OutboxContract.publish` reads it via
   * `requireContext()`) - a real HTTP request already runs inside one
   * (`TenantContextInterceptor`); a test or seed script calling this directly
   * must wrap the call in `runWithContext`.
   */
  async submitApplication(tenantId: TenantId, input: SubmitApplicationInput): Promise<Result<Application, DomainError>> {
    const ctx = scopedContext(tenantId);

    try {
      const row = await withTenantTx(ctx, async (db) => {
        const rows = await db
          .insert(applicationTable)
          .values({
            id: newId(),
            tenantId,
            personId: input.personId ?? null,
            applicantGivenName: input.applicantGivenName,
            applicantFamilyName: input.applicantFamilyName,
            applicantDateOfBirth: input.applicantDateOfBirth ?? null,
            applicantGender: input.applicantGender ?? null,
            guardianName: input.guardianName ?? null,
            guardianEmail: input.guardianEmail ?? null,
            guardianPhone: input.guardianPhone ?? null,
            desiredAcademicYearId: input.desiredAcademicYearId,
            desiredCampusId: input.desiredCampusId,
            desiredGradeLevelId: input.desiredGradeLevelId,
            source: input.source ?? null,
            currentStage: 'enquiry',
          })
          .returning();
        const inserted = rows[0];
        if (!inserted) {
          throw new NotFoundError('Insert returned no row.');
        }

        await db.insert(applicationStageHistoryTable).values({
          id: newId(),
          tenantId,
          applicationId: inserted.id,
          fromStage: null,
          toStage: 'enquiry',
          note: 'Application submitted',
          actorUserId: ctx.actorUserId ?? ctx.userId ?? null,
          occurredOn: todayDateOnly(),
        });

        await this.outbox.publish(db, {
          topic: 'admissions.application_submitted',
          payload: {
            applicationId: inserted.id,
            applicantGivenName: inserted.applicantGivenName,
            applicantFamilyName: inserted.applicantFamilyName,
            desiredAcademicYearId: inserted.desiredAcademicYearId,
            desiredCampusId: inserted.desiredCampusId,
            desiredGradeLevelId: inserted.desiredGradeLevelId,
          },
        });

        return inserted;
      });
      return ok(toApplication(row));
    } catch (error) {
      return err(toDomainError(error, 'Could not submit application.') as DomainError);
    }
  }

  /**
   * Clerical pipeline progression only (`enquiry -> applied -> assessment`) -
   * validates the move is legal (see `isLegalStageMove`), then appends an
   * `ApplicationStageEvent` and updates the application's denormalised
   * `currentStage` in the SAME transaction - the history is never
   * overwritten, only appended to.
   */
  async moveStage(tenantId: TenantId, input: MoveStageInput): Promise<Result<Application, DomainError>> {
    const ctx = scopedContext(tenantId);

    try {
      return await withTenantTx(ctx, async (db) => {
        const rows = await db
          .select()
          .from(applicationTable)
          .where(and(eq(applicationTable.tenantId, tenantId), eq(applicationTable.id, input.applicationId)))
          .limit(1);
        const current = rows[0];
        if (!current) {
          return err(new NotFoundError(`Application ${input.applicationId} not found.`));
        }

        const fromStage = current.currentStage as ApplicationStage;
        if (!isLegalStageMove(fromStage, input.toStage)) {
          return err(new ValidationError(`Cannot move application ${input.applicationId} from "${fromStage}" to "${input.toStage}".`));
        }

        const updatedRows = await db
          .update(applicationTable)
          .set({ currentStage: input.toStage })
          .where(and(eq(applicationTable.tenantId, tenantId), eq(applicationTable.id, input.applicationId)))
          .returning();
        const updated = updatedRows[0];
        if (!updated) {
          return err(new NotFoundError(`Application ${input.applicationId} not found.`));
        }

        await db.insert(applicationStageHistoryTable).values({
          id: newId(),
          tenantId,
          applicationId: input.applicationId,
          fromStage,
          toStage: input.toStage,
          note: input.note ?? null,
          actorUserId: ctx.actorUserId ?? ctx.userId ?? null,
          occurredOn: input.occurredOn ?? todayDateOnly(),
        });

        return ok(toApplication(updated));
      });
    } catch (error) {
      return err(toDomainError(error, `Could not move application ${input.applicationId}.`) as DomainError);
    }
  }

  async getApplication(tenantId: TenantId, id: string): Promise<Result<Application, NotFoundError>> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(applicationTable).where(and(eq(applicationTable.tenantId, tenantId), eq(applicationTable.id, id))).limit(1),
    );
    const row = rows[0];
    return row ? ok(toApplication(row)) : err(new NotFoundError(`Application ${id} not found.`));
  }

  /** Keyset-paginated (cursor = last-seen `id`, ascending - `id`s are UUIDv7 so this is creation order). */
  async listApplications(tenantId: TenantId, input: ListApplicationsInput): Promise<ApplicationPage> {
    const ctx = scopedContext(tenantId);
    const limit = input.limit && input.limit > 0 ? Math.min(input.limit, MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT;

    const conditions = [eq(applicationTable.tenantId, tenantId)];
    if (input.stage) {
      conditions.push(eq(applicationTable.currentStage, input.stage));
    }
    if (input.campusId) {
      conditions.push(eq(applicationTable.desiredCampusId, input.campusId));
    }
    if (input.academicYearId) {
      conditions.push(eq(applicationTable.desiredAcademicYearId, input.academicYearId));
    }
    if (input.cursor) {
      conditions.push(gt(applicationTable.id, input.cursor));
    }
    if (input.query) {
      const pattern = `%${input.query.trim()}%`;
      conditions.push(
        or(ilike(applicationTable.applicantGivenName, pattern), ilike(applicationTable.applicantFamilyName, pattern))!,
      );
    }

    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(applicationTable)
        .where(and(...conditions))
        .orderBy(asc(applicationTable.id))
        .limit(limit + 1),
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

    return { items: page.map(toApplication), nextCursor };
  }

  /** Every `ApplicationStageEvent` for `applicationId`, oldest first - the full, unedited clerical trail (append-only in the database, see the `1500` migration). */
  async getStageHistory(tenantId: TenantId, applicationId: string): Promise<ApplicationStageEvent[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(applicationStageHistoryTable)
        .where(and(eq(applicationStageHistoryTable.tenantId, tenantId), eq(applicationStageHistoryTable.applicationId, applicationId)))
        .orderBy(asc(applicationStageHistoryTable.createdAt)),
    );
    return rows.map(toStageEvent);
  }

  /** Every `ApplicationDecision` for `applicationId`, oldest first - the full, unedited decision trail (append-only in the database, see the `1500` migration). A plain read - gated on `admissions.application:read` at the controller, not `:decide`. */
  async getDecisionHistory(tenantId: TenantId, applicationId: string): Promise<ApplicationDecision[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(applicationDecisionTable)
        .where(and(eq(applicationDecisionTable.tenantId, tenantId), eq(applicationDecisionTable.applicationId, applicationId)))
        .orderBy(asc(applicationDecisionTable.createdAt)),
    );
    return rows.map(toDecision);
  }

  /** Most recent decision for `applicationId` matching `outcome`, or `null`. Used by `DecisionService`'s idempotent-accept replay path - see its own comment. */
  async getLastDecisionByOutcome(tenantId: TenantId, applicationId: string, outcome: string): Promise<ApplicationDecision | null> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(applicationDecisionTable)
        .where(
          and(
            eq(applicationDecisionTable.tenantId, tenantId),
            eq(applicationDecisionTable.applicationId, applicationId),
            eq(applicationDecisionTable.outcome, outcome),
          ),
        )
        .orderBy(desc(applicationDecisionTable.createdAt))
        .limit(1),
    );
    const row = rows[0];
    return row ? toDecision(row) : null;
  }
}
