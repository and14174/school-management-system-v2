import type { AcademicYearId, PersonId, TenantId, UserId } from '@sms/kernel';
import type {
  CreditNote,
  CreditNoteApprovalPolicy,
  CreditNoteLine,
  FeeComponent,
  FeeSchedule,
  FeeScheduleVersion,
  Invoice,
  InvoiceLine,
  InvoiceStatus,
  Payment,
  PaymentAllocation,
} from '../domain/types.js';
import type {
  creditNoteApprovalPolicyTable,
  creditNoteLineTable,
  creditNoteTable,
  feeComponentTable,
  feeScheduleTable,
  feeScheduleVersionTable,
  invoiceLineTable,
  invoiceTable,
  paymentAllocationTable,
  paymentTable,
} from './schema.js';

type FeeScheduleRow = typeof feeScheduleTable.$inferSelect;
type FeeScheduleVersionRow = typeof feeScheduleVersionTable.$inferSelect;
type FeeComponentRow = typeof feeComponentTable.$inferSelect;
type InvoiceRow = typeof invoiceTable.$inferSelect;
type InvoiceLineRow = typeof invoiceLineTable.$inferSelect;
type PaymentRow = typeof paymentTable.$inferSelect;
type PaymentAllocationRow = typeof paymentAllocationTable.$inferSelect;
type CreditNoteRow = typeof creditNoteTable.$inferSelect;
type CreditNoteLineRow = typeof creditNoteLineTable.$inferSelect;
type CreditNoteApprovalPolicyRow = typeof creditNoteApprovalPolicyTable.$inferSelect;

export function toFeeSchedule(row: FeeScheduleRow): FeeSchedule {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    academicYearId: row.academicYearId as AcademicYearId,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toFeeScheduleVersion(row: FeeScheduleVersionRow): FeeScheduleVersion {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    feeScheduleId: row.feeScheduleId,
    version: row.version,
    currency: row.currency,
    effectiveFrom: row.effectiveFrom,
    createdAt: row.createdAt,
  };
}

export function toFeeComponent(row: FeeComponentRow): FeeComponent {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    feeScheduleVersionId: row.feeScheduleVersionId,
    code: row.code,
    name: row.name,
    amountMinor: row.amountMinor,
    createdAt: row.createdAt,
  };
}

export function toInvoice(row: InvoiceRow): Invoice {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    studentPersonId: row.studentPersonId as PersonId,
    payerPersonId: (row.payerPersonId as PersonId | null) ?? null,
    currency: row.currency,
    status: row.status as InvoiceStatus,
    dueDate: row.dueDate,
    issuedAt: row.issuedAt,
    issuedByUserId: (row.issuedByUserId as UserId | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toInvoiceLine(row: InvoiceLineRow): InvoiceLine {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    invoiceId: row.invoiceId,
    feeComponentId: row.feeComponentId,
    feeScheduleVersionId: row.feeScheduleVersionId,
    description: row.description,
    amountMinor: row.amountMinor,
    createdAt: row.createdAt,
  };
}

export function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    payerPersonId: row.payerPersonId as PersonId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    method: row.method,
    idempotencyKey: row.idempotencyKey,
    receivedAt: row.receivedAt,
    recordedByUserId: (row.recordedByUserId as UserId | null) ?? null,
    createdAt: row.createdAt,
  };
}

export function toPaymentAllocation(row: PaymentAllocationRow): PaymentAllocation {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    paymentId: row.paymentId,
    invoiceId: row.invoiceId,
    amountMinor: row.amountMinor,
    createdAt: row.createdAt,
  };
}

export function toCreditNote(row: CreditNoteRow): CreditNote {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    invoiceId: row.invoiceId,
    reason: row.reason,
    issuedAt: row.issuedAt,
    issuedByUserId: (row.issuedByUserId as UserId | null) ?? null,
    createdAt: row.createdAt,
  };
}

export function toCreditNoteLine(row: CreditNoteLineRow): CreditNoteLine {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    creditNoteId: row.creditNoteId,
    invoiceLineId: row.invoiceLineId,
    description: row.description,
    amountMinor: row.amountMinor,
    createdAt: row.createdAt,
  };
}

export function toCreditNoteApprovalPolicy(row: CreditNoteApprovalPolicyRow): CreditNoteApprovalPolicy {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    currency: row.currency,
    thresholdMinor: row.thresholdMinor,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
