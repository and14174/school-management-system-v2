import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { NotFoundError, ValidationError, newId, type DomainError, type NotFoundError as NotFoundErrorType, type Result, type TenantId, type UserId, err, ok } from '@sms/kernel';
import { withTenantTx, type Tx } from '@sms/db';
import { APPROVALS_CONTRACT, type ApprovalsContract } from '@sms/approvals';
import type { IssueCreditNoteInput, SetCreditNoteApprovalPolicyInput } from '../contract.js';
import type { CreditNote, CreditNoteApprovalPolicy, CreditNoteDetail, IssueCreditNoteResult } from '../domain/types.js';
import { toCreditNote, toCreditNoteApprovalPolicy, toCreditNoteLine } from '../infrastructure/mappers.js';
import { creditNoteApprovalPolicyTable, creditNoteLineTable, creditNoteTable, invoiceLineTable, invoiceTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';
import { issueCreditNoteSchema } from './schemas.js';

type ChargesAndCreditedRow = { readonly charges_minor: string | number; readonly already_credited_minor: string | number };

/** The `requestType` this module registers with `@sms/approvals` for the credit-note pilot - see `CreditNoteApprovalHandler`. */
export const CREDIT_NOTE_APPROVAL_REQUEST_TYPE = 'billing.credit_note';

/** The `subjectType` a credit-note approval request points at (the invoice it would correct). */
export const CREDIT_NOTE_APPROVAL_SUBJECT_TYPE = 'billing.invoice';

/**
 * The ONLY way to correct an issued invoice - see the `1400` migration
 * header and rule #3 in the module brief. `issueCreditNote` never updates
 * `billing.invoice`/`billing.invoice_line` (the database refuses it
 * outright regardless); it writes a new, separate, append-only fact instead.
 *
 * Opt-in gated by `@sms/approvals` (the pilot integration - see the `1401`
 * migration header): `issueCreditNote` reads `billing.credit_note_approval_policy`
 * FIRST. With no policy for the invoice's currency, or a total under its
 * threshold, this behaves exactly as it always did - the note is validated
 * and written in one transaction, right here. Above the threshold, NOTHING
 * is written to `billing.credit_note` yet; instead a pending
 * `ApprovalsContract.requestApproval` is raised, carrying everything needed
 * to write the note later. `applyCreditNote` is the shared core both paths
 * write through - see its own comment and `CreditNoteApprovalHandler`.
 */
@Injectable()
export class CreditNoteService {
  constructor(@Inject(APPROVALS_CONTRACT) private readonly approvals: ApprovalsContract) {}

  async issueCreditNote(tenantId: TenantId, input: IssueCreditNoteInput): Promise<Result<IssueCreditNoteResult, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const amountMinor = input.lines.reduce((sum, line) => sum + line.amountMinor, 0);

      // Read-only: does a policy gate this invoice's currency, and does this
      // note's total meet it? Read inside its own transaction (no writes),
      // separately from the write below - gating never mutates anything.
      const gatingPolicy = await withTenantTx(ctx, async (db) => {
        const invoiceRows = await db.select().from(invoiceTable).where(and(eq(invoiceTable.tenantId, tenantId), eq(invoiceTable.id, input.invoiceId))).limit(1);
        const invoice = invoiceRows[0];
        if (!invoice) {
          throw new NotFoundError(`Invoice ${input.invoiceId} not found.`);
        }
        const [policyRow] = await db
          .select()
          .from(creditNoteApprovalPolicyTable)
          .where(and(eq(creditNoteApprovalPolicyTable.tenantId, tenantId), eq(creditNoteApprovalPolicyTable.currency, invoice.currency)))
          .limit(1);
        if (!policyRow || amountMinor < policyRow.thresholdMinor) {
          return null;
        }
        return policyRow;
      });

      if (!gatingPolicy) {
        const issuedByUserId = (ctx.actorUserId ?? ctx.userId ?? null) as UserId | null;
        const creditNote = await withTenantTx(ctx, (db) => this.applyCreditNote(db, tenantId, input, issuedByUserId));
        return ok({ status: 'issued', creditNote });
      }

      // Gated: hold it pending instead of writing anything to
      // billing.credit_note. The FULL input is round-tripped through
      // payload - it is opaque to @sms/approvals (see its own module
      // header) and read back verbatim by CreditNoteApprovalHandler.apply.
      const requested = await this.approvals.requestApproval({
        requestType: CREDIT_NOTE_APPROVAL_REQUEST_TYPE,
        subjectType: CREDIT_NOTE_APPROVAL_SUBJECT_TYPE,
        subjectId: input.invoiceId,
        payload: { invoiceId: input.invoiceId, reason: input.reason, lines: input.lines },
      });
      if (!requested.ok) {
        return err(requested.error);
      }
      return ok({ status: 'pending_approval', approvalRequestId: requested.value.id });
    } catch (error) {
      return err(toDomainError(error, `Could not issue a credit note for invoice ${input.invoiceId}.`) as DomainError);
    }
  }

  /**
   * The shared core: validates and writes `billing.credit_note` + every
   * `billing.credit_note_line`, INSIDE the transaction it is given - never
   * one of its own. Called two ways:
   *
   *   1. Directly from `issueCreditNote`, inside a fresh `withTenantTx`, when
   *      the note is not gated.
   *   2. From `CreditNoteApprovalHandler.apply`, inside the APPROVING
   *      DECISION'S transaction - see that class's own comment and
   *      `@sms/approvals`' `ApprovalHandler.apply` on why this must never
   *      open its own transaction: a failing write here has to roll the
   *      decision back with it.
   *
   * Re-validates against CURRENT state either way (never a stale snapshot
   * taken when a gated request was first raised) - the invoice must still be
   * `issued` and the running total (this note plus every one already issued
   * against it) must still not exceed the invoice's charges, exactly the
   * checks the original ungated `issueCreditNote` always made.
   */
  async applyCreditNote(tx: Tx, tenantId: TenantId, input: IssueCreditNoteInput, issuedByUserId: UserId | null): Promise<CreditNoteDetail> {
    const invoiceRows = await tx.select().from(invoiceTable).where(and(eq(invoiceTable.tenantId, tenantId), eq(invoiceTable.id, input.invoiceId))).limit(1);
    const invoice = invoiceRows[0];
    if (!invoice) {
      throw new NotFoundError(`Invoice ${input.invoiceId} not found.`);
    }
    if (invoice.status !== 'issued') {
      throw new ValidationError(`Invoice ${input.invoiceId} is not issued - only an issued invoice can be corrected with a credit note.`);
    }

    for (const line of input.lines) {
      if (!line.invoiceLineId) continue;
      const lineRows = await tx
        .select({ id: invoiceLineTable.id })
        .from(invoiceLineTable)
        .where(and(eq(invoiceLineTable.tenantId, tenantId), eq(invoiceLineTable.id, line.invoiceLineId), eq(invoiceLineTable.invoiceId, input.invoiceId)))
        .limit(1);
      if (!lineRows[0]) {
        throw new NotFoundError(`Invoice line ${line.invoiceLineId} does not belong to invoice ${input.invoiceId}.`);
      }
    }

    // A credit note can never credit more than the invoice was ever
    // charged, across every credit note issued against it - a
    // database-level check would need a cross-row aggregate constraint
    // Postgres cannot express declaratively, so this is enforced here,
    // inside the SAME transaction as the write it guards.
    const totals = await tx.execute<ChargesAndCreditedRow>(sql`
      select
        coalesce((select sum(amount_minor) from billing.invoice_line where invoice_id = ${input.invoiceId}), 0) as charges_minor,
        coalesce(
          (select sum(cnl.amount_minor) from billing.credit_note_line cnl
             join billing.credit_note cn on cn.id = cnl.credit_note_id
           where cn.invoice_id = ${input.invoiceId}),
          0
        ) as already_credited_minor
    `);
    const totalsRow = (totals as unknown as ChargesAndCreditedRow[])[0]!;
    const chargesMinor = Number(totalsRow.charges_minor);
    const alreadyCreditedMinor = Number(totalsRow.already_credited_minor);
    const newTotal = input.lines.reduce((sum, line) => sum + line.amountMinor, 0);
    if (alreadyCreditedMinor + newTotal > chargesMinor) {
      throw new ValidationError(
        `Credit note total ${newTotal} plus already-credited ${alreadyCreditedMinor} would exceed invoice ${input.invoiceId}'s charges of ${chargesMinor}.`,
      );
    }

    const noteRows = await tx
      .insert(creditNoteTable)
      .values({
        id: newId(),
        tenantId,
        invoiceId: input.invoiceId,
        reason: input.reason,
        issuedByUserId,
      })
      .returning();
    const note = noteRows[0]!;

    const lines = [];
    for (const line of input.lines) {
      const lineRows = await tx
        .insert(creditNoteLineTable)
        .values({
          id: newId(),
          tenantId,
          creditNoteId: note.id,
          invoiceLineId: line.invoiceLineId ?? null,
          description: line.description,
          amountMinor: line.amountMinor,
        })
        .returning();
      lines.push(lineRows[0]!);
    }

    return { ...toCreditNote(note), lines: lines.map(toCreditNoteLine) };
  }

  /**
   * Reconstructs an `IssueCreditNoteInput` from an approval request's
   * `payload` - the exact shape `issueCreditNote` wrote it in, validated
   * again with the same zod schema the REST boundary uses (never trust a
   * JSONB blob is still shaped as expected without checking).
   */
  static payloadToInput(payload: Record<string, unknown>): IssueCreditNoteInput {
    return issueCreditNoteSchema.parse(payload);
  }

  async getCreditNote(tenantId: TenantId, id: string): Promise<Result<CreditNoteDetail, NotFoundErrorType>> {
    const ctx = scopedContext(tenantId);
    const noteRows = await withTenantTx(ctx, (db) => db.select().from(creditNoteTable).where(and(eq(creditNoteTable.tenantId, tenantId), eq(creditNoteTable.id, id))).limit(1));
    const note = noteRows[0];
    if (!note) {
      return err(new NotFoundError(`Credit note ${id} not found.`));
    }
    const lineRows = await withTenantTx(ctx, (db) =>
      db.select().from(creditNoteLineTable).where(and(eq(creditNoteLineTable.tenantId, tenantId), eq(creditNoteLineTable.creditNoteId, id))),
    );
    return ok({ ...toCreditNote(note), lines: lineRows.map(toCreditNoteLine) });
  }

  async listCreditNotes(tenantId: TenantId, invoiceId: string): Promise<CreditNote[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(creditNoteTable).where(and(eq(creditNoteTable.tenantId, tenantId), eq(creditNoteTable.invoiceId, invoiceId))),
    );
    return rows.map(toCreditNote);
  }

  async setApprovalPolicy(tenantId: TenantId, input: SetCreditNoteApprovalPolicyInput): Promise<Result<CreditNoteApprovalPolicy, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const [row] = await withTenantTx(ctx, (db) =>
        db
          .insert(creditNoteApprovalPolicyTable)
          .values({
            id: newId(),
            tenantId,
            currency: input.currency,
            thresholdMinor: input.thresholdMinor,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [creditNoteApprovalPolicyTable.tenantId, creditNoteApprovalPolicyTable.currency],
            set: { thresholdMinor: input.thresholdMinor, updatedAt: new Date() },
          })
          .returning(),
      );
      if (!row) throw new Error('billing.credit_note_approval_policy upsert returned no row.');
      return ok(toCreditNoteApprovalPolicy(row));
    } catch (error) {
      return err(toDomainError(error, `Could not save a credit-note approval policy for "${input.currency}".`) as DomainError);
    }
  }

  async listApprovalPolicies(tenantId: TenantId): Promise<CreditNoteApprovalPolicy[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) => db.select().from(creditNoteApprovalPolicyTable).where(eq(creditNoteApprovalPolicyTable.tenantId, tenantId)));
    return rows.map(toCreditNoteApprovalPolicy);
  }
}
