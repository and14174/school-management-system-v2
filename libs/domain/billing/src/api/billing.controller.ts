import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { ForbiddenError, isSystemContext, unwrap, type AcademicYearId, type DateOnly, type PersonId } from '@sms/kernel';
import { requireContext } from '@sms/db';
import { ACCESS_CONTRACT, RequirePermission, type AccessContract, type ScopeConstraint } from '@sms/access';
import { BILLING_CONTRACT, type BillingContract, type InvoiceContext, type InvoiceStatus } from '../contract.js';
import {
  CreateFeeScheduleDto,
  CreateInvoiceDto,
  IssueCreditNoteDto,
  PublishFeeScheduleVersionDto,
  RecordPaymentDto,
  SetCreditNoteApprovalPolicyDto,
} from './dto/billing.dto.js';

/**
 * `api/v1/billing/*`. Every read route is gated with `@RequirePermission`
 * AND (per `docs/decisions.md`'s "a list endpoint cannot be secured by a
 * per-row check it never performs") additionally applies
 * `AccessContract.resolveScopeConstraints` itself - same idiom as
 * `@sms/records`' `RecordsController` (the reference implementation this
 * file mirrors).
 *
 * `billing.invoice:read` is held tenant-wide by `finance`/
 * `school_administrator` and `dependants`-scoped by `parent_guardian` (their
 * own children - see `@sms/access`'s `seed.ts`). THIS is the single most
 * security-sensitive scope in this module: an invoice is FOR a
 * `studentPersonId` and only optionally addressed to a `payerPersonId` (see
 * the `1400` migration header), so a `dependants` constraint is always
 * checked against `studentPersonId`, never `payerPersonId` - a guardian's
 * own billing.invoice:read grant must never leak an invoice merely because
 * they happen to be its payer for some other reason.
 *
 * Every list/single-record read below narrows in the QUERY
 * (`BillingContract.listInvoices`'s `studentPersonIds` -> a SQL `inArray`
 * `WHERE`, see `InvoiceService.listInvoices`) rather than fetching every
 * invoice and filtering the response in memory - the acknowledged
 * "in-memory filtering" shortcut some other controllers in this codebase
 * take (e.g. `RecordsController.applyReportCardListConstraint`) is
 * deliberately NOT used here, because leaking one row of another family's
 * finances is a materially worse failure than leaking one row of a report
 * card list.
 *
 * `billing.fee_schedule:manage`, `billing.payment:record` and
 * `billing.credit_note:issue` are held ONLY tenant-wide (finance/
 * school_administrator) per the seeded catalogue - see `@sms/access`'s
 * `seed.ts` - so those routes need no additional per-request scope
 * narrowing beyond the guard itself, same reasoning `RecordsController`
 * documents for `documents.document:generate`.
 */
