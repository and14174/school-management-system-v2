import { createZodDto } from 'nestjs-zod';
import {
  createFeeScheduleSchema,
  createInvoiceSchema,
  issueCreditNoteSchema,
  listInvoicesQuerySchema,
  listPaymentsQuerySchema,
  publishFeeScheduleVersionSchema,
  recordPaymentSchema,
  setCreditNoteApprovalPolicySchema,
} from '../../application/schemas.js';

export class CreateFeeScheduleDto extends createZodDto(createFeeScheduleSchema) {}
export class PublishFeeScheduleVersionDto extends createZodDto(publishFeeScheduleVersionSchema) {}
export class CreateInvoiceDto extends createZodDto(createInvoiceSchema) {}
export class ListInvoicesQueryDto extends createZodDto(listInvoicesQuerySchema) {}
export class RecordPaymentDto extends createZodDto(recordPaymentSchema) {}
export class ListPaymentsQueryDto extends createZodDto(listPaymentsQuerySchema) {}
export class IssueCreditNoteDto extends createZodDto(issueCreditNoteSchema) {}
export class SetCreditNoteApprovalPolicyDto extends createZodDto(setCreditNoteApprovalPolicySchema) {}
