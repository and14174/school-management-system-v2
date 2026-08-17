#!/usr/bin/env tsx
/**
 * Idempotent local-dev/CI seed data: a realistic admissions pipeline -
 * several fictional applicants spread across every stage (enquiry, applied,
 * assessment, offered), at least one rejected, and one accepted AND
 * converted to a REAL enrolment (through the same `recordDecision`/
 * `ensureConverted` code path a real accept call uses) so the handoff to
 * `@sms/enrollment` is demonstrably working, not just plausible.
 *
 * Complements (does not modify - see the module report's constraints)
 * `@sms/tenancy`'s, `@sms/identity`'s, `@sms/access`'s, `@sms/people`'s,
 * `@sms/academic`'s and `@sms/enrollment`'s own `seed.ts`: all six must have
 * already run (this script looks up the "greenwood" tenant, its "main"
 * campus, current academic year and a seeded grade level, and fails with a
 * clear message if any is missing, rather than creating a divergent one).
 *
 * Every applicant is FICTIONAL (never one of `@sms/people`'s 16 seeded
 * students) except one deliberately reuses an EXISTING seeded person as
 * `personId` - the "family already known" case from this module's `1500`
 * migration header, point 1 - left at the `enquiry` stage (never accepted),
 * so it never collides with that person's existing enrolment.
 *
 * Usage: tsx src/seed.ts (run after tenancy's, identity's, access's,
 * people's, academic's and enrollment's). Wired into `apps/api`'s `db:seed`
 * chain, right after `@sms/enrollment`'s own seed.
 */
import 'reflect-metadata';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { Test, type TestingModule } from '@nestjs/testing';
import { closeSqlClients, runWithContext, withSystemTx } from '@sms/db';
import { OUTBOX_CONTRACT, OutboxModule, type OutboxContract } from '@sms/outbox';
import { PEOPLE_CONTRACT, PeopleModule, type PeopleContract } from '@sms/people';
import { ENROLLMENT_CONTRACT, EnrollmentModule, type EnrollmentContract } from '@sms/enrollment';
import { newId, type AcademicYearId, type CampusId, type DateOnly, type PersonId, type TenantId } from '@sms/kernel';
import { ApplicationRecordService } from './application/application-record.service.js';
import { DecisionService } from './application/decision.service.js';
import type { ApplicationStage, DecisionOutcome } from './domain/types.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// Resolved relative to this file, not process.cwd() - see @sms/tenancy's migrate.ts/seed.ts for why.
try {
  process.loadEnvFile(join(__dirname, '..', '..', '..', '..', '.env'));
} catch {
  // no .env file present - assume the environment already has what we need
}

/**
 * `EnrollmentService`/`AdmissionsService` (the concrete `ENROLLMENT_CONTRACT`/
 * `ADMISSIONS_CONTRACT` implementations) are internal classes, not part of
 * either module's public entrypoint - module-boundary, same reasoning as
 * `@sms/attendance`'s own seed. A minimal Nest DI container just for
 * `OutboxModule`/`PeopleModule`/`EnrollmentModule` is the only way to obtain
 * real `OUTBOX_CONTRACT`/`PEOPLE_CONTRACT`/`ENROLLMENT_CONTRACT` instances
 * outside `apps/api`'s own bootstrap - `.compile()` alone (no `.init()`)
 * deliberately does NOT run lifecycle hooks, so this does not start any
 * background loop that would otherwise keep the seed script's process alive.
 */
let seedModule: TestingModule | undefined;

async function buildServices(): Promise<{ records: ApplicationRecordService; decisions: DecisionService }> {
  seedModule = await Test.createTestingModule({ imports: [OutboxModule, PeopleModule, EnrollmentModule] }).compile();
  const outbox = seedModule.get<OutboxContract>(OUTBOX_CONTRACT);
  const people = seedModule.get<PeopleContract>(PEOPLE_CONTRACT);
  const enrollment = seedModule.get<EnrollmentContract>(ENROLLMENT_CONTRACT);
  return {
    records: new ApplicationRecordService(outbox),
    decisions: new DecisionService(outbox, people, enrollment),
  };
}

