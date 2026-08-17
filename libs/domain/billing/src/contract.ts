import type { AcademicYearId, DateOnly, DomainError, NotFoundError, PersonId, Result } from '@sms/kernel';
import type {
  AccountBalance,
  BillingSummary,
  CreditNote,
  CreditNoteApprovalPolicy,
  CreditNoteDetail,
  CurrencyCode,
  FeeSchedule,
  FeeScheduleVersion,
  FeeScheduleVersionDetail,
  Invoice,
  InvoiceBalance,
  InvoiceContext,
  InvoiceDetail,
  InvoiceStatus,
  IssueCreditNoteResult,
  Payment,
  PayerCredit,
  PaymentAllocation,
} from './domain/types.js';

export * from './domain/types.js';

// ---------------------------------------------------------------------------
// Fee schedules
// ---------------------------------------------------------------------------

export interface CreateFeeScheduleInput {
  readonly name: string;
  readonly academicYearId: AcademicYearId;
}

export interface PublishFeeScheduleVersionInput {
  readonly feeScheduleId: string;
  readonly currency: CurrencyCode;
  readonly components: ReadonlyArray<{ readonly code: string; readonly name: string; readonly amountMinor: number }>;
  /** Defaults to today. */
  readonly effectiveFrom?: DateOnly;
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export interface CreateInvoiceInput {
  readonly studentPersonId: PersonId;
  readonly payerPersonId?: PersonId;
  readonly currency: CurrencyCode;
  readonly dueDate?: DateOnly;
  /** Every component must belong to a `fee_schedule_version` priced in `currency` - validated atomically with the insert. At least one line is required: an invoice with nothing on it bills nothing. */
  readonly feeComponentIds: readonly string[];
}

export interface ListInvoicesInput {
  readonly studentPersonId?: PersonId;
  readonly payerPersonId?: PersonId;
  readonly status?: InvoiceStatus;
  /**
   * Narrows the result to exactly these students, enforced in the SQL
   * `WHERE` clause (never fetched-then-filtered) - what `BillingController`
   * passes for a `dependants`-scoped caller. See that controller's own
   * top-of-file comment: this is the most security-sensitive filter in the
   * module, because getting it wrong exposes every family's finances to
   * every parent.
   */
  readonly studentPersonIds?: readonly PersonId[];
}

/**
 * Same scope-narrowing shape as `ListInvoicesInput` (`studentPersonId` for
 * an `own`-scoped caller, `studentPersonIds` for a `dependants`-scoped one),
 * applied in SQL exactly the same way - see `InvoiceService.getBillingSummary`.
 * Neither set: a `tenant`-scoped caller, the whole tenant's totals.
 * `studentPersonIds` explicitly `[]` (a `dependants`-scoped caller with zero
 * resolved children) short-circuits to the honest empty summary without a
 * query - never silently widens to the tenant.
 */
export interface GetBillingSummaryInput {
  readonly studentPersonId?: PersonId;
  readonly studentPersonIds?: readonly PersonId[];
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export interface RecordPaymentAllocationInput {
  readonly invoiceId: string;
  readonly amountMinor: number;
}

export interface RecordPaymentInput {
  readonly payerPersonId: PersonId;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly method?: string;
  /** Client-supplied, required, unique per tenant. A replay of the same key is a no-op - see `PaymentService.recordPayment`. */
  readonly idempotencyKey: string;
  /** The sum must not exceed `amountMinor` - any remainder is unapplied credit (rule #5), never a negative invoice. May be empty: a payment can be recorded as pure credit with nothing allocated yet. */
  readonly allocations: readonly RecordPaymentAllocationInput[];
}

export interface RecordPaymentResult {
  readonly payment: Payment;
  readonly allocations: readonly PaymentAllocation[];
  /** `true` when `idempotencyKey` had already been submitted - the returned `payment`/`allocations` are the ORIGINAL result, and nothing was written this call. */
  readonly replayed: boolean;
}

export interface ListPaymentsInput {
  readonly payerPersonId?: PersonId;
}

// ---------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------

export interface IssueCreditNoteLineInput {
  readonly invoiceLineId?: string;
  readonly description: string;
  readonly amountMinor: number;
}

export interface IssueCreditNoteInput {
  readonly invoiceId: string;
  readonly reason: string;
  readonly lines: readonly IssueCreditNoteLineInput[];
}

/** Configures the opt-in @sms/approvals gating threshold for credit notes in one currency - see the `1401` migration header. Upserts on `(tenant, currency)`. */
export interface SetCreditNoteApprovalPolicyInput {
  readonly currency: CurrencyCode;
  readonly thresholdMinor: number;
}

/**
 * The public port this module exposes to the rest of the system
 * (`apps/api`'s `BillingController`) - matching `@sms/records`'
 * `RecordsContract` pattern: every other module should depend on this
 * interface, not on the concrete `BillingService` behind it.
 *
 * Every method resolves the ambient tenant context (`currentTenantContext()`)
 * - `BillingService` (the implementation behind this interface) is the
 * REST-facing facade; the individual services it composes take `tenantId`
 * explicitly so they also work from `seed.ts` and from tests with no ambient
 * context at all.
 */
export interface BillingContract {
  // --- Fee schedules ------------------------------------------------------

