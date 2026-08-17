import { z } from 'zod';

/**
 * Zod schemas for this module's REST bodies - parsed by the `nestjs-zod`
 * DTOs in `src/api/dto` (`createZodDto`), same convention as
 * `@sms/communications`'s `application/schemas.ts`.
 */

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
const dateOnlySchema = z.string().regex(dateOnlyPattern, 'must be a YYYY-MM-DD date');

/** ISO-4217, upper-cased 3-letter code (`USD`, `EUR`, ...) - the REST-boundary counterpart to the DB's `char(3)` column. */
const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO-4217 code, e.g. "USD"');

/** Integer minor units only - never a float. `.int()` rejects `1050.5` outright rather than silently truncating it. */
const amountMinorSchema = z.number().int().positive();

export const createFeeScheduleSchema = z.object({
  name: z.string().min(1).max(200),
  academicYearId: z.string().uuid(),
});

export const publishFeeScheduleVersionSchema = z.object({
  currency: currencySchema,
  components: z
    .array(
      z.object({
        code: z.string().min(1).max(50),
        name: z.string().min(1).max(200),
        amountMinor: amountMinorSchema,
      }),
    )
    .min(1),
  effectiveFrom: dateOnlySchema.optional(),
});

export const createInvoiceSchema = z.object({
  studentPersonId: z.string().uuid(),
  payerPersonId: z.string().uuid().optional(),
  currency: currencySchema,
  dueDate: dateOnlySchema.optional(),
  feeComponentIds: z.array(z.string().uuid()).min(1),
});

export const listInvoicesQuerySchema = z.object({
  studentPersonId: z.string().uuid().optional(),
  payerPersonId: z.string().uuid().optional(),
  status: z.enum(['draft', 'issued']).optional(),
});

export const recordPaymentSchema = z.object({
  payerPersonId: z.string().uuid(),
  amountMinor: amountMinorSchema,
  currency: currencySchema,
  method: z.string().min(1).max(50).optional(),
  idempotencyKey: z.string().min(1).max(200),
  allocations: z
    .array(
      z.object({
        invoiceId: z.string().uuid(),
        amountMinor: amountMinorSchema,
      }),
    )
    .default([]),
});

export const listPaymentsQuerySchema = z.object({
  payerPersonId: z.string().uuid().optional(),
});

export const issueCreditNoteSchema = z.object({
  invoiceId: z.string().uuid(),
  reason: z.string().min(1).max(1000),
  lines: z
    .array(
      z.object({
        invoiceLineId: z.string().uuid().optional(),
        description: z.string().min(1).max(300),
        amountMinor: amountMinorSchema,
      }),
    )
    .min(1),
});

/** Configures the (opt-in) @sms/approvals gating threshold for credit notes in one currency - see the `1401` migration header. */
export const setCreditNoteApprovalPolicySchema = z.object({
  currency: currencySchema,
  thresholdMinor: amountMinorSchema,
});
