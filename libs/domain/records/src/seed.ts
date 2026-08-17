#!/usr/bin/env tsx
/**
 * Idempotent local-dev/CI seed data: a default "Standard Promotion Policy"
 * credit rule set and its first published version, finalised transcript
 * entries for every enrolled student in the most recently COMPLETED term
 * (computed relative to today, never hardcoded - see `docs/decisions.md`),
 * and one issued report-card run (whole school) for that same term's
 * grading period, so there is real data to look at.
 *
 * Registers a minimal STUB `report_card` document template - not the real,
 * fully-designed one (`apps/api/src/documents/report-card.template.ts`,
 * registered by `apps/api/src/documents/document-templates.module.ts`) -
 * purely so `DocumentsContract.generate` has something to render against in
 * isolation. This module (`type:domain`) may not depend on `apps/api`
 * (`type:app`), so it cannot reuse the real template; the live curl
 * verification in the module report exercises the real one.
 *
 * Complements (does not modify - see the module report's constraints)
 * `@sms/tenancy`'s, `@sms/identity`'s, `@sms/access`'s, `@sms/people`'s,
 * `@sms/academic`'s, `@sms/enrollment`'s and `@sms/gradebook`'s own
 * `seed.ts`: all must have already run (this script looks up the
 * "greenwood" tenant, its terms/sections/rosters and `admin@greenwood.test`,
 * and fails with a clear message if any is missing).
 *
 * Usage: tsx src/seed.ts (run after every module listed above). Not wired
 * into `apps/api`'s `db:seed` chain - that script lives at
 * `apps/api/package.json`, outside this module's allowed edit paths (see
 * the module report's constraints); run this seed manually as the last
 * step, and add it to that chain by hand.
 */
import 'reflect-metadata';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Global, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { closeSqlClients, runWithContext, withSystemTx } from '@sms/db';
import { newId, todayDateOnly, type PersonId, type TenantId, type UserId } from '@sms/kernel';
import { ACADEMIC_CONTRACT, AcademicModule, type AcademicContract } from '@sms/academic';
import { GradebookModule } from '@sms/gradebook';
import { PeopleModule } from '@sms/people';
import { DOCUMENT_TEMPLATE_REGISTRY, DOCUMENTS_CONTRACT, DocumentsModule, type DocumentsContract, type DocumentTemplate, type DocumentTemplateRegistry } from '@sms/documents';
import { RECORDS_CONTRACT, type RecordsContract } from './contract.js';
import { RecordsModule } from './api/records.module.js';
import { REPORT_CARD_TEMPLATE_KEY } from './application/report-card.service.js';
import type { CreditRules } from './domain/types.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// Resolved relative to this file, not process.cwd() - see @sms/gradebook's
// seed.ts for the same pattern.
try {
  process.loadEnvFile(join(__dirname, '..', '..', '..', '..', '.env'));
} catch {
  // no .env file present - assume the environment already has what we need
}

process.env.S3_ENDPOINT ??= 'http://localhost:9000';
process.env.S3_REGION ??= 'us-east-1';
process.env.S3_BUCKET ??= 'sms-dev';
process.env.S3_ACCESS_KEY ??= 'minioadmin';
process.env.S3_SECRET_KEY ??= 'minioadmin';
process.env.S3_FORCE_PATH_STYLE ??= 'true';

const ADMIN_EMAIL = 'admin@greenwood.test';
const CREDIT_RULE_SET_NAME = 'Standard Promotion Policy';

const stubReportCardTemplate: DocumentTemplate = {
  key: REPORT_CARD_TEMPLATE_KEY,
  name: 'Report Card (seed stub - see this file\'s own header)',
  dataSchema: z.unknown(),
  async render(data) {
    return { html: `<pre>${JSON.stringify(data, null, 2)}</pre>`, css: 'body { font-family: monospace; }' };
  },
};

