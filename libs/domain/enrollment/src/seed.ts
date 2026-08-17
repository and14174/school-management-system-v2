#!/usr/bin/env tsx
/**
 * Idempotent local-dev/CI seed data: enrols all 16 seeded students
 * (`@sms/people`'s seed) into the current academic year, round-robin across
 * the six `@sms/academic`-seeded grade levels (G7-G12) and the two seeded
 * campuses, each with a generated student number.
 *
 * Complements (does not modify - see the module report's constraints)
 * `@sms/tenancy`'s, `@sms/identity`'s, `@sms/access`'s, `@sms/people`'s and
 * `@sms/academic`'s own `seed.ts`: all five must have already run (this
 * script looks up the "greenwood" tenant, its campuses, current academic
 * year, seeded grade levels and seeded students by name, and fails with a
 * clear message if any is missing, rather than creating a divergent one).
 *
 * Grade-level assignment is round-robin, not age-accurate - same
 * simplification `@sms/academic`'s own seed makes for section rosters (see
 * its header comment): the point here is to exercise `enrolStudent` against
 * real people/campus/grade-level/academic-year rows, not to model a
 * pedagogically correct cohort.
 *
 * Usage: tsx src/seed.ts (run after tenancy's, identity's, access's,
 * people's and academic's). Not wired into `apps/api`'s `db:seed` chain -
 * that script lives at `apps/api/package.json`, outside this module's
 * allowed edit paths (see the module report's constraints); run this seed
 * manually as the last step, or add it to that chain by hand.
 */
import 'reflect-metadata';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { closeSqlClients, withSystemTx } from '@sms/db';
import type { AcademicYearId, CampusId, DateOnly, PersonId, TenantId } from '@sms/kernel';
import { EnrollmentRecordService } from './application/enrollment-record.service.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// Resolved relative to this file, not process.cwd() - see @sms/tenancy's migrate.ts/seed.ts for why.
try {
  process.loadEnvFile(join(__dirname, '..', '..', '..', '..', '.env'));
} catch {
  // no .env file present - assume the environment already has what we need
}

const records = new EnrollmentRecordService();

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

async function findCurrentAcademicYear(tenantId: TenantId): Promise<{ id: AcademicYearId; startsOn: DateOnly }> {
  const rows = await withSystemTx((db) =>
    db.execute<{ id: string; starts_on: string }>(
      sql`select id, starts_on from tenancy.academic_year where tenant_id = ${tenantId} and is_current limit 1`,
    ),
  );
  const row = (rows as unknown as Array<{ id: string; starts_on: string }>)[0];
  if (!row) {
    throw new Error('No current academic year found for tenant "greenwood". Run @sms/tenancy\'s seed first.');
  }
  return { id: row.id as AcademicYearId, startsOn: row.starts_on as DateOnly };
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

async function findPersonByNameAndDob(tenantId: TenantId, givenName: string, familyName: string, dateOfBirth: DateOnly): Promise<PersonId> {
  const rows = await withSystemTx((db) =>
    db.execute<{ id: string }>(
      sql`select id from people.person where tenant_id = ${tenantId} and given_name = ${givenName} and family_name = ${familyName} and date_of_birth = ${dateOfBirth} and merged_into_id is null limit 1`,
    ),
  );
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error(`No person "${givenName} ${familyName}" (dob ${dateOfBirth}) found. Run @sms/people's seed first.`);
  }
  return row.id as PersonId;
}

async function ensureEnrollment(
  tenantId: TenantId,
  personId: PersonId,
  academicYearId: AcademicYearId,
  campusId: CampusId,
  gradeLevelId: string,
  enrolledOn: DateOnly,
  studentNumber: string,
): Promise<void> {
  const enrolled = await records.enrolStudent(tenantId, { personId, academicYearId, campusId, gradeLevelId, enrolledOn, studentNumber });
  if (enrolled.ok) {
    console.log(`  enrol  ${studentNumber} (person ${personId})`);
    return;
  }
  if (enrolled.error.code === 'CONFLICT') {
    console.log(`  skip   ${studentNumber} (already enrolled this academic year)`);
    return;
  }
  throw enrolled.error;
}

