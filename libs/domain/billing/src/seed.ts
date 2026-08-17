#!/usr/bin/env tsx
/**
 * Idempotent local-dev/CI seed data: a fee schedule for the current academic
 * year (computed relative to today, never hardcoded - see
 * `docs/decisions.md`'s "Seed data is computed relative to today"), one
 * published version with a handful of realistic components, and issued
 * invoices for a real mix of currently-enrolled students - some fully paid,
 * one part-paid, one overdue, one with a credit note. Every total here is
 * derived from the rows this script itself writes (fee_component amounts,
 * summed line-by-line into what gets paid/credited) - never a number typed
 * in independently of what was actually charged.
 *
 * `parent@greenwood.test` (Rosa Alvarez, per the demo login's current
 * `pickPredicate` - see `@sms/access`'s `seed-demo-logins.ts`) is looked up
 * BY THAT LOGIN, not by a hardcoded name: her children are resolved via
 * `people.relationship` and guaranteed at least one issued invoice, because
 * the parent portal renders exactly what that account can see - the same
 * reasoning `@sms/communications`' seed applies to the demo parent's thread.
 *
 * Complements (does not modify - see the module report's constraints)
 * `@sms/tenancy`'s, `@sms/identity`'s, `@sms/access`'s (including
 * `seed-demo-logins.ts`), `@sms/people`'s, `@sms/academic`'s and
 * `@sms/enrollment`'s own `seed.ts`: all must have already run. Runs LAST in
 * `apps/api`'s `db:seed` chain (after `@sms/communications`' seed) for the
 * same reason `communications`' own seed runs after `seed-demo-logins.ts` -
 * see `docs/decisions.md`'s "`db:seed` order is not module order".
 *
 * Usage: tsx src/seed.ts (run after every module listed above).
 */
import 'reflect-metadata';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Test, type TestingModule } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { closeSqlClients, runWithContext, withSystemTx } from '@sms/db';
import { newId, todayDateOnly, type AcademicYearId, type DateOnly, type PersonId, type TenantId, type UserId } from '@sms/kernel';
import { BILLING_CONTRACT, type BillingContract } from './contract.js';
import { BillingModule } from './api/billing.module.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// Resolved relative to this file, not process.cwd() - see @sms/records' seed.ts for the same pattern.
try {
  process.loadEnvFile(join(__dirname, '..', '..', '..', '..', '.env'));
} catch {
  // no .env file present - assume the environment already has what we need
}

const FINANCE_EMAIL = 'finance@greenwood.test';
const PARENT_EMAIL = 'parent@greenwood.test';
const FEE_SCHEDULE_NAME_PREFIX = 'Tuition & Fees';
const CURRENCY = 'USD';

interface ComponentSpec {
  readonly code: string;
  readonly name: string;
  readonly amountMinor: number;
}

const COMPONENTS: readonly ComponentSpec[] = [
  { code: 'TUITION', name: 'Tuition', amountMinor: 4_200_00 },
  { code: 'TECH_FEE', name: 'Technology Fee', amountMinor: 150_00 },
  { code: 'ACTIVITY_FEE', name: 'Activity Fee', amountMinor: 100_00 },
];

async function findGreenwoodTenantId(): Promise<TenantId> {
  const rows = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from tenancy.tenant where slug = 'greenwood' limit 1`));
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) throw new Error('No tenant with slug "greenwood" found. Run @sms/tenancy\'s seed first.');
  return row.id as TenantId;
}

async function findUserIdByEmail(email: string): Promise<UserId | null> {
  const rows = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from identity.user where email = ${email} limit 1`));
  const row = (rows as unknown as Array<{ id: string }>)[0];
  return row ? (row.id as UserId) : null;
}

type YearRow = { readonly id: string; readonly name: string };

/** The academic year straddling today, same "computed, never hardcoded" posture as the year itself - see `@sms/tenancy`'s own seed and `docs/decisions.md`. */
async function findCurrentAcademicYear(tenantId: TenantId): Promise<YearRow> {
  const rows = await withSystemTx((db) =>
    db.execute<YearRow>(sql`
      select id, name from tenancy.academic_year
      where tenant_id = ${tenantId} and is_current = true
      limit 1
    `),
  );
  const row = (rows as unknown as YearRow[])[0];
  if (row) return row;

  const fallbackRows = await withSystemTx((db) =>
    db.execute<YearRow>(sql`select id, name from tenancy.academic_year where tenant_id = ${tenantId} order by starts_on desc limit 1`),
  );
  const fallback = (fallbackRows as unknown as YearRow[])[0];
  if (!fallback) throw new Error('No academic years found. Run @sms/tenancy\'s seed first.');
  return fallback;
}