  createFeeSchedule(input: CreateFeeScheduleInput): Promise<Result<FeeSchedule, DomainError>>;
  listFeeSchedules(): Promise<FeeSchedule[]>;
  /** Creates a NEW immutable `FeeScheduleVersion` (with its `FeeComponent` rows) - editing a fee schedule never touches an existing version or any invoice already priced from it. */
  publishFeeScheduleVersion(input: PublishFeeScheduleVersionInput): Promise<Result<FeeScheduleVersionDetail, DomainError>>;
  listFeeScheduleVersions(feeScheduleId: string): Promise<FeeScheduleVersion[]>;
  getFeeScheduleVersion(id: string): Promise<Result<FeeScheduleVersionDetail, NotFoundError>>;

  // --- Invoices -------------------------------------------------------------

  /** Creates a `draft` invoice with its lines, each priced (and stamped with `fee_schedule_version_id`) from `feeComponentIds` - all in one transaction. */
  createInvoice(input: CreateInvoiceInput): Promise<Result<InvoiceDetail, DomainError>>;
  /**
   * Transitions `draft` -> `issued` and publishes `billing.invoice_issued`
   * through the outbox - in the SAME transaction. From this point the
   * invoice and its lines are immutable in substance (enforced in the
   * database - see the `1400` migration header); a correction is
   * `issueCreditNote`, never another call to this or any line-editing method.
   */
  issueInvoice(id: string): Promise<Result<Invoice, DomainError>>;
  getInvoice(id: string): Promise<Result<InvoiceDetail, NotFoundError>>;
  listInvoices(input: ListInvoicesInput): Promise<Invoice[]>;
  getInvoiceContext(id: string): Promise<InvoiceContext | null>;

  /** Derived from posted rows - never a stored column. See `InvoiceBalance`'s own doc comment. */
  getInvoiceBalance(id: string): Promise<Result<InvoiceBalance, NotFoundError>>;
  /** Every `issued` invoice `studentPersonId` has, summed per currency. */
  getAccountBalance(studentPersonId: PersonId): Promise<AccountBalance[]>;
  /** Tenant- (or family-) level totals for the dashboard/portal - see `BillingSummary`'s own doc comment. */
  getBillingSummary(input: GetBillingSummaryInput): Promise<BillingSummary>;

  // --- Payments -------------------------------------------------------------

  /**
   * Idempotent on `idempotencyKey`: a replay returns the ORIGINAL payment
   * and allocations and writes nothing further. The payment row and every
   * allocation row are written in ONE transaction (see
   * `PaymentService.recordPayment`'s own comment and `docs/decisions.md`'s
   * "A dedupe key must guard a write that is already atomic") - and
   * `billing.payment_recorded` is published through the outbox in that same
   * transaction, only on the first (non-replayed) write.
   */
  recordPayment(input: RecordPaymentInput): Promise<Result<RecordPaymentResult, DomainError>>;
  getPayment(id: string): Promise<Result<Payment, NotFoundError>>;
  listPayments(input: ListPaymentsInput): Promise<Payment[]>;
  /** Unapplied credit - money paid that was never allocated to an invoice. Computed, never stored (rule #5). */
  getPayerCredit(payerPersonId: PersonId): Promise<PayerCredit[]>;

  // --- Credit notes -----------------------------------------------------

  /**
   * Writes the `credit_note` and every `credit_note_line` atomically - the
   * ONLY way to correct an `issued` invoice (rule #3); never an UPDATE to the
   * invoice or its lines.
   *
   * Opt-in gated by `@sms/approvals`: if a `CreditNoteApprovalPolicy` exists
   * for the invoice's currency AND the lines total at least its
   * `thresholdMinor`, this creates a pending approval request instead
   * (`{ status: 'pending_approval' }`) and writes NOTHING to
   * `billing.credit_note` - the note is written later, by
   * `CreditNoteApprovalHandler`, inside the approving decision's own
   * transaction, only once approved. With no policy configured for the
   * currency (the default - see the `1401` migration header), this behaves
   * exactly as it did before the approvals engine existed:
   * `{ status: 'issued' }` with the note written immediately.
   */
  issueCreditNote(input: IssueCreditNoteInput): Promise<Result<IssueCreditNoteResult, DomainError>>;
  getCreditNote(id: string): Promise<Result<CreditNoteDetail, NotFoundError>>;
  listCreditNotes(invoiceId: string): Promise<CreditNote[]>;

  /** See `SetCreditNoteApprovalPolicyInput`. */
  setCreditNoteApprovalPolicy(input: SetCreditNoteApprovalPolicyInput): Promise<Result<CreditNoteApprovalPolicy, DomainError>>;
  listCreditNoteApprovalPolicies(): Promise<CreditNoteApprovalPolicy[]>;
}

/**
 * DI token for `BillingContract` - see `RECORDS_CONTRACT` in `@sms/records`
 * for why a concrete Symbol token is used instead of relying on implicit
 * type-based DI.
 */
export const BILLING_CONTRACT = Symbol('BILLING_CONTRACT');