async function findGreenwoodTenantId(): Promise<TenantId> {
  const rows = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from tenancy.tenant where slug = 'greenwood' limit 1`));
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error('No tenant with slug "greenwood" found. Run @sms/tenancy\'s seed first.');
  }
  return row.id as TenantId;
}

async function findCampusId(tenantId: TenantId, code: string): Promise<CampusId> {
  const rows = await withSystemTx((db) =>
    db.execute<{ id: string }>(sql`select id from tenancy.campus where tenant_id = ${tenantId} and code = ${code} limit 1`),
  );
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error(`No campus "${code}" found for tenant "greenwood". Run @sms/tenancy's seed first.`);
  }
  return row.id as CampusId;
}

async function findCurrentAcademicYear(tenantId: TenantId): Promise<AcademicYearId> {
  const rows = await withSystemTx((db) =>
    db.execute<{ id: string }>(sql`select id from tenancy.academic_year where tenant_id = ${tenantId} and is_current limit 1`),
  );
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error('No current academic year found for tenant "greenwood". Run @sms/tenancy\'s seed first.');
  }
  return row.id as AcademicYearId;
}

async function findGradeLevelId(tenantId: TenantId, code: string): Promise<string> {
  const rows = await withSystemTx((db) =>
    db.execute<{ id: string }>(sql`select id from academic.grade_level where tenant_id = ${tenantId} and code = ${code} limit 1`),
  );
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error(`No grade level "${code}" found for tenant "greenwood". Run @sms/academic's seed first.`);
  }
  return row.id;
}

/** An arbitrary already-seeded person - demonstrates the "family already known" `personId` link (this module's `1500` migration header, point 1) without creating a new one. */
async function findAnySeededPersonId(tenantId: TenantId): Promise<PersonId> {
  const rows = await withSystemTx((db) =>
    db.execute<{ id: string }>(
      sql`select id from people.person where tenant_id = ${tenantId} and merged_into_id is null order by created_at limit 1`,
    ),
  );
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error('No seeded person found. Run @sms/people\'s seed first.');
  }
  return row.id as PersonId;
}

async function findExistingApplicationId(tenantId: TenantId, givenName: string, familyName: string): Promise<string | null> {
  const rows = await withSystemTx((db) =>
    db.execute<{ id: string }>(
      sql`select id from admissions.application where tenant_id = ${tenantId} and applicant_given_name = ${givenName} and applicant_family_name = ${familyName} limit 1`,
    ),
  );
  const row = (rows as unknown as Array<{ id: string }>)[0];
  return row?.id ?? null;
}

interface ApplicantSeed {
  readonly givenName: string;
  readonly familyName: string;
  readonly dateOfBirth: DateOnly;
  readonly guardianName: string;
  readonly guardianEmail: string;
  /** Stages moved through via `moveStage` (write-gated), in order, after submission - never includes offered/accepted/rejected/withdrawn. */
  readonly stageMoves: readonly ApplicationStage[];
  /** Decisions recorded via `recordDecision` (decide-gated), in order, after the stage moves above. */
  readonly decisions: readonly DecisionOutcome[];
  /** Demonstrates the "family already known" case - see this module's `1500` migration header, point 1. Never combined with an `accepted` decision (would conflict with that person's existing enrolment). */
  readonly reuseExistingPerson?: boolean;
}