const GRADE_LEVEL_CODES = ['G7', 'G8', 'G9', 'G10', 'G11', 'G12'] as const;
const CAMPUS_CODES = ['main', 'north'] as const;

// Every student @sms/people's seed creates (see that module's FAMILIES/
// EMERGENCY_CONTACTS - this list mirrors @sms/academic's own seed's
// STUDENTS constant, since both scripts enrol the same 16 people).
const STUDENTS: Array<{ givenName: string; familyName: string; dateOfBirth: DateOnly }> = [
  { givenName: 'Emily', familyName: 'Carter', dateOfBirth: '2014-08-01' as DateOnly },
  { givenName: 'Emilie', familyName: 'Carter', dateOfBirth: '2014-08-01' as DateOnly },
  { givenName: 'Anh', familyName: 'Nguyen', dateOfBirth: '2011-02-18' as DateOnly },
  { givenName: 'Minh', familyName: 'Nguyen', dateOfBirth: '2016-09-09' as DateOnly },
  { givenName: 'Chidi', familyName: 'Okafor', dateOfBirth: '2013-04-27' as DateOnly },
  { givenName: 'Sofia', familyName: 'Alvarez', dateOfBirth: '2017-11-03' as DateOnly },
  { givenName: 'Mateo', familyName: 'Alvarez', dateOfBirth: '2019-01-21' as DateOnly },
  { givenName: 'Piotr', familyName: 'Kowalski', dateOfBirth: '2009-05-16' as DateOnly },
  { givenName: 'Layla', familyName: 'Haddad', dateOfBirth: '2012-07-12' as DateOnly },
  { givenName: 'Omar', familyName: 'Haddad', dateOfBirth: '2015-03-24' as DateOnly },
  { givenName: 'Elsa', familyName: 'Larsson', dateOfBirth: '2008-10-30' as DateOnly },
  { givenName: 'Efua', familyName: 'Mensah', dateOfBirth: '2007-01-09' as DateOnly },
  { givenName: 'Ivan', familyName: 'Petrov', dateOfBirth: '2016-06-06' as DateOnly },
  { givenName: 'Sora', familyName: 'Suzuki', dateOfBirth: '2010-12-19' as DateOnly },
  { givenName: 'Ren', familyName: 'Suzuki', dateOfBirth: '2018-04-02' as DateOnly },
  { givenName: 'Hugo', familyName: 'Dubois', dateOfBirth: '2013-09-23' as DateOnly },
];

async function main(): Promise<void> {
  const tenantId = await findGreenwoodTenantId();
  const academicYear = await findCurrentAcademicYear(tenantId);

  const campusIdByCode = new Map<string, CampusId>();
  for (const code of CAMPUS_CODES) {
    campusIdByCode.set(code, await findCampusId(tenantId, code));
  }

  const gradeLevelIdByCode = new Map<string, string>();
  for (const code of GRADE_LEVEL_CODES) {
    gradeLevelIdByCode.set(code, await findGradeLevelId(tenantId, code));
  }

  for (const [index, student] of STUDENTS.entries()) {
    const personId = await findPersonByNameAndDob(tenantId, student.givenName, student.familyName, student.dateOfBirth);
    const gradeLevelCode = GRADE_LEVEL_CODES[index % GRADE_LEVEL_CODES.length]!;
    const campusCode = CAMPUS_CODES[index % CAMPUS_CODES.length]!;
    const gradeLevelId = gradeLevelIdByCode.get(gradeLevelCode)!;
    const campusId = campusIdByCode.get(campusCode)!;
    const studentNumber = `GW-${(index + 1).toString().padStart(4, '0')}`;

    await ensureEnrollment(tenantId, personId, academicYear.id, campusId, gradeLevelId, academicYear.startsOn, studentNumber);
  }

  console.log('seed complete');
}

main()
  .catch((error: unknown) => {
    console.error('seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSqlClients();
  });