/** `@Global()` so `DocumentsService` (living inside `DocumentsModule`'s own DI container) sees this override - same mechanism `apps/api`'s real `DocumentTemplatesModule` uses. */
@Global()
@Module({
  providers: [
    {
      provide: DOCUMENT_TEMPLATE_REGISTRY,
      useValue: {
        list: () => [{ key: stubReportCardTemplate.key, name: stubReportCardTemplate.name }],
        get: (key: string) => (key === stubReportCardTemplate.key ? stubReportCardTemplate : undefined),
      } satisfies DocumentTemplateRegistry,
    },
  ],
  exports: [DOCUMENT_TEMPLATE_REGISTRY],
})
class SeedReportCardTemplateModule {}

async function findGreenwoodTenantId(): Promise<TenantId> {
  const rows = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from tenancy.tenant where slug = 'greenwood' limit 1`));
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) throw new Error('No tenant with slug "greenwood" found. Run @sms/tenancy\'s seed first.');
  return row.id as TenantId;
}

async function findAdminUserId(): Promise<UserId> {
  const rows = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from identity.user where email = ${ADMIN_EMAIL} limit 1`));
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) throw new Error(`No user "${ADMIN_EMAIL}" found. Run @sms/access's seed first.`);
  return row.id as UserId;
}

type TermRow = { readonly id: string; readonly name: string; readonly ends_on: string };

/** The most recently COMPLETED term (endsOn < today) - never hardcoded, see this file's own header. Falls back to the earliest term if none has ended yet (a fresh demo tenant seeded on day one of its year). */
async function findCompletedTerm(tenantId: TenantId): Promise<TermRow> {
  const today = todayDateOnly();
  const completedRows = await withSystemTx((db) =>
    db.execute<TermRow>(sql`
      select id, name, ends_on::text from academic.term
      where tenant_id = ${tenantId} and ends_on < ${today}
      order by ends_on desc limit 1
    `),
  );
  const completed = (completedRows as unknown as TermRow[])[0];
  if (completed) return completed;

  const anyRows = await withSystemTx((db) => db.execute<TermRow>(sql`select id, name, ends_on::text from academic.term where tenant_id = ${tenantId} order by sequence limit 1`));
  const any = (anyRows as unknown as TermRow[])[0];
  if (!any) throw new Error('No terms found. Run @sms/academic\'s seed first.');
  console.log(`  note   no term has ended yet as of ${today}; using the earliest term "${any.name}" instead`);
  return any;
}

type RosterRow = { readonly person_id: string };

async function listTermRoster(tenantId: TenantId, termId: string): Promise<PersonId[]> {
  const rows = await withSystemTx((db) =>
    db.execute<RosterRow>(sql`
      select distinct se.person_id
      from academic.section s
      join academic.section_enrollment se on se.tenant_id = s.tenant_id and se.section_id = s.id
      where s.tenant_id = ${tenantId} and s.term_id = ${termId}
    `),
  );
  return (rows as unknown as RosterRow[]).map((row) => row.person_id as PersonId);
}

const DEFAULT_CREDIT_RULES: CreditRules = {
  defaultRequiredCredits: 4,
  minGpa: 1.0,
};

/**
 * Module-scoped so the `finally` below can close it. `compile()` does NOT run
 * lifecycle hooks - `PdfRenderer.onModuleDestroy`, which closes the shared
 * Chromium this seed starts to render report cards, only fires on `close()`.
 * Without that, the browser subprocess keeps Node's event loop alive and this
 * script never exits: it prints "seed complete" and then hangs forever,
 * taking every later step of `pnpm db:seed`'s `&&` chain with it.
 */
let moduleRef: TestingModule | undefined;