type PersonRow = { readonly person_id: string; readonly given_name: string; readonly family_name: string };

/** Every distinct student currently enrolled in a section within `academicYearId` - a real, non-fabricated roster (see `docs/decisions.md`'s "Never render a fabricated figure"). */
async function findEnrolledStudents(tenantId: TenantId, academicYearId: string): Promise<PersonRow[]> {
  const rows = await withSystemTx((db) =>
    db.execute<PersonRow>(sql`
      select distinct p.id as person_id, p.given_name, p.family_name
      from academic.section_enrollment se
      join academic.section sec on sec.id = se.section_id and sec.tenant_id = se.tenant_id
      join academic.term t on t.id = sec.term_id and t.tenant_id = sec.tenant_id
      join people.person p on p.id = se.person_id and p.tenant_id = se.tenant_id
      where se.tenant_id = ${tenantId} and t.academic_year_id = ${academicYearId}
      order by p.family_name, p.given_name
    `),
  );
  return rows as unknown as PersonRow[];
}

/** The person(s) `parent@greenwood.test` is currently linked to are their CHILDREN, resolved via `people.relationship` - never a hardcoded name, see this file's own header. */
async function findParentLoginChildren(tenantId: TenantId): Promise<PersonRow[]> {
  const userId = await findUserIdByEmail(PARENT_EMAIL);
  if (!userId) return [];
  const guardianRows = await withSystemTx((db) =>
    db.execute<{ person_id: string }>(sql`
      select person_id from identity.membership where tenant_id = ${tenantId} and user_id = ${userId} and person_id is not null limit 1
    `),
  );
  const guardianPersonId = (guardianRows as unknown as Array<{ person_id: string }>)[0]?.person_id;
  if (!guardianPersonId) return [];

  const childRows = await withSystemTx((db) =>
    db.execute<PersonRow>(sql`
      select distinct p.id as person_id, p.given_name, p.family_name
      from people.relationship r
      join people.person p on p.id = r.to_person_id and p.tenant_id = r.tenant_id
      where r.tenant_id = ${tenantId} and r.from_person_id = ${guardianPersonId} and r.type in ('parent', 'guardian')
      order by p.family_name, p.given_name
    `),
  );
  return childRows as unknown as PersonRow[];
}

/** The first guardian (`may_receive_comms` or not - billing addressing is not a communications-consent decision) found for `studentPersonId`, if any - used as `payerPersonId` for realism. `null` when the student has none on file (an adult student, or incomplete demo data) - the student themselves is then billed directly. */
async function findGuardianFor(tenantId: TenantId, studentPersonId: string): Promise<PersonId | null> {
  const rows = await withSystemTx((db) =>
    db.execute<{ from_person_id: string }>(sql`
      select from_person_id from people.relationship
      where tenant_id = ${tenantId} and to_person_id = ${studentPersonId} and type in ('parent', 'guardian')
      order by priority
      limit 1
    `),
  );
  const row = (rows as unknown as Array<{ from_person_id: string }>)[0];
  return row ? (row.from_person_id as PersonId) : null;
}

let moduleRef: TestingModule | undefined;