@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(
    @Inject(BILLING_CONTRACT) private readonly billing: BillingContract,
    @Inject(ACCESS_CONTRACT) private readonly access: AccessContract,
  ) {}

  // ---------------------------------------------------------------------
  // Fee schedules - finance-only, no parent-facing scope to narrow.
  // ---------------------------------------------------------------------

  @RequirePermission('billing.fee_schedule:manage')
  @Post('fee-schedules')
  async createFeeSchedule(@Body(new ZodValidationPipe(CreateFeeScheduleDto)) body: CreateFeeScheduleDto) {
    return unwrap(await this.billing.createFeeSchedule({ name: body.name, academicYearId: body.academicYearId as AcademicYearId }));
  }

  @RequirePermission('billing.fee_schedule:manage')
  @Get('fee-schedules')
  listFeeSchedules() {
    return this.billing.listFeeSchedules();
  }

  @RequirePermission('billing.fee_schedule:manage')
  @Post('fee-schedules/:id/versions')
  async publishFeeScheduleVersion(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(PublishFeeScheduleVersionDto)) body: PublishFeeScheduleVersionDto) {
    return unwrap(
      await this.billing.publishFeeScheduleVersion({
        feeScheduleId: id,
        currency: body.currency,
        components: body.components,
        ...(body.effectiveFrom ? { effectiveFrom: body.effectiveFrom as DateOnly } : {}),
      }),
    );
  }

  @RequirePermission('billing.fee_schedule:manage')
  @Get('fee-schedules/:id/versions')
  listFeeScheduleVersions(@Param('id', ParseUUIDPipe) id: string) {
    return this.billing.listFeeScheduleVersions(id);
  }

  @RequirePermission('billing.fee_schedule:manage')
  @Get('fee-schedule-versions/:id')
  async getFeeScheduleVersion(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.billing.getFeeScheduleVersion(id));
  }

  // ---------------------------------------------------------------------
  // Invoices
  // ---------------------------------------------------------------------

  @RequirePermission('billing.invoice:write')
  @Post('invoices')
  async createInvoice(@Body(new ZodValidationPipe(CreateInvoiceDto)) body: CreateInvoiceDto) {
    return unwrap(
      await this.billing.createInvoice({
        studentPersonId: body.studentPersonId as PersonId,
        currency: body.currency,
        feeComponentIds: body.feeComponentIds,
        ...(body.payerPersonId ? { payerPersonId: body.payerPersonId as PersonId } : {}),
        ...(body.dueDate ? { dueDate: body.dueDate as DateOnly } : {}),
      }),
    );
  }

  @RequirePermission('billing.invoice:write')
  @Post('invoices/:id/issue')
  async issueInvoice(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.billing.issueInvoice(id));
  }

  /**
   * `dependants` narrows to the caller's OWN children's invoices via
   * `studentPersonIds`, enforced in `InvoiceService.listInvoices`'s SQL
   * `WHERE` clause - a caller-supplied `studentPersonId` outside that set is
   * rejected outright rather than silently ignored, so a parent cannot probe
   * another family's invoices by guessing an id in the query string.
   */
  @RequirePermission('billing.invoice:read')
  @Get('invoices')
  async listInvoices(@Query('studentPersonId') studentPersonId?: string, @Query('payerPersonId') payerPersonId?: string, @Query('status') status?: string) {
    const constraint = await this.resolveConstraint('billing.invoice:read');
    const base = {
      ...(payerPersonId ? { payerPersonId: payerPersonId as PersonId } : {}),
      ...(status ? { status: status as InvoiceStatus } : {}),
    };

    if (constraint.kind === 'tenant') {
      return this.billing.listInvoices({ ...base, ...(studentPersonId ? { studentPersonId: studentPersonId as PersonId } : {}) });
    }
    if (constraint.kind === 'dependants') {
      if (studentPersonId && !constraint.personIds.includes(studentPersonId as PersonId)) {
        throw new ForbiddenError(`You do not have access to person ${studentPersonId}'s invoices.`);
      }
      const studentPersonIds = studentPersonId ? [studentPersonId as PersonId] : constraint.personIds;
      return this.billing.listInvoices({ ...base, studentPersonIds });
    }
    if (constraint.kind === 'own' && constraint.personId) {
      if (studentPersonId && studentPersonId !== constraint.personId) {
        throw new ForbiddenError(`You do not have access to person ${studentPersonId}'s invoices.`);
      }
      return this.billing.listInvoices({ ...base, studentPersonId: constraint.personId });
    }
    return [];
  }

  @RequirePermission('billing.invoice:read')
  @Get('invoices/:id')
  async getInvoice(@Param('id', ParseUUIDPipe) id: string) {
    const context = await this.billing.getInvoiceContext(id);
    if (!context) {
      throw new ForbiddenError(`Invoice ${id} not found.`);
    }
    await this.assertInvoiceAccess(context, 'billing.invoice:read');
    return unwrap(await this.billing.getInvoice(id));
  }

  @RequirePermission('billing.invoice:read')
  @Get('invoices/:id/balance')
  async getInvoiceBalance(@Param('id', ParseUUIDPipe) id: string) {
    const context = await this.billing.getInvoiceContext(id);
    if (!context) {
      throw new ForbiddenError(`Invoice ${id} not found.`);
    }
    await this.assertInvoiceAccess(context, 'billing.invoice:read');
    return unwrap(await this.billing.getInvoiceBalance(id));
  }

  @RequirePermission('billing.invoice:read')
  @Get('invoices/:id/credit-notes')
  async listCreditNotesForInvoice(@Param('id', ParseUUIDPipe) id: string) {
    const context = await this.billing.getInvoiceContext(id);
    if (!context) {
      throw new ForbiddenError(`Invoice ${id} not found.`);
    }
    await this.assertInvoiceAccess(context, 'billing.invoice:read');
    return this.billing.listCreditNotes(id);
  }

  @RequirePermission('billing.invoice:read')
  @Get('students/:personId/balance')
  async getAccountBalance(@Param('personId', ParseUUIDPipe) personId: string) {
    await this.assertStudentAccess(personId as PersonId, 'billing.invoice:read');
    return this.billing.getAccountBalance(personId as PersonId);
  }

  /**
   * Tenant-level totals for the finance dashboard card, or - for a
   * `dependants`-scoped caller (a guardian) - the SAME totals narrowed to
   * their own children, via `GetBillingSummaryInput.studentPersonIds`. This
   * mirrors `listInvoices` exactly: the constraint is applied by passing the
   * resolved id set into the query (`InvoiceService.getBillingSummary`'s SQL
   * `WHERE ... in (...)`), never by fetching every invoice and filtering the
   * response - see this file's own top-of-file comment on why that
   * distinction matters most for this module. `campus`/`section`/`none`
   * constraints (never actually granted for `billing.invoice:read` - see
   * `@sms/access`'s `seed.ts` - but not this controller's job to assume that
   * forever) resolve to `studentPersonIds: []`, which
   * `InvoiceService.getBillingSummary` short-circuits to the honest empty
   * summary without a query, same as `listInvoices`'s `[]` fallback.
   */
  @RequirePermission('billing.invoice:read')
  @Get('summary')
  async getBillingSummary() {
    const constraint = await this.resolveConstraint('billing.invoice:read');
    if (constraint.kind === 'tenant') {
      return this.billing.getBillingSummary({});
    }
    if (constraint.kind === 'dependants') {
      return this.billing.getBillingSummary({ studentPersonIds: constraint.personIds });
    }
    if (constraint.kind === 'own' && constraint.personId) {
      return this.billing.getBillingSummary({ studentPersonId: constraint.personId });
    }
    return this.billing.getBillingSummary({ studentPersonIds: [] });
  }

  // ---------------------------------------------------------------------
  // Payments - finance-only, no parent-facing scope to narrow (see this
  // file's top-of-file comment).
  // ---------------------------------------------------------------------

  @RequirePermission('billing.payment:record')
  @Post('payments')
  async recordPayment(@Body(new ZodValidationPipe(RecordPaymentDto)) body: RecordPaymentDto) {
    return unwrap(
      await this.billing.recordPayment({
        payerPersonId: body.payerPersonId as PersonId,
        amountMinor: body.amountMinor,
        currency: body.currency,
        idempotencyKey: body.idempotencyKey,
        allocations: body.allocations,
        ...(body.method ? { method: body.method } : {}),
      }),
    );
  }

  @RequirePermission('billing.payment:record')
  @Get('payments')
  listPayments(@Query('payerPersonId') payerPersonId?: string) {
    return this.billing.listPayments(payerPersonId ? { payerPersonId: payerPersonId as PersonId } : {});
  }

  @RequirePermission('billing.payment:record')
  @Get('payments/:id')
  async getPayment(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.billing.getPayment(id));
  }

  @RequirePermission('billing.payment:record')
  @Get('payers/:personId/credit')
  getPayerCredit(@Param('personId', ParseUUIDPipe) personId: string) {
    return this.billing.getPayerCredit(personId as PersonId);
  }

  // ---------------------------------------------------------------------
  // Credit notes - finance-only, no parent-facing scope to narrow.
  //
  // issueCreditNote's response shape depends on whether it was gated - see
  // `IssueCreditNoteResult`'s own doc comment: `{ status: 'issued',
  // creditNote }` when applied immediately (no policy configured, or under
  // threshold - unchanged from before the approvals pilot existed), or
  // `{ status: 'pending_approval', approvalRequestId }` when held for
  // sign-off. Either way this route stays gated on `billing.credit_note:issue`
  // alone - the SAME permission a `credit_note_approval_policy` names as the
  // one that may DECIDE a pending request (see the credit-note-approval-policy
  // routes below), so raising one and approving one both require it; the
  // engine's own requester-cannot-decide-their-own-request rule is what
  // actually stops one person from doing both to the SAME request - see
  // @sms/approvals' 1700 migration header.
  // ---------------------------------------------------------------------

  @RequirePermission('billing.credit_note:issue')
  @Post('credit-notes')
  async issueCreditNote(@Body(new ZodValidationPipe(IssueCreditNoteDto)) body: IssueCreditNoteDto) {
    return unwrap(await this.billing.issueCreditNote(body));
  }

  @RequirePermission('billing.credit_note:issue')
  @Get('credit-notes/:id')
  async getCreditNote(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.billing.getCreditNote(id));
  }

  // ---------------------------------------------------------------------
  // Credit-note approval policy (the pilot's ONE piece of domain-specific
  // configuration - see the `1401` migration header). Gated on the same
  // permission as issuing a credit note: configuring "above what amount"
  // requires the same authority as issuing one at all.
  // ---------------------------------------------------------------------

  @RequirePermission('billing.credit_note:issue')
  @Post('credit-note-approval-policy')
  async setCreditNoteApprovalPolicy(@Body(new ZodValidationPipe(SetCreditNoteApprovalPolicyDto)) body: SetCreditNoteApprovalPolicyDto) {
    return unwrap(await this.billing.setCreditNoteApprovalPolicy(body));
  }

  @RequirePermission('billing.credit_note:issue')
  @Get('credit-note-approval-policy')
  listCreditNoteApprovalPolicies() {
    return this.billing.listCreditNoteApprovalPolicies();
  }

  // ---------------------------------------------------------------------
  // Scope-constraint helpers - the data-filtering half `@RequirePermission`
  // cannot do on its own (see this file's top-of-file comment).
  // ---------------------------------------------------------------------

  private async resolveConstraint(permissionKey: string): Promise<ScopeConstraint> {
    const ctx = requireContext();
    if (isSystemContext(ctx) || !ctx.userId) {
      throw new ForbiddenError('No authenticated tenant context is resolved for this request.');
    }
    const constraints = await this.access.resolveScopeConstraints(ctx.userId, ctx.tenantId);
    return constraints[permissionKey] ?? { kind: 'none' };
  }

  /**
   * Authorizes a request against a SPECIFIC invoice, given its
   * `studentPersonId`/`payerPersonId` - not just "may this user touch
   * invoices at all". A `dependants` constraint is checked ONLY against
   * `studentPersonId` (see this file's top-of-file comment) - never
   * `payerPersonId`, and never both ORed together in a way that would let a
   * payer-only relationship stand in for the dependants grant.
   */
  private async assertInvoiceAccess(context: InvoiceContext, permissionKey: string): Promise<void> {
    const constraint = await this.resolveConstraint(permissionKey);
    if (constraint.kind === 'tenant') return;
    if (constraint.kind === 'own' && constraint.personId === context.studentPersonId) return;
    if (constraint.kind === 'dependants' && constraint.personIds.includes(context.studentPersonId)) return;
    throw new ForbiddenError('You do not have access to this invoice.');
  }

  /** Authorizes a request against a specific student's account balance, for a `dependants`-scoped caller (a guardian) by checking whether the student is one of THEIR children, or `own` (the student themselves). */
  private async assertStudentAccess(personId: PersonId, permissionKey: string): Promise<void> {
    const constraint = await this.resolveConstraint(permissionKey);
    if (constraint.kind === 'tenant') return;
    if (constraint.kind === 'own' && constraint.personId === personId) return;
    if (constraint.kind === 'dependants' && constraint.personIds.includes(personId)) return;
    throw new ForbiddenError(`You do not have access to person ${personId}'s account balance.`);
  }
}
