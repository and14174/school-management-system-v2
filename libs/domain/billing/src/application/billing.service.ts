import { Inject, Injectable } from '@nestjs/common';
import type { DomainError, NotFoundError, PersonId, Result } from '@sms/kernel';
import type {
  AccountBalance,
  BillingContract,
  BillingSummary,
  CreateFeeScheduleInput,
  CreateInvoiceInput,
  CreditNote,
  CreditNoteApprovalPolicy,
  CreditNoteDetail,
  FeeSchedule,
  FeeScheduleVersion,
  FeeScheduleVersionDetail,
  GetBillingSummaryInput,
  Invoice,
  InvoiceBalance,
  InvoiceContext,
  InvoiceDetail,
  IssueCreditNoteInput,
  IssueCreditNoteResult,
  ListInvoicesInput,
  ListPaymentsInput,
  Payment,
  PayerCredit,
  PublishFeeScheduleVersionInput,
  RecordPaymentInput,
  RecordPaymentResult,
  SetCreditNoteApprovalPolicyInput,
} from '../contract.js';
import { currentTenantContext } from './current-context.js';
import { CreditNoteService } from './credit-note.service.js';
import { FeeScheduleService } from './fee-schedule.service.js';
import { InvoiceService } from './invoice.service.js';
import { PaymentService } from './payment.service.js';

/**
 * Implements `BillingContract`. Thin composition layer over the individual
 * services - exactly the shape `RecordsService` composes
 * `ReportCardService`/`TranscriptService`/... in `@sms/records`. Every
 * method resolves the ambient tenant via `currentTenantContext()`; the
 * services underneath all take `tenantId` explicitly so they also work from
 * `seed.ts` and from tests with no ambient context at all.
 */
@Injectable()
export class BillingService implements BillingContract {
  constructor(
    @Inject(FeeScheduleService) private readonly feeSchedules: FeeScheduleService,
    @Inject(InvoiceService) private readonly invoices: InvoiceService,
    @Inject(PaymentService) private readonly payments: PaymentService,
    @Inject(CreditNoteService) private readonly creditNotes: CreditNoteService,
  ) {}

  createFeeSchedule(input: CreateFeeScheduleInput): Promise<Result<FeeSchedule, DomainError>> {
    return this.feeSchedules.createFeeSchedule(currentTenantContext().tenantId, input);
  }
  listFeeSchedules(): Promise<FeeSchedule[]> {
    return this.feeSchedules.listFeeSchedules(currentTenantContext().tenantId);
  }
  publishFeeScheduleVersion(input: PublishFeeScheduleVersionInput): Promise<Result<FeeScheduleVersionDetail, DomainError>> {
    return this.feeSchedules.publishFeeScheduleVersion(currentTenantContext().tenantId, input);
  }
  listFeeScheduleVersions(feeScheduleId: string): Promise<FeeScheduleVersion[]> {
    return this.feeSchedules.listFeeScheduleVersions(currentTenantContext().tenantId, feeScheduleId);
  }
  getFeeScheduleVersion(id: string): Promise<Result<FeeScheduleVersionDetail, NotFoundError>> {
    return this.feeSchedules.getFeeScheduleVersion(currentTenantContext().tenantId, id);
  }

  createInvoice(input: CreateInvoiceInput): Promise<Result<InvoiceDetail, DomainError>> {
    return this.invoices.createInvoice(currentTenantContext().tenantId, input);
  }
  issueInvoice(id: string): Promise<Result<Invoice, DomainError>> {
    return this.invoices.issueInvoice(currentTenantContext().tenantId, id);
  }
  getInvoice(id: string): Promise<Result<InvoiceDetail, NotFoundError>> {
    return this.invoices.getInvoice(currentTenantContext().tenantId, id);
  }
  listInvoices(input: ListInvoicesInput): Promise<Invoice[]> {
    return this.invoices.listInvoices(currentTenantContext().tenantId, input);
  }
  getInvoiceContext(id: string): Promise<InvoiceContext | null> {
    return this.invoices.getInvoiceContext(currentTenantContext().tenantId, id);
  }
  getInvoiceBalance(id: string): Promise<Result<InvoiceBalance, NotFoundError>> {
    return this.invoices.getInvoiceBalance(currentTenantContext().tenantId, id);
  }
  getAccountBalance(studentPersonId: PersonId): Promise<AccountBalance[]> {
    return this.invoices.getAccountBalance(currentTenantContext().tenantId, studentPersonId);
  }
  getBillingSummary(input: GetBillingSummaryInput): Promise<BillingSummary> {
    return this.invoices.getBillingSummary(currentTenantContext().tenantId, input);
  }

  recordPayment(input: RecordPaymentInput): Promise<Result<RecordPaymentResult, DomainError>> {
    return this.payments.recordPayment(currentTenantContext().tenantId, input);
  }
  getPayment(id: string): Promise<Result<Payment, NotFoundError>> {
    return this.payments.getPayment(currentTenantContext().tenantId, id);
  }
  listPayments(input: ListPaymentsInput): Promise<Payment[]> {
    return this.payments.listPayments(currentTenantContext().tenantId, input);
  }
  getPayerCredit(payerPersonId: PersonId): Promise<PayerCredit[]> {
    return this.payments.getPayerCredit(currentTenantContext().tenantId, payerPersonId);
  }

  issueCreditNote(input: IssueCreditNoteInput): Promise<Result<IssueCreditNoteResult, DomainError>> {
    return this.creditNotes.issueCreditNote(currentTenantContext().tenantId, input);
  }
  getCreditNote(id: string): Promise<Result<CreditNoteDetail, NotFoundError>> {
    return this.creditNotes.getCreditNote(currentTenantContext().tenantId, id);
  }
  listCreditNotes(invoiceId: string): Promise<CreditNote[]> {
    return this.creditNotes.listCreditNotes(currentTenantContext().tenantId, invoiceId);
  }
  setCreditNoteApprovalPolicy(input: SetCreditNoteApprovalPolicyInput): Promise<Result<CreditNoteApprovalPolicy, DomainError>> {
    return this.creditNotes.setApprovalPolicy(currentTenantContext().tenantId, input);
  }
  listCreditNoteApprovalPolicies(): Promise<CreditNoteApprovalPolicy[]> {
    return this.creditNotes.listApprovalPolicies(currentTenantContext().tenantId);
  }
}