async function main(): Promise<void> {
  const tenantId = await findGreenwoodTenantId();
  const financeUserId = await findUserIdByEmail(FINANCE_EMAIL);
  if (!financeUserId) {
    throw new Error(`No user "${FINANCE_EMAIL}" found. Run @sms/access's seed-demo-logins.ts first.`);
  }
  const year = await findCurrentAcademicYear(tenantId);

  // Module-scoped so the `finally` below can close it - `compile()` runs no
  // lifecycle hooks (see docs/decisions.md's "A seed that builds a Nest
  // module must close() it"); nothing in this module currently needs a
  // hook, but the posture is kept uniform so the trap never re-arms
  // silently if one is added later.
  moduleRef = await Test.createTestingModule({ imports: [BillingModule] }).compile();
  const billing = moduleRef.get<BillingContract>(BILLING_CONTRACT);

  const ctx = { tenantId, userId: financeUserId, actorUserId: financeUserId, roles: [], requestId: newId() };

  // --- Fee schedule + its first published version --------------------------
  const feeScheduleName = `${year.name} ${FEE_SCHEDULE_NAME_PREFIX}`;
  const feeSchedule = await runWithContext(ctx, async () => {
    const existing = (await billing.listFeeSchedules()).find((schedule) => schedule.name === feeScheduleName);
    if (existing) {
      console.log(`  skip   fee schedule "${feeScheduleName}" (already exists)`);
      return existing;
    }
    const created = await billing.createFeeSchedule({ name: feeScheduleName, academicYearId: year.id as AcademicYearId });
    if (!created.ok) throw created.error;
    console.log(`  create fee schedule "${feeScheduleName}"`);
    return created.value;
  });

  const feeScheduleVersion = await runWithContext(ctx, async () => {
    const existingVersions = await billing.listFeeScheduleVersions(feeSchedule.id);
    if (existingVersions.length > 0) {
      const latest = existingVersions[0]!;
      console.log(`  skip   fee schedule version (already published, v${latest.version})`);
      const detail = await billing.getFeeScheduleVersion(latest.id);
      if (!detail.ok) throw detail.error;
      return detail.value;
    }
    const published = await billing.publishFeeScheduleVersion({
      feeScheduleId: feeSchedule.id,
      currency: CURRENCY,
      components: COMPONENTS,
    });
    if (!published.ok) throw published.error;
    console.log(`  create fee schedule version v${published.value.version} (${published.value.components.length} component(s))`);
    return published.value;
  });
  const feeComponentIds = feeScheduleVersion.components.map((component) => component.id);
  const invoiceTotalMinor = feeScheduleVersion.components.reduce((sum, component) => sum + component.amountMinor, 0);

  // --- Roster: the demo parent's children FIRST (guaranteed coverage - see
  // this file's own header), then every other currently-enrolled student,
  // deduplicated. -------------------------------------------------------
  const parentChildren = await findParentLoginChildren(tenantId);
  const enrolled = await findEnrolledStudents(tenantId, year.id);
  const seen = new Set<string>();
  const roster: PersonRow[] = [];
  for (const person of [...parentChildren, ...enrolled]) {
    if (seen.has(person.person_id)) continue;
    seen.add(person.person_id);
    roster.push(person);
  }

  if (roster.length === 0) {
    console.log('  skip   invoices (no enrolled students and no children linked to the demo parent login - run @sms/enrollment\'s seed first)');
    console.log('seed complete');
    return;
  }

  type Scenario = 'fully_paid' | 'part_paid' | 'overdue' | 'credited';
  const scenarios: Scenario[] = ['fully_paid', 'part_paid', 'overdue', 'credited'];
  const today = todayDateOnly();

  for (let index = 0; index < Math.min(roster.length, scenarios.length); index += 1) {
    const student = roster[index]!;
    const scenario = scenarios[index]!;
    const studentName = `${student.given_name} ${student.family_name}`;

    await runWithContext(ctx, async () => {
      const existingInvoices = await billing.listInvoices({ studentPersonId: student.person_id as PersonId });
      if (existingInvoices.length > 0) {
        console.log(`  skip   invoice for ${studentName} (${scenario} - already has ${existingInvoices.length} invoice(s))`);
        return;
      }

      const payerPersonId = (await findGuardianFor(tenantId, student.person_id)) ?? (student.person_id as PersonId);
      // 'overdue' gets a due date in the past; every other scenario is due
      // three weeks out - both computed relative to today, never hardcoded
      // (docs/decisions.md).
      const dueDate = scenario === 'overdue' ? addDays(today, -14) : addDays(today, 21);

      const created = await billing.createInvoice({
        studentPersonId: student.person_id as PersonId,
        payerPersonId,
        currency: CURRENCY,
        dueDate,
        feeComponentIds,
      });
      if (!created.ok) throw created.error;

      const issued = await billing.issueInvoice(created.value.id);
      if (!issued.ok) throw issued.error;

      if (scenario === 'fully_paid' || scenario === 'part_paid') {
        const amountMinor = scenario === 'fully_paid' ? invoiceTotalMinor : Math.round(invoiceTotalMinor / 2);
        const paid = await billing.recordPayment({
          payerPersonId,
          amountMinor,
          currency: CURRENCY,
          method: 'bank_transfer',
          idempotencyKey: `seed-payment-${created.value.id}`,
          allocations: [{ invoiceId: created.value.id, amountMinor }],
        });
        if (!paid.ok) throw paid.error;
      }

      if (scenario === 'credited') {
        const line = created.value.lines[0]!;
        const creditNote = await billing.issueCreditNote({
          invoiceId: created.value.id,
          reason: 'Seeded sibling discount adjustment.',
          lines: [{ invoiceLineId: line.id, description: `Discount on ${line.description}`, amountMinor: Math.round(line.amountMinor * 0.5) }],
        });
        if (!creditNote.ok) throw creditNote.error;
      }

      console.log(`  create invoice for ${studentName} (${scenario}, total $${(invoiceTotalMinor / 100).toFixed(2)})`);
    });
  }

  console.log('seed complete');
}

function addDays(date: DateOnly, days: number): DateOnly {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10) as DateOnly;
}

main()
  .catch((error: unknown) => {
    console.error('seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await moduleRef?.close();
    await closeSqlClients();
  });
