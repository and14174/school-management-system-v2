import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Global, Injectable, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ForbiddenError, newId, type AcademicYearId, type DateOnly, type PersonId, type TenantId, type UserId } from '@sms/kernel';
import { closeSqlClients, createSqlClient, runWithContext, withTenantTx, type Sql } from '@sms/db';
import {
  ACCESS_CONTRACT,
  AccessModule,
  DEPENDANT_SCOPE_RESOLVER,
  PERMISSION_CATALOGUE,
  type AccessContract,
  type DependantScopeResolver,
} from '@sms/access';
import { BILLING_CONTRACT, type BillingContract } from './contract.js';
import { BillingController } from './api/billing.controller.js';
import { BillingModule } from './api/billing.module.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// ---------------------------------------------------------------------------
// A minimal, real DEPENDANT_SCOPE_RESOLVER for this test module - the
// default the port ships with resolves to nothing (see
// docs/decisions.md's "Unresolvable permission scopes deny, never widen"),
// so a `dependants`-scoped grant would silently return zero rows without
// this. Duplicated from `apps/api`'s `DependantScopeResolverModule` rather
// than imported (that module lives in `type:app`, unreachable from this
// `type:domain` package's tests) - same `userId -> membership.person_id ->
// people.relationship` walk.
// ---------------------------------------------------------------------------
@Injectable()
class TestDependantScopeResolver implements DependantScopeResolver {
  async resolveDependantPersonIds(userId: UserId, tenantId: TenantId): Promise<PersonId[]> {
    const rows = await withTenantTx({ tenantId, roles: [], requestId: newId() }, (db) =>
      db.execute<{ to_person_id: string }>(sql`
        select distinct r.to_person_id
        from people.relationship r
        join identity.membership m on m.person_id = r.from_person_id and m.tenant_id = r.tenant_id
        where r.tenant_id = ${tenantId} and m.user_id = ${userId} and r.type in ('parent', 'guardian')
      `),
    );
    return (rows as unknown as Array<{ to_person_id: string }>).map((row) => row.to_person_id as PersonId);
  }
}

@Global()
@Module({
  providers: [TestDependantScopeResolver, { provide: DEPENDANT_SCOPE_RESOLVER, useExisting: TestDependantScopeResolver }],
  exports: [DEPENDANT_SCOPE_RESOLVER],
})
class TestDependantScopeResolverModule {}

/**
 * Applies the real `audit` + `tenancy` + `identity` + `access` + `people` +
 * `outbox` migrations (read, never edited - see the module report's
 * constraints) and this module's own `1400` migration to a throwaway
 * container, then proves - through the real application services and the
 * real `BillingController`/`BillingService`, built via Nest DI exactly like
 * `apps/api` wires it - the properties this module exists for.
 */