// Deliberately spread across every reachable stage - see this file's own
// header. "Zara Ahmed" is the one that gets offered, accepted, and actually
// converted to a real enrolment, proving the @sms/enrollment handoff works.
const APPLICANTS: ApplicantSeed[] = [
  {
    givenName: 'Aisha',
    familyName: 'Bello',
    dateOfBirth: '2015-03-12' as DateOnly,
    guardianName: 'Folake Bello',
    guardianEmail: 'folake.bello@example.test',
    stageMoves: [],
    decisions: [],
  },
  {
    givenName: 'Noah',
    familyName: 'Kim',
    dateOfBirth: '2014-07-22' as DateOnly,
    guardianName: 'Jisoo Kim',
    guardianEmail: 'jisoo.kim@example.test',
    stageMoves: ['applied'],
    decisions: [],
  },
  {
    givenName: 'Grace',
    familyName: 'Osei',
    dateOfBirth: '2013-11-05' as DateOnly,
    guardianName: 'Kwame Osei',
    guardianEmail: 'kwame.osei@example.test',
    stageMoves: ['applied', 'assessment'],
    decisions: [],
  },
  {
    givenName: 'Liam',
    familyName: 'Fischer',
    dateOfBirth: '2012-01-30' as DateOnly,
    guardianName: 'Anna Fischer',
    guardianEmail: 'anna.fischer@example.test',
    stageMoves: ['applied', 'assessment'],
    decisions: ['offered'],
  },
  {
    givenName: 'Maya',
    familyName: 'Studious',
    dateOfBirth: '2016-05-18' as DateOnly,
    guardianName: 'Priya Studious',
    guardianEmail: 'priya.studious@example.test',
    stageMoves: ['applied', 'assessment'],
    decisions: ['rejected'],
  },
  {
    givenName: 'Zara',
    familyName: 'Ahmed',
    dateOfBirth: '2013-09-09' as DateOnly,
    guardianName: 'Yusuf Ahmed',
    guardianEmail: 'yusuf.ahmed@example.test',
    stageMoves: ['applied', 'assessment'],
    decisions: ['offered', 'accepted'],
  },
  {
    givenName: 'Existing',
    familyName: 'Sibling',
    dateOfBirth: '2017-02-14' as DateOnly,
    guardianName: 'A Guardian Already On File',
    guardianEmail: 'guardian@example.test',
    stageMoves: [],
    decisions: [],
    reuseExistingPerson: true,
  },
];

async function main(): Promise<void> {
  const tenantId = await findGreenwoodTenantId();
  const campusId = await findCampusId(tenantId, 'main');
  const academicYearId = await findCurrentAcademicYear(tenantId);
  const gradeLevelId = await findGradeLevelId(tenantId, 'G7');
  const { records, decisions } = await buildServices();

  const ctx = { tenantId, roles: [], requestId: newId() };

  for (const applicant of APPLICANTS) {
    const existingId = await findExistingApplicationId(tenantId, applicant.givenName, applicant.familyName);
    if (existingId) {
      console.log(`  skip   application for ${applicant.givenName} ${applicant.familyName} (already seeded)`);
      continue;
    }

    const personId = applicant.reuseExistingPerson ? await findAnySeededPersonId(tenantId) : undefined;

    const submitted = await runWithContext(ctx, () =>
      records.submitApplication(tenantId, {
        ...(personId ? { personId } : {}),
        applicantGivenName: applicant.givenName,
        applicantFamilyName: applicant.familyName,
        applicantDateOfBirth: applicant.dateOfBirth,
        guardianName: applicant.guardianName,
        guardianEmail: applicant.guardianEmail,
        desiredAcademicYearId: academicYearId,
        desiredCampusId: campusId,
        desiredGradeLevelId: gradeLevelId,
        source: 'seed',
      }),
    );
    if (!submitted.ok) {
      throw submitted.error;
    }
    const applicationId = submitted.value.id;
    console.log(`  create application for ${applicant.givenName} ${applicant.familyName} (${applicationId})`);

    for (const toStage of applicant.stageMoves) {
      const moved = await runWithContext(ctx, () => records.moveStage(tenantId, { applicationId, toStage }));
      if (!moved.ok) {
        throw moved.error;
      }
    }

    for (const outcome of applicant.decisions) {
      const decided = await runWithContext(ctx, () => decisions.recordDecision(tenantId, { applicationId, outcome, reason: `Seeded ${outcome} decision.` }));
      if (!decided.ok) {
        throw decided.error;
      }
      if (outcome === 'accepted' && decided.value.conversion) {
        console.log(
          `    accept + convert: person ${decided.value.conversion.personId}, enrolment ${decided.value.conversion.enrollmentId}`,
        );
      }
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
    // See `seedModule`'s own comment - .compile() runs no lifecycle hooks, so
    // nothing is released until .close(); skipping it hangs the whole
    // `db:seed` `&&` chain forever (see decisions.md's "A seed that builds a
    // Nest module must close() it").
    await seedModule?.close();
    await closeSqlClients();
  });
