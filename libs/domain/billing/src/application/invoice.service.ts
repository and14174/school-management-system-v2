import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  ConflictError,
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
import { withTenantTx, type Tx } from '@sms/db';
import { OUTBOX_CONTRACT, type OutboxContract } from '@sms/outbox';
import type { CreateInvoiceInput, GetBillingSummaryInput, ListInvoicesInput } from '../contract.js';
import type { AccountBalance, BillingSummary, Invoice, InvoiceBalance, InvoiceContext, InvoiceDetail } from '../domain/types.js';
import { toInvoice, toInvoiceLine } from '../infrastructure/mappers.js';
import { feeComponentTable, feeScheduleVersionTable, invoiceLineTable, invoiceTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

type AccountBalanceRow = {
  readonly currency: string;
  readonly charges_minor: string | number;
  readonly paid_minor: string | number;
  readonly credited_minor: string | number;
};

type InvoiceBalanceRow = {
  readonly invoice_id: string;
  readonly currency: string;
  readonly charges_minor: string | number;
  readonly paid_minor: string | number;
  readonly credited_minor: string | number;
};

type SummaryByCurrencyRow = {
  readonly currency: string;
  readonly outstanding_minor: string | number;
  readonly overdue_count: string | number;
};

type SummaryCollectedRow = {
  readonly collected_minor: string | number;
};

/** Trailing window "amount collected" covers - same convention as the portal's own `ATTENDANCE_WINDOW_DAYS`. */
export const BILLING_SUMMARY_WINDOW_DAYS = 30;

/**
 * Invoices: creation (pricing every line from a `fee_component`, stamping
 * the `fee_schedule_version` it was priced from - rule #6), issuing (the
 * point past which the database itself refuses further mutation - see the
 * `1400` migration header), and balances - DERIVED from posted rows on every
 * read, never a stored column (rule #2). No method here ever writes an
 * `amount`/`balance` summary column anywhere.
 */
@Injectable()
export class InvoiceService {
  constructor(@Inject(OUTBOX_CONTRACT) private readonly outbox: OutboxContract) {}

  /**
   * Prices every line from `feeComponentIds` (each must belong to a
   * `fee_schedule_version` published in `input.currency` - a mismatch is a
   * `ValidationError`, never silently coerced) and writes the invoice plus
   * all of its lines in one transaction, `draft`.
   */
  async createInvoice(tenantId: TenantId, input: CreateInvoiceInput): Promise<Result<InvoiceDetail, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const result = await withTenantTx(ctx, async (db) => {
        const componentRows = await db
          .select({ component: feeComponentTable, version: feeScheduleVersionTable })
          .from(feeComponentTable)
          .innerJoin(feeScheduleVersionTable, eq(feeScheduleVersionTable.id, feeComponentTable.feeScheduleVersionId))
          .where(and(eq(feeComponentTable.tenantId, tenantId), inArray(feeComponentTable.id, [...input.feeComponentIds])));

        const byId = new Map(componentRows.map((row) => [row.component.id, row]));
        const missing = input.feeComponentIds.filter((id) => !byId.has(id));
        if (missing.length > 0) {
          throw new NotFoundError(`Fee component(s) not found: ${missing.join(', ')}.`);
        }
        const currencyMismatch = componentRows.find((row) => row.version.currency !== input.currency);
        if (currencyMismatch) {
          throw new ValidationError(
            `Fee component "${currencyMismatch.component.code}" is priced in ${currencyMismatch.version.currency}, not the invoice's ${input.currency}.`,
          );
        }

        const invoiceRows = await db
          .insert(invoiceTable)
          .values({
            id: newId(),
            tenantId,
            studentPersonId: input.studentPersonId,
            payerPersonId: input.payerPersonId ?? null,
            currency: input.currency,
            status: 'draft',
            dueDate: input.dueDate ?? null,
          })
          .returning();
        const invoice = invoiceRows[0]!;

        const lines = [];
        for (const feeComponentId of input.feeComponentIds) {
          const { component, version } = byId.get(feeComponentId)!;
          const lineRows = await db
            .insert(invoiceLineTable)
            .values({
              id: newId(),
              tenantId,
              invoiceId: invoice.id,
              feeComponentId: component.id,
              feeScheduleVersionId: version.id,
              description: component.name,
              amountMinor: component.amountMinor,
            })
            .returning();
          lines.push(lineRows[0]!);
        }

        return { invoice, lines };
      });
      return ok({ ...toInvoice(result.invoice), lines: result.lines.map(toInvoiceLine) });
    } catch (error) {
      return err(toDomainError(error, `Could not create invoice for student ${input.studentPersonId}.`) as DomainError);
    }
  }

  /**
   * `draft` -> `issued`, and publishes `billing.invoice_issued` - in the
   * SAME transaction as the status flip, so the fact and its announcement
   * can never disagree (`OutboxContract.publish`'s own doc comment). `for
   * update` guards a double-submit the same way
   * `AnnouncementService.publishWithinTx` does.
   */
  async issueInvoice(tenantId: TenantId, id: string): Promise<Result<Invoice, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const updated = await withTenantTx(ctx, async (db) => {
        const invoiceRows = await db
          .select()
          .from(invoiceTable)
          .where(and(eq(invoiceTable.tenantId, tenantId), eq(invoiceTable.id, id)))
          .limit(1)
          .for('update');
        const invoice = invoiceRows[0];
        if (!invoice) {
          throw new NotFoundError(`Invoice ${id} not found.`);
        }
        if (invoice.status !== 'draft') {
          throw new ConflictError(`Invoice ${id} is already ${invoice.status} - it cannot be issued again.`);
        }

        const lines = await db.select().from(invoiceLineTable).where(and(eq(invoiceLineTable.tenantId, tenantId), eq(invoiceLineTable.invoiceId, id)));
        if (lines.length === 0) {
          throw new ValidationError(`Invoice ${id} has no lines - add at least one charge before issuing it.`);
        }
        const totalMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0);

        const issuedByUserId = ctx.actorUserId ?? ctx.userId ?? null;
        const updatedRows = await db
          .update(invoiceTable)
          .set({ status: 'issued', issuedAt: new Date(), issuedByUserId })
          .where(eq(invoiceTable.id, id))
          .returning();
        const updatedInvoice = updatedRows[0]!;

        await this.outbox.publish(db, {
          topic: 'billing.invoice_issued',
          payload: {
            invoiceId: id,
            studentPersonId: updatedInvoice.studentPersonId,
            payerPersonId: updatedInvoice.payerPersonId,
            currency: updatedInvoice.currency,
            totalMinor,
            issuedAt: updatedInvoice.issuedAt,
          },
        });

        return updatedInvoice;
      });
      return ok(toInvoice(updated));
    } catch (error) {
      return err(toDomainError(error, `Could not issue invoice ${id}.`) as DomainError);
    }
  }

  async getInvoice(tenantId: TenantId, id: string): Promise<Result<InvoiceDetail, NotFoundErrorType>> {
    const ctx = scopedContext(tenantId);
    const invoiceRows = await withTenantTx(ctx, (db) => db.select().from(invoiceTable).where(and(eq(invoiceTable.tenantId, tenantId), eq(invoiceTable.id, id))).limit(1));
    const invoice = invoiceRows[0];
    if (!invoice) {
      return err(new NotFoundError(`Invoice ${id} not found.`));
    }
    const lineRows = await withTenantTx(ctx, (db) =>
      db.select().from(invoiceLineTable).where(and(eq(invoiceLineTable.tenantId, tenantId), eq(invoiceLineTable.invoiceId, id))),
    );
    return ok({ ...toInvoice(invoice), lines: lineRows.map(toInvoiceLine) });
  }

  /**
   * `input.studentPersonIds`, when present, narrows the SQL `WHERE` clause
   * itself (`inArray`) - never a fetch-then-filter. This is what
   * `BillingController` passes for a `dependants`-scoped caller (see that
   * file's own top-of-file comment): the query never asks Postgres for a
   * row it isn't allowed to return in the first place.
   */
  async listInvoices(tenantId: TenantId, input: ListInvoicesInput): Promise<Invoice[]> {
    const ctx = scopedContext(tenantId);
    const conditions = [eq(invoiceTable.tenantId, tenantId)];
    if (input.studentPersonId) conditions.push(eq(invoiceTable.studentPersonId, input.studentPersonId));
    if (input.payerPersonId) conditions.push(eq(invoiceTable.payerPersonId, input.payerPersonId));
    if (input.status) conditions.push(eq(invoiceTable.status, input.status));
    if (input.studentPersonIds) conditions.push(inArray(invoiceTable.studentPersonId, [...input.studentPersonIds]));

    const rows = await withTenantTx(ctx, (db) => db.select().from(invoiceTable).where(and(...conditions)).orderBy(desc(invoiceTable.createdAt)));
    return rows.map(toInvoice);
  }

  async getInvoiceContext(tenantId: TenantId, id: string): Promise<InvoiceContext | null> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select({ studentPersonId: invoiceTable.studentPersonId, payerPersonId: invoiceTable.payerPersonId })
        .from(invoiceTable)
        .where(and(eq(invoiceTable.tenantId, tenantId), eq(invoiceTable.id, id)))
        .limit(1),
    );
    const row = rows[0];
    if (!row) return null;
    return { studentPersonId: row.studentPersonId as PersonId, payerPersonId: (row.payerPersonId as PersonId | null) ?? null };
  }

  /**
   * Three independent scalar subqueries (charges / allocated payments /
   * credits), never a multi-table `JOIN ... GROUP BY` on `invoice_line`,
   * `payment_allocation` and `credit_note_line` together - joining all three
   * directly would fan out each row by the others' row counts and inflate
   * every sum. See `InvoiceBalance`'s own doc comment for what each term
   * means; nothing here reads a stored balance column, because there isn't
   * one (rule #2).
   */
  async getInvoiceBalance(tenantId: TenantId, id: string): Promise<Result<InvoiceBalance, NotFoundErrorType>> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) => this.selectInvoiceBalance(db, tenantId, id));
    const row = rows[0];
    if (!row) {
      return err(new NotFoundError(`Invoice ${id} not found.`));
    }
    return ok(this.toInvoiceBalance(row));
  }

  private async selectInvoiceBalance(db: Tx, tenantId: TenantId, id: string): Promise<InvoiceBalanceRow[]> {
    const rows = await db.execute<InvoiceBalanceRow>(sql`
      select
        i.id as invoice_id,
        i.currency,
        coalesce((select sum(l.amount_minor) from billing.invoice_line l where l.invoice_id = i.id), 0) as charges_minor,
        coalesce((select sum(pa.amount_minor) from billing.payment_allocation pa where pa.invoice_id = i.id), 0) as paid_minor,
        coalesce(
          (select sum(cnl.amount_minor) from billing.credit_note_line cnl
             join billing.credit_note cn on cn.id = cnl.credit_note_id
           where cn.invoice_id = i.id),
          0
        ) as credited_minor
      from billing.invoice i
      where i.tenant_id = ${tenantId} and i.id = ${id}
    `);
    return rows as unknown as InvoiceBalanceRow[];
  }

  private toInvoiceBalance(row: InvoiceBalanceRow): InvoiceBalance {
    const chargesMinor = Number(row.charges_minor);
    const paidMinor = Number(row.paid_minor);
    const creditedMinor = Number(row.credited_minor);
    return {
      invoiceId: row.invoice_id,
      currency: row.currency,
      chargesMinor,
      paidMinor,
      creditedMinor,
      balanceMinor: chargesMinor - paidMinor - creditedMinor,
    };
  }

  /** Every `issued` invoice `studentPersonId` has, summed per currency - see `AccountBalance`'s own doc comment. */
  async getAccountBalance(tenantId: TenantId, studentPersonId: PersonId): Promise<AccountBalance[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.execute<AccountBalanceRow>(sql`
        select
          cur.currency,
          coalesce(
            (select sum(l.amount_minor)
               from billing.invoice_line l
               join billing.invoice i2 on i2.id = l.invoice_id
              where i2.tenant_id = ${tenantId} and i2.student_person_id = ${studentPersonId}
                and i2.status = 'issued' and i2.currency = cur.currency),
            0
          ) as charges_minor,
          coalesce(
            (select sum(pa.amount_minor)
               from billing.payment_allocation pa
               join billing.invoice i3 on i3.id = pa.invoice_id
              where i3.tenant_id = ${tenantId} and i3.student_person_id = ${studentPersonId}
                and i3.status = 'issued' and i3.currency = cur.currency),
            0
          ) as paid_minor,
          coalesce(
            (select sum(cnl.amount_minor)
               from billing.credit_note_line cnl
               join billing.credit_note cn on cn.id = cnl.credit_note_id
               join billing.invoice i4 on i4.id = cn.invoice_id
              where i4.tenant_id = ${tenantId} and i4.student_person_id = ${studentPersonId}
                and i4.status = 'issued' and i4.currency = cur.currency),
            0
          ) as credited_minor
        from (
          select distinct currency from billing.invoice
          where tenant_id = ${tenantId} and student_person_id = ${studentPersonId} and status = 'issued'
        ) cur
      `),
    );
    return (rows as unknown as AccountBalanceRow[]).map((row) => {
      const chargesMinor = Number(row.charges_minor);
      const paidMinor = Number(row.paid_minor);
      const creditedMinor = Number(row.credited_minor);
      return {
        studentPersonId,
        currency: row.currency,
        chargesMinor,
        paidMinor,
        creditedMinor,
        balanceMinor: chargesMinor - paidMinor - creditedMinor,
      };
    });
  }

  /**
   * Tenant- (or, when `studentPersonIds`/`studentPersonId` is given, family-)
   * level totals - see `BillingSummary`'s own doc comment for what each
   * figure means. `BillingController.getBillingSummary` is the ONLY caller
   * that ever passes `studentPersonIds`, and always with
   * `AccessContract.resolveScopeConstraints`'s `dependants` set - the SQL
   * `WHERE` below is the enforcement, exactly like `listInvoices`'s own
   * `inArray`: a `dependants`-scoped caller's totals are built from a query
   * that never selects another family's rows in the first place, never a
   * fetch-then-filter.
   *
   * An explicitly empty `studentPersonIds` (a guardian with zero resolved
   * children) short-circuits to the honest zero/`null`-currency summary
   * without touching the database at all - the same "unresolvable scope
   * denies, never widens" posture `docs/decisions.md` documents, applied
   * here rather than left to an accidental `WHERE ... IN ()` (which some
   * SQL dialects even treat differently than "matches nothing").
   */
  async getBillingSummary(tenantId: TenantId, input: GetBillingSummaryInput): Promise<BillingSummary> {
    const studentPersonIds = input.studentPersonId ? [input.studentPersonId] : input.studentPersonIds;
    if (studentPersonIds && studentPersonIds.length === 0) {
      return { currency: null, outstandingMinor: 0, overdueInvoiceCount: 0, collectedMinor: 0, collectedWindowDays: BILLING_SUMMARY_WINDOW_DAYS };
    }

    const ctx = scopedContext(tenantId);
    const studentFilter = studentPersonIds ? sql`and i.student_person_id in (${sql.join(studentPersonIds.map((id) => sql`${id}`), sql`, `)})` : sql``;

    return withTenantTx(ctx, async (db) => {
      // Per-invoice balance (same three-subquery derivation as
      // selectInvoiceBalance above, never a fan-out JOIN across the three
      // fact tables), grouped by currency. Only `issued` invoices count - a
      // draft is a quote, not a charge (same rule getAccountBalance follows).
      const byCurrencyRows = await db.execute<SummaryByCurrencyRow>(sql`
        with scoped_invoice_balances as (
          select
            i.currency,
            i.due_date,
            coalesce((select sum(l.amount_minor) from billing.invoice_line l where l.invoice_id = i.id), 0)
              - coalesce((select sum(pa.amount_minor) from billing.payment_allocation pa where pa.invoice_id = i.id), 0)
              - coalesce(
                  (select sum(cnl.amount_minor) from billing.credit_note_line cnl
                     join billing.credit_note cn on cn.id = cnl.credit_note_id
                   where cn.invoice_id = i.id),
                  0
                ) as balance_minor
          from billing.invoice i
          where i.tenant_id = ${tenantId} and i.status = 'issued' ${studentFilter}
        )
        select
          currency,
          coalesce(sum(greatest(balance_minor, 0)), 0) as outstanding_minor,
          count(*) filter (where due_date < current_date and balance_minor > 0) as overdue_count
        from scoped_invoice_balances
        group by currency
        order by outstanding_minor desc
        limit 1
      `);

      const primary = (byCurrencyRows as unknown as SummaryByCurrencyRow[])[0];
      if (!primary) {
        return { currency: null, outstandingMinor: 0, overdueInvoiceCount: 0, collectedMinor: 0, collectedWindowDays: BILLING_SUMMARY_WINDOW_DAYS };
      }
      const currency = primary.currency;

      // Collected = ALLOCATED (never merely received/unapplied credit),
      // joined through the invoice so the same student-scope filter applies
      // and through billing.payment for received_at - the window is on when
      // the MONEY CAME IN, not when it was allocated. Restricted to the
      // reported `currency` so this never sums two currencies' minor units
      // together (see BillingSummary's own doc comment).
      const collectedRows = await db.execute<SummaryCollectedRow>(sql`
        select coalesce(sum(pa.amount_minor), 0) as collected_minor
        from billing.payment_allocation pa
        join billing.payment p on p.id = pa.payment_id and p.tenant_id = ${tenantId}
        join billing.invoice i on i.id = pa.invoice_id and i.tenant_id = ${tenantId}
        where i.status = 'issued'
          and i.currency = ${currency}
          and p.received_at >= now() - make_interval(days => ${BILLING_SUMMARY_WINDOW_DAYS})
          ${studentFilter}
      `);
      const collected = (collectedRows as unknown as SummaryCollectedRow[])[0];

      return {
        currency,
        outstandingMinor: Number(primary.outstanding_minor),
        overdueInvoiceCount: Number(primary.overdue_count),
        collectedMinor: Number(collected?.collected_minor ?? 0),
        collectedWindowDays: BILLING_SUMMARY_WINDOW_DAYS,
      };
    });
  }
}