async function main(): Promise<void> {
  const tenantId = await findGreenwoodTenantId();
  const adminUserId = await findAdminUserId();
  const term = await findCompletedTerm(tenantId);

  moduleRef = await Test.createTestingModule({
    imports: [AcademicModule, GradebookModule, PeopleModule, DocumentsModule, SeedReportCardTemplateModule, RecordsModule],
  }).compile();
  const academic = moduleRef.get<AcademicContract>(ACADEMIC_CONTRACT);
  const records = moduleRef.get<RecordsContract>(RECORDS_CONTRACT);
  const documents = moduleRef.get<DocumentsContract>(DOCUMENTS_CONTRACT);

  const ctx = { tenantId, userId: adminUserId, actorUserId: adminUserId, roles: [], requestId: newId() };

  // --- Publish an (empty - "use the template's own defaults") version of
  // the report_card template for this tenant. DocumentsContract.generate
  // requires a PUBLISHED VERSION per tenant on top of the code-level
  // registry entry (see @sms/documents' 1100 migration header); publishing
  // empty html/css here is compatible with whichever report_card
  // DocumentTemplate object is actually bound at generate() time (this
  // seed's own stub, or apps/api's real one) - see this file's own header.
  await runWithContext(ctx, async () => {
    const templates = await documents.listTemplates();
    const existing = templates.find((t) => t.key === REPORT_CARD_TEMPLATE_KEY);
    if (existing?.latestVersion) {
      console.log(`  skip   report_card template version (already published, v${existing.latestVersion})`);
      return;
    }
    const published = await documents.publishTemplateVersion({ templateKey: REPORT_CARD_TEMPLATE_KEY, html: '', css: '' });
    if (!published.ok) throw published.error;
    console.log(`  create report_card template version (v${published.value.version})`);
  });

  // --- Default credit rule set ------------------------------------------
  await runWithContext(ctx, async () => {
    const existing = await records.listCreditRuleSets();
    if (existing.some((set) => set.name === CREDIT_RULE_SET_NAME)) {
      console.log(`  skip   credit rule set "${CREDIT_RULE_SET_NAME}" (already exists)`);
      return;
    }
    const created = await records.createCreditRuleSet({ name: CREDIT_RULE_SET_NAME, isDefault: true });
    if (!created.ok) throw created.error;
    const published = await records.publishCreditRuleSetVersion({ creditRuleSetId: created.value.id, rules: DEFAULT_CREDIT_RULES });
    if (!published.ok) throw published.error;
    console.log(`  create credit rule set "${CREDIT_RULE_SET_NAME}" (v${published.value.version})`);
  });

  // --- Finalise transcript entries for the completed term -----------------
  const roster = await listTermRoster(tenantId, term.id);
  if (roster.length === 0) {
    console.log(`  skip   transcript finalisation for term "${term.name}" (no enrolled students)`);
  } else {
    let finalisedCount = 0;
    let skippedCount = 0;
    for (const personId of roster) {
      const result = await runWithContext(ctx, () => records.finaliseTranscriptEntries({ personId, termId: term.id }));
      if (result.ok) {
        finalisedCount += 1;
      } else {
        // A student with no computed grades yet in this term's final grading
        // period (e.g. enrolled but nothing graded) - not a seed failure.
        skippedCount += 1;
      }
    }
    console.log(`  finalise transcript entries for ${finalisedCount} student(s) in term "${term.name}" (${skippedCount} skipped - nothing gradeable yet)`);
  }

  // --- Grading period for this term, and one issued report-card run -------
  const gradingPeriods = await runWithContext(ctx, () => academic.listGradingPeriods(term.id));
  const finalPeriod = [...gradingPeriods].sort((a, b) => b.sequence - a.sequence)[0];
  if (!finalPeriod) {
    console.log(`  skip   report card run for term "${term.name}" (no grading periods)`);
  } else {
    const idempotencyKey = `seed-report-cards-${finalPeriod.id}`;
    const issued = await runWithContext(ctx, () => records.issueReportCards({ gradingPeriodId: finalPeriod.id, idempotencyKey }));
    if (!issued.ok) {
      console.log(`  skip   report card run for grading period "${finalPeriod.name}" (${issued.error.message})`);
    } else {
      console.log(
        `  ${issued.value.replayed ? 'skip  ' : 'create'} report card run for grading period "${finalPeriod.name}" - ${issued.value.run.documentCount} document(s) (run ${issued.value.run.id})`,
      );
    }
  }

  console.log('seed complete');
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
