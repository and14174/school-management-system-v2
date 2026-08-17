import type { AcademicYearId, PersonId, TenantId, UserId } from '@sms/kernel';

/**
 * ISO-4217 currency code, e.g. `'USD'`. Not branded (a plain `string` at the
 * type boundary) - every column it maps to (`char(3)`) is validated by the
 * DB, and zod validates the exact 3-letter shape at the REST boundary (see
 * `application/schemas.ts`).
 */
export type CurrencyCode = string;

export type InvoiceStatus = 'draft' | 'issued';
export const INVOICE_STATUSES: readonly InvoiceStatus[] = ['draft', 'issued'];

/** Mirrors `billing.fee_schedule`. Never priced directly - see `FeeScheduleVersion`. */
export interface FeeSchedule {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly academicYearId: AcademicYearId;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Mirrors `billing.fee_schedule_version`. An IMMUTABLE priced snapshot - see
 * the `1400` migration header. `billing.invoice_line.fee_schedule_version_id`
 * points here, stamped at invoice time.
 */
export interface FeeScheduleVersion {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly feeScheduleId: string;
  readonly version: number;
  readonly currency: CurrencyCode;
  readonly effectiveFrom: string;
  readonly createdAt: Date;
}

/** Mirrors `billing.fee_component`. `amountMinor` is integer minor units (cents) - never a float. */
export interface FeeComponent {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly feeScheduleVersionId: string;
  readonly code: string;
  readonly name: string;
  readonly amountMinor: number;
  readonly createdAt: Date;
}

/** A `FeeScheduleVersion` together with the `FeeComponent` rows priced under it - what `publishFeeScheduleVersion`/`getFeeScheduleVersion` return. */
export interface FeeScheduleVersionDetail extends FeeScheduleVersion {
  readonly components: readonly FeeComponent[];
}

/**
 * Mirrors `billing.invoice`. FOR `studentPersonId`, optionally ADDRESSED TO
 * `payerPersonId` - the distinction that makes a `dependants`-scoped
 * guardian's read narrow correctly (see `BillingContract`'s own doc comment
 * and `BillingController`). Carries no balance/total column - see the
 * `1400` migration header; `InvoiceBalance` is computed, never stored.
 */
export interface Invoice {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly studentPersonId: PersonId;
  readonly payerPersonId: PersonId | null;
  readonly currency: CurrencyCode;
  readonly status: InvoiceStatus;
  readonly dueDate: string | null;
  readonly issuedAt: Date | null;
  readonly issuedByUserId: UserId | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `billing.invoice_line`. Immutable once the parent invoice is issued - see the `1400` migration header. */
export interface InvoiceLine {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly invoiceId: string;
  readonly feeComponentId: string;
  readonly feeScheduleVersionId: string;
  readonly description: string;
  readonly amountMinor: number;
  readonly createdAt: Date;
}

/** An `Invoice` together with its `InvoiceLine` rows - what `getInvoice` returns. */
export interface InvoiceDetail extends Invoice {
  readonly lines: readonly InvoiceLine[];
}

/** Resolves an invoice id to the data a controller needs to authorize a request against it - same idiom as `@sms/records`' `ReportCardContext`. */
export interface InvoiceContext {
  readonly studentPersonId: PersonId;
  readonly payerPersonId: PersonId | null;
}

/** Mirrors `billing.payment`. Append-only - see the `1400` migration header. */
export interface Payment {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly payerPersonId: PersonId;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly method: string;
  readonly idempotencyKey: string;
  readonly receivedAt: Date;
  readonly recordedByUserId: UserId | null;
  readonly createdAt: Date;
}

/** Mirrors `billing.payment_allocation`. How much of one payment was applied to one invoice - explicit, never inferred. */
export interface PaymentAllocation {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly paymentId: string;
  readonly invoiceId: string;
  readonly amountMinor: number;
  readonly createdAt: Date;
}

/** Mirrors `billing.credit_note`. The only way to correct an issued invoice - never an edit. */
export interface CreditNote {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly invoiceId: string;
  readonly reason: string;
  readonly issuedAt: Date;
  readonly issuedByUserId: UserId | null;
  readonly createdAt: Date;
}

/** Mirrors `billing.credit_note_line`. */
export interface CreditNoteLine {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly creditNoteId: string;
  readonly invoiceLineId: string | null;
  readonly description: string;
  readonly amountMinor: number;
  readonly createdAt: Date;
}

/** A `CreditNote` together with its `CreditNoteLine` rows. */
export interface CreditNoteDetail extends CreditNote {
  readonly lines: readonly CreditNoteLine[];
}

/**
 * Mirrors `billing.credit_note_approval_policy`. Opt-in, per currency - see
 * the `1401` migration header. No row for a currency means credit notes in
 * it are never gated.
 */
export interface CreditNoteApprovalPolicy {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly currency: CurrencyCode;
  readonly thresholdMinor: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * What `issueCreditNote` actually returns: either the note was applied
 * immediately (no policy configured for its currency, or it fell under the
 * threshold), or it was held pending - see `BillingContract.issueCreditNote`'s
 * own doc comment and the `1401` migration header.
 */
export type IssueCreditNoteResult =
  | { readonly status: 'issued'; readonly creditNote: CreditNoteDetail }
  | { readonly status: 'pending_approval'; readonly approvalRequestId: string };

/**
 * What one invoice's balance actually is - DERIVED from posted rows, never
 * read off a stored column (there is none - see the `1400` migration
 * header). `chargesMinor` only counts `issued` invoices (a draft is a quote,
 * not a charge); `paidMinor` is what has been ALLOCATED to this invoice
 * (`billing.payment_allocation`), not merely received; `creditedMinor` is
 * every `billing.credit_note_line` raised against it.
 * `balanceMinor = chargesMinor - paidMinor - creditedMinor`, and can be
 * negative (the family has a net credit on this invoice) but the invoice
 * row itself is never rewritten to reflect that - see rule #5 in the module
 * brief.
 */
export interface InvoiceBalance {
  readonly invoiceId: string;
  readonly currency: CurrencyCode;
  readonly chargesMinor: number;
  readonly paidMinor: number;
  readonly creditedMinor: number;
  readonly balanceMinor: number;
}

/** The same derivation as `InvoiceBalance`, summed across every issued invoice a student has, grouped by currency (a tenant may bill in more than one). */
export interface AccountBalance {
  readonly studentPersonId: PersonId;
  readonly currency: CurrencyCode;
  readonly chargesMinor: number;
  readonly paidMinor: number;
  readonly creditedMinor: number;
  readonly balanceMinor: number;
}

/**
 * A payer's unapplied credit - money paid that was never allocated to any
 * invoice (rule #5: over-payment is a credit, never a negative invoice).
 * `creditMinor = totalPaidMinor - totalAllocatedMinor`, computed, never
 * stored.
 */
export interface PayerCredit {
  readonly payerPersonId: PersonId;
  readonly currency: CurrencyCode;
  readonly totalPaidMinor: number;
  readonly totalAllocatedMinor: number;
  readonly creditMinor: number;
}

/**
 * Tenant- (or, for a `dependants`-scoped caller, family-) level money
 * totals for the dashboard tile and portal home cards - see
 * `BillingContract.getBillingSummary`. Every figure is aggregated in SQL
 * over the SAME derivation `InvoiceBalance`/`AccountBalance` use (charges
 * minus allocated payments minus credits, `issued` invoices only) - never a
 * stored column, never fetched-then-filtered.
 *
 * `outstandingMinor` sums only the POSITIVE per-invoice balance (a credit
 * sitting on one invoice never offsets what is owed on another - each
 * invoice is clamped at 0 before summing), so this is honestly "what is
 * owed", not a net figure that could read as owed money when the family is
 * actually in credit overall.
 *
 * `currency` is `null` only when there is no `issued` invoice anywhere in
 * scope to derive one from - a genuine "nothing to report" state, never a
 * guessed default (see docs/decisions.md's "Never render a fabricated
 * figure"). When more than one currency appears in scope (the schema
 * permits it - one fee_schedule_version per currency), the currency with the
 * larger outstanding balance is reported and the rest are not merged into
 * it, so this never silently adds two currencies' minor units together.
 */
export interface BillingSummary {
  readonly currency: CurrencyCode | null;
  readonly outstandingMinor: number;
  readonly overdueInvoiceCount: number;
  /** Allocated (never merely received/unapplied) within the trailing `collectedWindowDays` days, scoped the same way as `outstandingMinor`. */
  readonly collectedMinor: number;
  readonly collectedWindowDays: number;
}
