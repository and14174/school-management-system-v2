import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  NotFoundError,
  ValidationError,
  newId,
  type DomainError,
  type NotFoundError as NotFoundErrorType,
  type PersonId,
  type Result,
  type TenantId,
  err,
  ok,
} from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import { OUTBOX_CONTRACT, type OutboxContract } from '@sms/outbox';
import type { ListPaymentsInput, RecordPaymentInput, RecordPaymentResult } from '../contract.js';
import type { PayerCredit, Payment } from '../domain/types.js';
import { toPayment, toPaymentAllocation } from '../infrastructure/mappers.js';
import { invoiceTable, paymentAllocationTable, paymentTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

type PayerCreditRow = {
  readonly currency: string;
  readonly total_paid_minor: string | number;
  readonly total_allocated_minor: string | number;
};

/**
 * Recording money received. `recordPayment` is the one place in this module
 * where the idempotency discipline documented in `docs/decisions.md`'s "A
 * dedupe key must guard a write that is already atomic" matters most: a
 * payment gateway or an impatient bursar WILL retry, and a payment that gets
 * credited twice is not a cosmetic bug. Same idiom as `@sms/notifications`'
 * `notify()` - `INSERT ... ON CONFLICT (tenant_id, idempotency_key) DO
 * NOTHING`, with the payment row and every `payment_allocation` row it
 * produces written in ONE transaction, so a crash between them can never
 * leave a payment that "exists" but was never actually allocated.
 */
@Injectable()
export class PaymentService {
  constructor(@Inject(OUTBOX_CONTRACT) private readonly outbox: OutboxContract) {}

  async recordPayment(tenantId: TenantId, input: RecordPaymentInput): Promise<Result<RecordPaymentResult, DomainError>> {
    const ctx = scopedContext(tenantId);
    if (!input.idempotencyKey.trim()) {
      return err(new ValidationError('recordPayment() requires a non-empty idempotencyKey.'));
    }
    const allocatedTotal = input.allocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
    if (allocatedTotal > input.amountMinor) {
      return err(
        new ValidationError(
          `Allocations total ${allocatedTotal} exceeds the payment amount ${input.amountMinor} - the unallocated remainder is credit, never a deficit to make up.`,
        ),
      );
    }

    try {
      // ---------------------------------------------------------------------
      // Idempotency: INSERT ... ON CONFLICT (tenant_id, idempotency_key) DO
      // NOTHING. A returned row means this is genuinely the first time this
      // key has been seen - only then are allocations written and the
      // outbox event published. The payment row and EVERY allocation row are
      // written in this SAME transaction: if any allocation fails validation
      // (an unissued invoice, a currency mismatch), the whole transaction -
      // including the payment insert - rolls back, so a retry with the same
      // key tries again cleanly rather than finding a half-written payment.
      // ---------------------------------------------------------------------
      const created = await withTenantTx(ctx, async (db) => {
        const insertedRows = await db
          .insert(paymentTable)
          .values({
            id: newId(),
            tenantId,
            payerPersonId: input.payerPersonId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            method: input.method ?? 'other',
            idempotencyKey: input.idempotencyKey,
            recordedByUserId: ctx.actorUserId ?? ctx.userId ?? null,
          })
          .onConflictDoNothing()
          .returning();

        const paymentRow = insertedRows[0];
        if (!paymentRow) {
          return null;
        }

        const allocationRows = [];
        for (const allocation of input.allocations) {
          const invoiceRows = await db
            .select()
            .from(invoiceTable)
            .where(and(eq(invoiceTable.tenantId, tenantId), eq(invoiceTable.id, allocation.invoiceId)))
            .limit(1);
          const invoice = invoiceRows[0];
          if (!invoice) {
            throw new NotFoundError(`Invoice ${allocation.invoiceId} not found.`);
          }
          if (invoice.status !== 'issued') {
            throw new ValidationError(`Invoice ${allocation.invoiceId} is not issued - a payment can only be allocated to an issued invoice.`);
          }
          if (invoice.currency !== input.currency) {
            throw new ValidationError(`Invoice ${allocation.invoiceId} is billed in ${invoice.currency}, not the payment's ${input.currency}.`);
          }

          const rows = await db
            .insert(paymentAllocationTable)
            .values({
              id: newId(),
              tenantId,
              paymentId: paymentRow.id,
              invoiceId: allocation.invoiceId,
              amountMinor: allocation.amountMinor,
            })
            .returning();
          allocationRows.push(rows[0]!);
        }

        // Same transaction as the payment/allocation writes above - never a
        // fire-and-forget call after commit (OutboxContract.publish's own
        // doc comment), and only reached on the FIRST write of this key -
        // a replay below never republishes the event.
        await this.outbox.publish(db, {
          topic: 'billing.payment_recorded',
          payload: {
            paymentId: paymentRow.id,
            payerPersonId: paymentRow.payerPersonId,
            amountMinor: paymentRow.amountMinor,
            currency: paymentRow.currency,
            allocatedInvoiceIds: input.allocations.map((allocation) => allocation.invoiceId),
          },
        });

        return { paymentRow, allocationRows };
      });

      if (!created) {
        // Already seen - the atomic write above guarantees the allocations
        // for the ORIGINAL call exist. Return exactly that, not a fresh
        // credit: this is what makes a retried recordPayment a true no-op.
        const existing = await this.findByIdempotencyKey(tenantId, input.idempotencyKey);
        if (!existing) {
          throw new Error(`recordPayment(): idempotencyKey "${input.idempotencyKey}" conflicted but no existing row was found.`);
        }
        const existingAllocations = await this.listAllocationsForPayment(tenantId, existing.id);
        return ok({ payment: toPayment(existing), allocations: existingAllocations.map(toPaymentAllocation), replayed: true });
      }

      return ok({ payment: toPayment(created.paymentRow), allocations: created.allocationRows.map(toPaymentAllocation), replayed: false });
    } catch (error) {
      return err(toDomainError(error, `Could not record a payment for payer ${input.payerPersonId}.`) as DomainError);
    }
  }

  private async findByIdempotencyKey(tenantId: TenantId, idempotencyKey: string): Promise<typeof paymentTable.$inferSelect | undefined> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(paymentTable).where(and(eq(paymentTable.tenantId, tenantId), eq(paymentTable.idempotencyKey, idempotencyKey))).limit(1),
    );
    return rows[0];
  }

  private async listAllocationsForPayment(tenantId: TenantId, paymentId: string): Promise<Array<typeof paymentAllocationTable.$inferSelect>> {
    const ctx = scopedContext(tenantId);
    return withTenantTx(ctx, (db) =>
      db.select().from(paymentAllocationTable).where(and(eq(paymentAllocationTable.tenantId, tenantId), eq(paymentAllocationTable.paymentId, paymentId))),
    );
  }

  async getPayment(tenantId: TenantId, id: string): Promise<Result<Payment, NotFoundErrorType>> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) => db.select().from(paymentTable).where(and(eq(paymentTable.tenantId, tenantId), eq(paymentTable.id, id))).limit(1));
    const row = rows[0];
    if (!row) {
      return err(new NotFoundError(`Payment ${id} not found.`));
    }
    return ok(toPayment(row));
  }

  async listPayments(tenantId: TenantId, input: ListPaymentsInput): Promise<Payment[]> {
    const ctx = scopedContext(tenantId);
    const conditions = [eq(paymentTable.tenantId, tenantId)];
    if (input.payerPersonId) conditions.push(eq(paymentTable.payerPersonId, input.payerPersonId));
    const rows = await withTenantTx(ctx, (db) => db.select().from(paymentTable).where(and(...conditions)).orderBy(desc(paymentTable.receivedAt)));
    return rows.map(toPayment);
  }

  /**
   * Unapplied credit per currency - `totalPaidMinor - totalAllocatedMinor`,
   * computed from `billing.payment`/`billing.payment_allocation` on every
   * read, never stored (rule #5: over-payment is a credit, never a negative
   * invoice). Two independent scalar subqueries per currency, same
   * fan-out-avoidance reasoning as `InvoiceService.getAccountBalance`.
   */
  async getPayerCredit(tenantId: TenantId, payerPersonId: PersonId): Promise<PayerCredit[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.execute<PayerCreditRow>(sql`
        select
          cur.currency,
          coalesce(
            (select sum(p.amount_minor) from billing.payment p
              where p.tenant_id = ${tenantId} and p.payer_person_id = ${payerPersonId} and p.currency = cur.currency),
            0
          ) as total_paid_minor,
          coalesce(
            (select sum(pa.amount_minor) from billing.payment_allocation pa
               join billing.payment p2 on p2.id = pa.payment_id
              where p2.tenant_id = ${tenantId} and p2.payer_person_id = ${payerPersonId} and p2.currency = cur.currency),
            0
          ) as total_allocated_minor
        from (
          select distinct currency from billing.payment
          where tenant_id = ${tenantId} and payer_person_id = ${payerPersonId}
        ) cur
      `),
    );
    return (rows as unknown as PayerCreditRow[]).map((row) => {
      const totalPaidMinor = Number(row.total_paid_minor);
      const totalAllocatedMinor = Number(row.total_allocated_minor);
      return {
        payerPersonId,
        currency: row.currency,
        totalPaidMinor,
        totalAllocatedMinor,
        creditMinor: totalPaidMinor - totalAllocatedMinor,
      };
    });
  }
}