describe('billing (real Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: Sql;
  let moduleRef: TestingModule;
  let access: AccessContract;
  let billing: BillingContract;
  let billingController: BillingController;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('sms_test').withUsername('sms_owner').withPassword('dev').start();

    const ownerUrl = container.getConnectionUri();
    ownerSql = createSqlClient(ownerUrl);

    await ownerSql`create role sms_app with login password 'dev' nobypassrls`;
    await ownerSql`grant connect on database sms_test to sms_app`;

    // Read each module's migrations folder rather than naming files - see
    // docs/decisions.md's "Test specs must read their module's migrations
    // folder, not name files."
    const applyMigrations = async (dir: string): Promise<void> => {
      const files = readdirSync(dir)
        .filter((name) => name.endsWith('.sql'))
        .sort((a, b) => a.localeCompare(b, 'en'));
      for (const file of files) {
        await ownerSql.unsafe(readFileSync(join(dir, file), 'utf8'));
      }
    };

    await applyMigrations(join(__dirname, '..', '..', '..', 'platform', 'audit', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', '..', 'platform', 'tenancy', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', '..', 'platform', 'identity', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', '..', 'platform', 'access', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', '..', 'domain', 'people', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', '..', 'platform', 'outbox', 'migrations'));
    await applyMigrations(join(__dirname, '..', 'migrations'));

    const appUrl = new URL(ownerUrl);
    appUrl.username = 'sms_app';
    appUrl.password = 'dev';

    process.env.DATABASE_URL = appUrl.toString();
    process.env.DATABASE_MIGRATION_URL = ownerUrl;

    moduleRef = await Test.createTestingModule({
      imports: [AccessModule, TestDependantScopeResolverModule, BillingModule],
    }).compile();
    access = moduleRef.get(ACCESS_CONTRACT);
    billing = moduleRef.get(BILLING_CONTRACT);
    billingController = moduleRef.get(BillingController);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await closeSqlClients();
    await ownerSql?.end({ timeout: 1 });
    await container?.stop();
  });

  // ---------------------------------------------------------------------
  // Fixture helpers - raw SQL against ownerSql (bypasses RLS, as sms_owner),
  // same precedent as @sms/records'/@sms/communications' own spec helpers.
  // ---------------------------------------------------------------------
  async function createTenant(slug: string, name: string): Promise<TenantId> {
    const rows = await ownerSql`insert into tenancy.tenant (slug, name) values (${slug}, ${name}) returning id`;
    return (rows[0] as { id: string }).id as TenantId;
  }

  async function createAcademicYear(tenantId: TenantId): Promise<AcademicYearId> {
    const rows = await ownerSql`
      insert into tenancy.academic_year (tenant_id, name, starts_on, ends_on, status)
      values (${tenantId}, ${'AY-' + newId()}, '2020-01-01', '2035-01-01', 'open')
      returning id
    `;
    return (rows[0] as { id: string }).id as AcademicYearId;
  }

  async function createPerson(tenantId: TenantId, givenName: string, familyName: string): Promise<PersonId> {
    const rows = await ownerSql`
      insert into people.person (id, tenant_id, given_name, family_name) values (${newId()}, ${tenantId}, ${givenName}, ${familyName}) returning id
    `;
    return (rows[0] as { id: string }).id as PersonId;
  }

  async function createUser(email: string): Promise<UserId> {
    const rows = await ownerSql`insert into identity.user (id, name, email) values (${newId()}, ${email}, ${email}) returning id`;
    return (rows[0] as { id: string }).id as UserId;
  }

  async function createMembership(tenantId: TenantId, userId: UserId, personId?: PersonId): Promise<void> {
    await ownerSql`
      insert into identity.membership (id, tenant_id, user_id, person_id, status)
      values (${newId()}, ${tenantId}, ${userId}, ${personId ?? null}, 'active')
    `;
  }

  async function createGuardianRelationship(tenantId: TenantId, guardianPersonId: PersonId, childPersonId: PersonId): Promise<void> {
    await ownerSql`
      insert into people.relationship (id, tenant_id, from_person_id, to_person_id, type)
      values (${newId()}, ${tenantId}, ${guardianPersonId}, ${childPersonId}, 'parent')
    `;
  }

  async function seedPermissionCatalogue(): Promise<void> {
    for (const def of PERMISSION_CATALOGUE) {
      await ownerSql`
        insert into access.permission (id, key, resource, action, description)
        values (${newId()}, ${def.key}, ${def.resource}, ${def.action}, ${def.description})
        on conflict (key) do nothing
      `;
    }
  }

  async function grantScopedRole(tenantId: TenantId, userId: UserId, permissionKey: string, scope: string): Promise<void> {
    const roleId = newId();
    await ownerSql`insert into access.role (id, tenant_id, key, name) values (${roleId}, ${tenantId}, ${'role-' + roleId}, 'Test role')`;
    const permissionRows = await ownerSql`select id from access.permission where key = ${permissionKey} limit 1`;
    const permissionId = (permissionRows[0] as { id: string }).id;
    await ownerSql`insert into access.role_permission (id, role_id, permission_id, scope, tenant_id) values (${newId()}, ${roleId}, ${permissionId}, ${scope}, ${tenantId})`;
    await ownerSql`insert into access.role_assignment (id, tenant_id, role_id, user_id) values (${newId()}, ${tenantId}, ${roleId}, ${userId})`;
  }

  function baseCtx(tenantId: TenantId, userId?: UserId, personId?: PersonId): { tenantId: TenantId; userId?: UserId; actorUserId?: UserId; personId?: PersonId; roles: string[]; requestId: string } {
    return { tenantId, ...(userId ? { userId, actorUserId: userId } : {}), ...(personId ? { personId } : {}), roles: [], requestId: newId() };
  }

  /** Publishes a fee schedule with one $500.00 "Tuition" component, through the REAL `BillingContract`. */
  async function publishTuitionFeeSchedule(ctx: ReturnType<typeof baseCtx>, academicYearId: AcademicYearId, amountMinor = 50_000) {
    return runWithContext(ctx, async () => {
      const schedule = await billing.createFeeSchedule({ name: `Fees-${newId()}`, academicYearId });
      if (!schedule.ok) throw schedule.error;
      const version = await billing.publishFeeScheduleVersion({
        feeScheduleId: schedule.value.id,
        currency: 'USD',
        components: [{ code: 'TUITION', name: 'Tuition', amountMinor }],
      });
      if (!version.ok) throw version.error;
      return version.value;
    });
  }

  /** Creates and issues an invoice for `studentPersonId`, priced from every component in `feeScheduleVersion`. */
  async function issueInvoiceFor(
    ctx: ReturnType<typeof baseCtx>,
    studentPersonId: PersonId,
    feeScheduleVersion: Awaited<ReturnType<typeof publishTuitionFeeSchedule>>,
    payerPersonId?: PersonId,
  ) {
    return runWithContext(ctx, async () => {
      const created = await billing.createInvoice({
        studentPersonId,
        currency: feeScheduleVersion.currency,
        feeComponentIds: feeScheduleVersion.components.map((c) => c.id),
        ...(payerPersonId ? { payerPersonId } : {}),
      });
      if (!created.ok) throw created.error;
      const issued = await billing.issueInvoice(created.value.id);
      if (!issued.ok) throw issued.error;
      return created.value;
    });
  }

  // ---------------------------------------------------------------------
  // 1. RLS isolates billing records across tenants.
  // ---------------------------------------------------------------------
  it('1. RLS isolates billing records across tenants', async () => {
    const tenantX = await createTenant('tenant-billing-rls-x', 'Billing RLS X');
    const tenantY = await createTenant('tenant-billing-rls-y', 'Billing RLS Y');
    const yearX = await createAcademicYear(tenantX);
    const ctxX = baseCtx(tenantX);
    const studentX = await createPerson(tenantX, 'RLS', 'StudentX');

    const version = await publishTuitionFeeSchedule(ctxX, yearX);
    const invoice = await issueInvoiceFor(ctxX, studentX, version);

    const invoicesFromY = await runWithContext(baseCtx(tenantY), () => billing.listInvoices({}));
    expect(invoicesFromY).toHaveLength(0);
    const schedulesFromY = await runWithContext(baseCtx(tenantY), () => billing.listFeeSchedules());
    expect(schedulesFromY).toHaveLength(0);

    const invoicesFromX = await runWithContext(ctxX, () => billing.listInvoices({}));
    expect(invoicesFromX.map((i) => i.id)).toContain(invoice.id);

    // Directly against the tables too, as the ordinary sms_app role with NO
    // app.tenant_id GUC set - rules out an application-level filter doing
    // the work RLS is supposed to.
    const appSqlNoContext = createSqlClient(process.env.DATABASE_URL!);
    try {
      const invoiceRows = await appSqlNoContext`select id from billing.invoice where tenant_id = ${tenantX}`;
      expect(invoiceRows.length).toBe(0);
      const scheduleRows = await appSqlNoContext`select id from billing.fee_schedule where tenant_id = ${tenantX}`;
      expect(scheduleRows.length).toBe(0);
    } finally {
      await appSqlNoContext.end({ timeout: 1 });
    }
  });

  // ---------------------------------------------------------------------
  // 2. An issued invoice cannot be mutated even by the table owner.
  // ---------------------------------------------------------------------
  it('2. an issued invoice cannot be mutated even by the table owner', async () => {
    const tenantId = await createTenant('tenant-billing-immutable', 'Billing Immutable');
    const yearId = await createAcademicYear(tenantId);
    const ctx = baseCtx(tenantId);
    const student = await createPerson(tenantId, 'Immutable', 'Student');

    const version = await publishTuitionFeeSchedule(ctx, yearId);
    const invoice = await issueInvoiceFor(ctx, student, version);
    const lineId = invoice.lines[0]!.id;

    // The invoice row itself: identity fields (here, currency) are refused
    // once issued - trg_forbid_invoice_mutation.
    await expect(ownerSql`update billing.invoice set currency = 'EUR' where id = ${invoice.id}`).rejects.toThrow();

    // The lines that actually carry the amounts: UPDATE, DELETE and even
    // INSERT are all refused once the parent invoice is issued -
    // trg_forbid_invoice_line_mutation.
    await expect(ownerSql`update billing.invoice_line set amount_minor = 999999 where id = ${lineId}`).rejects.toThrow();
    await expect(ownerSql`delete from billing.invoice_line where id = ${lineId}`).rejects.toThrow();
    await expect(ownerSql`
      insert into billing.invoice_line (id, tenant_id, invoice_id, fee_component_id, fee_schedule_version_id, description, amount_minor)
      values (${newId()}, ${tenantId}, ${invoice.id}, ${version.components[0]!.id}, ${version.id}, 'Smuggled line', 1)
    `).rejects.toThrow();

    // Genuinely unchanged after every rejected attempt.
    const invoiceRows = await ownerSql`select currency from billing.invoice where id = ${invoice.id}`;
    expect((invoiceRows[0] as { currency: string }).currency).toBe('USD');
    const lineRows = await ownerSql`select amount_minor from billing.invoice_line where id = ${lineId}`;
    expect(Number((lineRows[0] as { amount_minor: string | number }).amount_minor)).toBe(50_000);
    const lineCountRows = await ownerSql`select count(*) as n from billing.invoice_line where invoice_id = ${invoice.id}`;
    expect(Number((lineCountRows[0] as { n: string }).n)).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 3. HEADLINE: the same idempotency key recorded twice yields ONE payment
  //    and one balance effect.
  // ---------------------------------------------------------------------
  it('3. the same idempotency key recorded twice yields ONE payment and one balance effect', async () => {
    const tenantId = await createTenant('tenant-billing-idempotent', 'Billing Idempotent');
    const yearId = await createAcademicYear(tenantId);
    const ctx = baseCtx(tenantId);
    const student = await createPerson(tenantId, 'Idempotent', 'Student');
    const payer = await createPerson(tenantId, 'Idempotent', 'Payer');

    const version = await publishTuitionFeeSchedule(ctx, yearId);
    const invoice = await issueInvoiceFor(ctx, student, version, payer);

    const idempotencyKey = `pay-${newId()}`;
    const input = { payerPersonId: payer, amountMinor: 20_000, currency: 'USD', idempotencyKey, allocations: [{ invoiceId: invoice.id, amountMinor: 20_000 }] };

    const first = await runWithContext(ctx, () => billing.recordPayment(input));
    if (!first.ok) throw first.error;
    expect(first.value.replayed).toBe(false);

    const second = await runWithContext(ctx, () => billing.recordPayment(input));
    if (!second.ok) throw second.error;
    expect(second.value.replayed).toBe(true);
    expect(second.value.payment.id).toBe(first.value.payment.id);

    const paymentRows = await ownerSql`select id from billing.payment where tenant_id = ${tenantId}`;
    expect(paymentRows).toHaveLength(1);
    const allocationRows = await ownerSql`select amount_minor from billing.payment_allocation where tenant_id = ${tenantId}`;
    expect(allocationRows).toHaveLength(1);

    // One balance effect, not two: 20,000 paid, not 40,000.
    const balance = await runWithContext(ctx, () => billing.getInvoiceBalance(invoice.id));
    if (!balance.ok) throw balance.error;
    expect(balance.value.paidMinor).toBe(20_000);
    expect(balance.value.balanceMinor).toBe(50_000 - 20_000);
  });

  // ---------------------------------------------------------------------
  // 4. Balance is computed correctly across charge + partial payment +
  //    credit note.
  // ---------------------------------------------------------------------
  it('4. balance is computed correctly across charge + partial payment + credit note', async () => {
    const tenantId = await createTenant('tenant-billing-balance', 'Billing Balance');
    const yearId = await createAcademicYear(tenantId);
    const ctx = baseCtx(tenantId);
    const student = await createPerson(tenantId, 'Balance', 'Student');
    const payer = await createPerson(tenantId, 'Balance', 'Payer');

    const version = await publishTuitionFeeSchedule(ctx, yearId, 100_000); // $1,000.00 charge
    const invoice = await issueInvoiceFor(ctx, student, version, payer);

    // Partial payment of $300.00.
    const paid = await runWithContext(ctx, () =>
      billing.recordPayment({
        payerPersonId: payer,
        amountMinor: 30_000,
        currency: 'USD',
        idempotencyKey: `pay-${newId()}`,
        allocations: [{ invoiceId: invoice.id, amountMinor: 30_000 }],
      }),
    );
    if (!paid.ok) throw paid.error;

    // A $150.00 credit note against the one line.
    const credited = await runWithContext(ctx, () =>
      billing.issueCreditNote({
        invoiceId: invoice.id,
        reason: 'Test adjustment',
        lines: [{ invoiceLineId: invoice.lines[0]!.id, description: 'Adjustment', amountMinor: 15_000 }],
      }),
    );
    if (!credited.ok) throw credited.error;

    const balance = await runWithContext(ctx, () => billing.getInvoiceBalance(invoice.id));
    if (!balance.ok) throw balance.error;
    expect(balance.value.chargesMinor).toBe(100_000);
    expect(balance.value.paidMinor).toBe(30_000);
    expect(balance.value.creditedMinor).toBe(15_000);
    expect(balance.value.balanceMinor).toBe(100_000 - 30_000 - 15_000); // 55,000

    // The account-level balance (summed across this student's issued
    // invoices) agrees with the single-invoice figure - there is only one.
    const accountBalances = await runWithContext(ctx, () => billing.getAccountBalance(student));
    const usdAccount = accountBalances.find((b) => b.currency === 'USD')!;
    expect(usdAccount.balanceMinor).toBe(55_000);
  });

  // ---------------------------------------------------------------------
  // 5. Over-payment leaves credit rather than a negative invoice.
  // ---------------------------------------------------------------------
  it('5. over-payment leaves credit rather than a negative invoice', async () => {
    const tenantId = await createTenant('tenant-billing-overpay', 'Billing Overpay');
    const yearId = await createAcademicYear(tenantId);
    const ctx = baseCtx(tenantId);
    const student = await createPerson(tenantId, 'Overpay', 'Student');
    const payer = await createPerson(tenantId, 'Overpay', 'Payer');

    const version = await publishTuitionFeeSchedule(ctx, yearId, 10_000); // $100.00 charge
    const invoice = await issueInvoiceFor(ctx, student, version, payer);

    // Pays $150.00 but only allocates the $100.00 actually owed - the
    // remaining $50.00 is never forced onto the invoice.
    const paid = await runWithContext(ctx, () =>
      billing.recordPayment({
        payerPersonId: payer,
        amountMinor: 15_000,
        currency: 'USD',
        idempotencyKey: `pay-${newId()}`,
        allocations: [{ invoiceId: invoice.id, amountMinor: 10_000 }],
      }),
    );
    if (!paid.ok) throw paid.error;

    const balance = await runWithContext(ctx, () => billing.getInvoiceBalance(invoice.id));
    if (!balance.ok) throw balance.error;
    expect(balance.value.balanceMinor).toBe(0); // exactly settled, never negative

    const credit = await runWithContext(ctx, () => billing.getPayerCredit(payer));
    const usdCredit = credit.find((c) => c.currency === 'USD')!;
    expect(usdCredit.creditMinor).toBe(5_000); // the $50.00 unapplied remainder

    // And the service refuses to let allocations exceed the payment amount
    // outright - an over-allocation is a validation error, not a route to a
    // negative invoice.
    const overAllocated = await runWithContext(ctx, () =>
      billing.recordPayment({
        payerPersonId: payer,
        amountMinor: 1_000,
        currency: 'USD',
        idempotencyKey: `pay-${newId()}`,
        allocations: [{ invoiceId: invoice.id, amountMinor: 5_000 }],
      }),
    );
    expect(overAllocated.ok).toBe(false);
  });

  // ---------------------------------------------------------------------
  // 6. HEADLINE: a dependants-scoped caller sees only their own children's
  //    invoices - through the real BillingController, filtered in the
  //    query (never fetch-then-filter, see BillingController's own
  //    top-of-file comment).
  // ---------------------------------------------------------------------
  it('6. a dependants-scoped caller sees only their own children\'s invoices', async () => {
    const tenantId = await createTenant('tenant-billing-dependants', 'Billing Dependants');
    const yearId = await createAcademicYear(tenantId);
    const ctx = baseCtx(tenantId);

    const guardianPerson = await createPerson(tenantId, 'Rosa', 'Guardian');
    const childA = await createPerson(tenantId, 'Mateo', 'Child');
    const childB = await createPerson(tenantId, 'Sofia', 'Child');
    const otherStudent = await createPerson(tenantId, 'Someone', 'Else');
    await createGuardianRelationship(tenantId, guardianPerson, childA);
    await createGuardianRelationship(tenantId, guardianPerson, childB);

    const version = await publishTuitionFeeSchedule(ctx, yearId);
    const invoiceA = await issueInvoiceFor(ctx, childA, version, guardianPerson);
    const invoiceB = await issueInvoiceFor(ctx, childB, version, guardianPerson);
    const invoiceOther = await issueInvoiceFor(ctx, otherStudent, version);

    await seedPermissionCatalogue();
    const guardianUserId = await createUser(`guardian-${newId()}@example.com`);
    await createMembership(tenantId, guardianUserId, guardianPerson);
    await grantScopedRole(tenantId, guardianUserId, 'billing.invoice:read', 'dependants');

    const constraints = await access.resolveScopeConstraints(guardianUserId, tenantId);
    const constraint = constraints['billing.invoice:read'];
    expect(constraint?.kind).toBe('dependants');
    if (constraint?.kind === 'dependants') {
      expect([...constraint.personIds].sort()).toEqual([childA, childB].sort());
    }

    const guardianCtx = baseCtx(tenantId, guardianUserId, guardianPerson);

    // The list endpoint, through the real controller: exactly the two
    // children's invoices, never the unrelated third-party student's.
    const visible = await runWithContext(guardianCtx, () => billingController.listInvoices());
    const visibleIds = visible.map((invoice) => invoice.id).sort();
    expect(visibleIds).toEqual([invoiceA.id, invoiceB.id].sort());
    expect(visibleIds).not.toContain(invoiceOther.id);

    // A single-record read of their own child's invoice succeeds...
    const ownChild = await runWithContext(guardianCtx, () => billingController.getInvoice(invoiceA.id));
    expect(ownChild.id).toBe(invoiceA.id);

    // ...and of another family's invoice is denied outright, not silently
    // filtered - fetching by id must not be a back door around the list
    // constraint.
    await expect(runWithContext(guardianCtx, () => billingController.getInvoice(invoiceOther.id))).rejects.toThrow(ForbiddenError);

    // Passing another family's id in the query string is rejected too -
    // never silently ignored, never silently honoured.
    await expect(runWithContext(guardianCtx, () => billingController.listInvoices(invoiceOther.studentPersonId))).rejects.toThrow(ForbiddenError);
  });

  // ---------------------------------------------------------------------
  // 7. HEADLINE: GET /billing/summary for a dependants-scoped caller covers
  //    ONLY their own children - aggregated in SQL with the constraint
  //    applied in the query, never fetch-then-filter (BillingController's
  //    own top-of-file comment; InvoiceService.getBillingSummary).
  // ---------------------------------------------------------------------
  it("7. a dependants-scoped caller's billing summary covers only their own children", async () => {
    const tenantId = await createTenant('tenant-billing-summary', 'Billing Summary');
    const yearId = await createAcademicYear(tenantId);
    const ctx = baseCtx(tenantId);

    const guardianPerson = await createPerson(tenantId, 'Rosa', 'Guardian');
    const childA = await createPerson(tenantId, 'Mateo', 'Child');
    const childB = await createPerson(tenantId, 'Sofia', 'Child');
    const otherStudent = await createPerson(tenantId, 'Someone', 'Else');
    await createGuardianRelationship(tenantId, guardianPerson, childA);
    await createGuardianRelationship(tenantId, guardianPerson, childB);

    const version = await publishTuitionFeeSchedule(ctx, yearId, 50_000); // $500.00 per invoice
    const feeComponentIds = version.components.map((c) => c.id);

    async function createAndIssue(studentPersonId: PersonId, dueDate: DateOnly | undefined, payerPersonId?: PersonId) {
      return runWithContext(ctx, async () => {
        const created = await billing.createInvoice({
          studentPersonId,
          currency: version.currency,
          feeComponentIds,
          ...(payerPersonId ? { payerPersonId } : {}),
          ...(dueDate ? { dueDate } : {}),
        });
        if (!created.ok) throw created.error;
        const issued = await billing.issueInvoice(created.value.id);
        if (!issued.ok) throw issued.error;
        return created.value;
      });
    }

    // childA: overdue (due date long past) and entirely unpaid - owes the
    // full 50,000.
    await createAndIssue(childA, '2000-01-01' as DateOnly, guardianPerson);

    // childB: not overdue, partially paid - owes 50,000 - 20,000 = 30,000.
    const invoiceB = await createAndIssue(childB, undefined, guardianPerson);
    await runWithContext(ctx, () =>
      billing.recordPayment({
        payerPersonId: guardianPerson,
        amountMinor: 20_000,
        currency: version.currency,
        idempotencyKey: `pay-${newId()}`,
        allocations: [{ invoiceId: invoiceB.id, amountMinor: 20_000 }],
      }),
    );

    // An unrelated family's invoice - also overdue, also unpaid - proves
    // this never leaks into the guardian's totals below.
    await createAndIssue(otherStudent, '2000-01-01' as DateOnly);

    await seedPermissionCatalogue();
    const guardianUserId = await createUser(`guardian-${newId()}@example.com`);
    await createMembership(tenantId, guardianUserId, guardianPerson);
    await grantScopedRole(tenantId, guardianUserId, 'billing.invoice:read', 'dependants');
    const guardianCtx = baseCtx(tenantId, guardianUserId, guardianPerson);

    const summary = await runWithContext(guardianCtx, () => billingController.getBillingSummary());
    expect(summary.currency).toBe('USD');
    // Own children only: 50,000 (childA, unpaid) + 30,000 (childB, partial) = 80,000 - the OTHER family's 50,000 is not added on top.
    expect(summary.outstandingMinor).toBe(80_000);
    // Only childA's invoice is overdue - the other family's overdue invoice must not be counted.
    expect(summary.overdueInvoiceCount).toBe(1);
    expect(summary.collectedMinor).toBe(20_000);
    expect(summary.collectedWindowDays).toBeGreaterThan(0);

    // Cross-check against a tenant-scoped (finance) read of the SAME
    // underlying data: it DOES include the third family's invoice, proving
    // the difference above is the scope narrowing, not some other
    // discrepancy in the aggregation itself.
    const financeUserId = await createUser(`finance-${newId()}@example.com`);
    await grantScopedRole(tenantId, financeUserId, 'billing.invoice:read', 'tenant');
    const financeCtx = baseCtx(tenantId, financeUserId);
    const financeSummary = await runWithContext(financeCtx, () => billingController.getBillingSummary());
    expect(financeSummary.outstandingMinor).toBe(80_000 + 50_000);
    expect(financeSummary.overdueInvoiceCount).toBe(2);
  });
});
