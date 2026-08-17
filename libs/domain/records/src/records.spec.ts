import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Global, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  newId,
  unwrap,
  type AcademicYearId,
  type CampusId,
  type DateOnly,
  type PersonId,
  type TenantId,
  type UserId,
} from '@sms/kernel';
import { closeSqlClients, createSqlClient, runWithContext, type Sql } from '@sms/db';
import { ACCESS_CONTRACT, PERMISSION_CATALOGUE, type AccessContract } from '@sms/access';
import { ACADEMIC_CONTRACT, AcademicModule, type AcademicContract } from '@sms/academic';
import { GRADEBOOK_CONTRACT, GradebookModule, type GradebookContract } from '@sms/gradebook';
import { PeopleModule } from '@sms/people';
import { DOCUMENT_TEMPLATE_REGISTRY, DOCUMENTS_CONTRACT, DocumentsModule, type DocumentsContract, type DocumentTemplate, type DocumentTemplateRegistry } from '@sms/documents';
import { RECORDS_CONTRACT, type RecordsContract } from './contract.js';
import { RecordsModule } from './api/records.module.js';
import { REPORT_CARD_TEMPLATE_KEY } from './application/report-card.service.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// ---------------------------------------------------------------------------
// A minimal STUB report_card template - the real, fully-designed one lives
// in apps/api/src/documents/report-card.template.ts (this package, type:
// domain, may not depend on apps/api - type:app). See seed.ts's own header
// for the same reasoning; this is the identical stub.
// ---------------------------------------------------------------------------
const stubReportCardTemplate: DocumentTemplate = {
  key: REPORT_CARD_TEMPLATE_KEY,
  name: 'Report Card (test stub)',
  dataSchema: z.unknown(),
  async render(data) {
    return { html: `<pre>${JSON.stringify(data)}</pre>`, css: '' };
  },
};

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
class TestReportCardTemplateModule {}

const DEFAULT_BANDS = [
  { label: 'A', min: 90, gpaPoints: 4 },
  { label: 'B', min: 80, gpaPoints: 3 },
  { label: 'C', min: 70, gpaPoints: 2 },
  { label: 'D', min: 60, gpaPoints: 1 },
  { label: 'F', min: 0, gpaPoints: 0 },
];

const STRICTER_BANDS = [
  { label: 'A', min: 97, gpaPoints: 4 },
  { label: 'B', min: 94, gpaPoints: 3 },
  { label: 'C', min: 90, gpaPoints: 2 },
  { label: 'D', min: 85, gpaPoints: 1 },
  { label: 'F', min: 0, gpaPoints: 0 },
];

/**
 * Applies the real `audit` + `tenancy` + `identity` + `access` + `people` +
 * `academic` + `outbox` + `documents` + `gradebook` migrations (read, never
 * edited - see the module report's constraints) and this module's own
 * `1200` migration to a throwaway container, then proves - through the real
 * application services and the real `RecordsController`/`RecordsService`,
 * built via Nest DI exactly like `apps/api` wires it - the properties this
 * module exists for. See the module brief's TESTS section for the exact
 * list; each `it` block below is numbered to match.
 */
describe('records (real Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: Sql;
  let moduleRef: TestingModule;
  let academic: AcademicContract;
  let gradebook: GradebookContract;
  let access: AccessContract;
  let records: RecordsContract;
  let documents: DocumentsContract;

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
    await applyMigrations(join(__dirname, '..', '..', '..', 'domain', 'academic', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', '..', 'domain', 'enrollment', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', '..', 'platform', 'outbox', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', '..', 'platform', 'documents', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', '..', 'domain', 'gradebook', 'migrations'));
    await applyMigrations(join(__dirname, '..', 'migrations'));

    const appUrl = new URL(ownerUrl);
    appUrl.username = 'sms_app';
    appUrl.password = 'dev';

    process.env.DATABASE_URL = appUrl.toString();
    process.env.DATABASE_MIGRATION_URL = ownerUrl;
    process.env.S3_ENDPOINT ??= 'http://localhost:9000';
    process.env.S3_REGION ??= 'us-east-1';
    process.env.S3_BUCKET ??= 'sms-dev';
    process.env.S3_ACCESS_KEY ??= 'minioadmin';
    process.env.S3_SECRET_KEY ??= 'minioadmin';
    process.env.S3_FORCE_PATH_STYLE ??= 'true';

    moduleRef = await Test.createTestingModule({
      imports: [AcademicModule, GradebookModule, PeopleModule, DocumentsModule, TestReportCardTemplateModule, RecordsModule],
    }).compile();
    academic = moduleRef.get(ACADEMIC_CONTRACT);
    gradebook = moduleRef.get(GRADEBOOK_CONTRACT);
    access = moduleRef.get(ACCESS_CONTRACT);
    records = moduleRef.get(RECORDS_CONTRACT);
    documents = moduleRef.get(DOCUMENTS_CONTRACT);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await closeSqlClients();
    await ownerSql?.end({ timeout: 1 });
    await container?.stop();
  });

  // ---------------------------------------------------------------------
  // Fixture helpers - raw SQL against ownerSql (bypasses RLS, as sms_owner),
  // same precedent as gradebook.spec.ts's own helpers.
  // ---------------------------------------------------------------------
  async function createTenant(slug: string, name: string): Promise<TenantId> {
    const rows = await ownerSql`insert into tenancy.tenant (slug, name) values (${slug}, ${name}) returning id`;
    return (rows[0] as { id: string }).id as TenantId;
  }

  async function createCampus(tenantId: TenantId, code: string): Promise<CampusId> {
    const rows = await ownerSql`insert into tenancy.campus (tenant_id, code, name) values (${tenantId}, ${code}, ${code}) returning id`;
    return (rows[0] as { id: string }).id as CampusId;
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

  function baseCtx(tenantId: TenantId, userId?: UserId): { tenantId: TenantId; userId?: UserId; actorUserId?: UserId; roles: string[]; requestId: string } {
    return { tenantId, ...(userId ? { userId, actorUserId: userId } : {}), roles: [], requestId: newId() };
  }

  interface TermFixture {
    readonly termId: string;
    readonly gradingPeriodId: string;
  }

  /** A term spanning the whole academic year, plus one grading period spanning the whole term - through the REAL `AcademicContract`. */
  async function createTermFixture(ctx: ReturnType<typeof baseCtx>, academicYearId: AcademicYearId): Promise<TermFixture> {
    return runWithContext(ctx, async () => {
      const suffix = newId();
      const term = unwrap(await academic.createTerm({ academicYearId, name: `Term-${suffix}`, startsOn: '2020-01-01' as DateOnly, endsOn: '2035-01-01' as DateOnly }));
      const gradingPeriod = unwrap(await academic.createGradingPeriod({ termId: term.id, name: `GP-${suffix}`, startsOn: '2020-01-01' as DateOnly, endsOn: '2035-01-01' as DateOnly, sequence: 1 }));
      return { termId: term.id, gradingPeriodId: gradingPeriod.id };
    });
  }

  interface SectionFixture {
    readonly sectionId: string;
    readonly courseId: string;
  }

  /** A section (with a course carrying `credits`) inside an existing term - through the REAL `AcademicContract`. */
  async function createSectionInTerm(ctx: ReturnType<typeof baseCtx>, campusId: CampusId, termId: string, credits: number): Promise<SectionFixture> {
    return runWithContext(ctx, async () => {
      const suffix = newId();
      const department = unwrap(await academic.createDepartment({ code: `D-${suffix}`, name: `Dept ${suffix}` }));
      const subject = unwrap(await academic.createSubject({ departmentId: department.id, code: `S-${suffix}`, name: `Subj ${suffix}` }));
      const gradeLevel = unwrap(await academic.createGradeLevel({ code: `G-${suffix}`, name: `Grade ${suffix}` }));
      const course = unwrap(await academic.createCourse({ subjectId: subject.id, gradeLevelId: gradeLevel.id, code: `C-${suffix}`, name: `Course ${suffix}`, credits }));
      const section = unwrap(await academic.createSection({ courseId: course.id, termId, campusId, code: `SEC-${suffix}`, name: `Section ${suffix}` }));
      return { sectionId: section.id, courseId: course.id };
    });
  }

  async function enrolStudent(ctx: ReturnType<typeof baseCtx>, sectionId: string, personId: PersonId): Promise<void> {
    await runWithContext(ctx, async () => {
      unwrap(await academic.enrolStudent({ sectionId, personId }));
    });
  }

  async function assignTeacher(ctx: ReturnType<typeof baseCtx>, sectionId: string, personId: PersonId): Promise<void> {
    await runWithContext(ctx, async () => {
      unwrap(await academic.assignTeacher({ sectionId, personId, role: 'lead', validFrom: '2020-01-01' as DateOnly }));
    });
  }

  async function publishDefaultGradeScale(ctx: ReturnType<typeof baseCtx>, bands = DEFAULT_BANDS) {
    return runWithContext(ctx, async () => {
      const scale = unwrap(await gradebook.createGradeScale({ name: `Scale-${newId()}`, kind: 'percentage', isDefault: true }));
      const version = unwrap(await gradebook.publishScaleVersion({ gradeScaleId: scale.id, bands }));
      return { scale, version };
    });
  }

  async function republishGradeScale(ctx: ReturnType<typeof baseCtx>, gradeScaleId: string, bands = STRICTER_BANDS) {
    return runWithContext(ctx, async () => unwrap(await gradebook.publishScaleVersion({ gradeScaleId, bands })));
  }

  /** `DocumentsContract.generate` requires a PUBLISHED template version for the tenant, on top of the code-level registry entry - see `@sms/documents`' `1100` migration header. */
  async function publishReportCardTemplate(ctx: ReturnType<typeof baseCtx>): Promise<void> {
    await runWithContext(ctx, async () => unwrap(await documents.publishTemplateVersion({ templateKey: REPORT_CARD_TEMPLATE_KEY, html: '', css: '' })));
  }

  /** Grades one student on one new assignment in `sectionId`/`gradingPeriodId` to `percent` (out of `pointsPossible`). */
  async function gradeStudent(
    ctx: ReturnType<typeof baseCtx>,
    sectionId: string,
    gradingPeriodId: string,
    personId: PersonId,
    percent: number,
    pointsPossible = 100,
  ): Promise<void> {
    await runWithContext(ctx, async () => {
      const category = unwrap(await gradebook.createCategory({ sectionId, name: `Cat-${newId()}`, weight: 100, dropLowest: 0 }));
      const assignment = unwrap(await gradebook.createAssignment({ sectionId, categoryId: category.id, gradingPeriodId, title: 'Assignment', pointsPossible }));
      const published = unwrap(await gradebook.publishAssignment(assignment.id));
      const points = Math.round((percent / 100) * pointsPossible * 10) / 10;
      unwrap(await gradebook.enterScores({ assignmentId: published.id, idempotencyKey: `grade-${newId()}`, scores: [{ personId, points, status: 'graded' }] }));
    });
  }

  /** The one gradebook.score row for `personId`'s newest-created assignment in `sectionId` - used by test 6 to change an underlying score in place. */
  async function overwriteLatestScore(ctx: ReturnType<typeof baseCtx>, sectionId: string, gradingPeriodId: string, personId: PersonId, percent: number): Promise<void> {
    await runWithContext(ctx, async () => {
      const assignments = await gradebook.listAssignments(sectionId, gradingPeriodId);
      const assignment = [...assignments].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
      const points = Math.round((percent / 100) * assignment.pointsPossible * 10) / 10;
      unwrap(await gradebook.enterScores({ assignmentId: assignment.id, idempotencyKey: `overwrite-${newId()}`, scores: [{ personId, points, status: 'graded' }] }));
    });
  }

  // ---------------------------------------------------------------------
  // 1. RLS isolates records across tenants.
  // ---------------------------------------------------------------------
  it('1. RLS isolates records across tenants', async () => {
    const tenantX = await createTenant('tenant-rec-rls-x', 'Records RLS X');
    const tenantY = await createTenant('tenant-rec-rls-y', 'Records RLS Y');
    const campusX = await createCampus(tenantX, 'main');
    const yearX = await createAcademicYear(tenantX);
    const ctxX = baseCtx(tenantX);
    const term = await createTermFixture(ctxX, yearX);
    const section = await createSectionInTerm(ctxX, campusX, term.termId, 4);
    const personX = await createPerson(tenantX, 'RLS', 'StudentX');
    await enrolStudent(ctxX, section.sectionId, personX);
    await publishDefaultGradeScale(ctxX);
    await gradeStudent(ctxX, section.sectionId, term.gradingPeriodId, personX, 90);

    const finalised = await runWithContext(ctxX, () => records.finaliseTranscriptEntries({ personId: personX, termId: term.termId }));
    expect(finalised.ok).toBe(true);

    const createdRuleSet = await runWithContext(ctxX, () => records.createCreditRuleSet({ name: 'RLS Policy', isDefault: true }));
    expect(createdRuleSet.ok).toBe(true);

    const transcriptFromY = await runWithContext(baseCtx(tenantY), () => records.getTranscript(personX));
    expect(transcriptFromY.entries).toHaveLength(0);

    const transcriptFromX = await runWithContext(ctxX, () => records.getTranscript(personX));
    expect(transcriptFromX.entries.length).toBeGreaterThan(0);

    const ruleSetsFromY = await runWithContext(baseCtx(tenantY), () => records.listCreditRuleSets());
    expect(ruleSetsFromY).toHaveLength(0);

    // Directly against the table too, as the ordinary sms_app role with NO
    // app.tenant_id GUC set - proves RLS, not just an application filter.
    const appSqlNoContext = createSqlClient(process.env.DATABASE_URL!);
    try {
      const entryRows = await appSqlNoContext`select id from records.transcript_entry where tenant_id = ${tenantX}`;
      expect(entryRows.length).toBe(0);
      const ruleSetRows = await appSqlNoContext`select id from records.credit_rule_set where tenant_id = ${tenantX}`;
      expect(ruleSetRows.length).toBe(0);
    } finally {
      await appSqlNoContext.end({ timeout: 1 });
    }
  });

  // ---------------------------------------------------------------------
  // 2. A finalised transcript_entry cannot be UPDATEd or DELETEd at table level.
  // ---------------------------------------------------------------------
  it('2. a finalised transcript_entry cannot be UPDATEd or DELETEd at table level', async () => {
    const tenantId = await createTenant('tenant-rec-immutable', 'Records Immutable');
    const campusId = await createCampus(tenantId, 'main');
    const yearId = await createAcademicYear(tenantId);
    const ctx = baseCtx(tenantId);
    const term = await createTermFixture(ctx, yearId);
    const section = await createSectionInTerm(ctx, campusId, term.termId, 3);
    const personId = await createPerson(tenantId, 'Immutable', 'Student');
    await enrolStudent(ctx, section.sectionId, personId);
    await publishDefaultGradeScale(ctx);
    await gradeStudent(ctx, section.sectionId, term.gradingPeriodId, personId, 88);

    const finalised = await runWithContext(ctx, () => records.finaliseTranscriptEntries({ personId, termId: term.termId }));
    if (!finalised.ok) throw finalised.error;
    const entryId = finalised.value[0]!.id;

    await expect(ownerSql`update records.transcript_entry set letter = 'Z' where id = ${entryId}`).rejects.toThrow();
    await expect(ownerSql`delete from records.transcript_entry where id = ${entryId}`).rejects.toThrow();

    // And genuinely still there, unmodified.
    const rows = await ownerSql`select letter from records.transcript_entry where id = ${entryId}`;
    expect((rows[0] as { letter: string }).letter).toBe('B');
  });

  // ---------------------------------------------------------------------
  // 3. HEADLINE: a transcript does not change when a grade scale is
  //    republished - through getTranscript/calculateGpa, not by re-reading
  //    a column directly.
  // ---------------------------------------------------------------------
  it('3. a transcript does not change when a grade scale is republished', async () => {
    const tenantId = await createTenant('tenant-rec-scale-version', 'Records Scale Version');
    const campusId = await createCampus(tenantId, 'main');
    const yearId = await createAcademicYear(tenantId);
    const personId = await createPerson(tenantId, 'Stable', 'Transcript');
    const ctx = baseCtx(tenantId);
    const term = await createTermFixture(ctx, yearId);
    const section = await createSectionInTerm(ctx, campusId, term.termId, 4);
    await enrolStudent(ctx, section.sectionId, personId);

    const { scale } = await publishDefaultGradeScale(ctx);
    // 82% resolves to 'B' (gpaPoints 3) under DEFAULT_BANDS.
    await gradeStudent(ctx, section.sectionId, term.gradingPeriodId, personId, 82);

    const finalised = await runWithContext(ctx, () => records.finaliseTranscriptEntries({ personId, termId: term.termId }));
    if (!finalised.ok) throw finalised.error;
    expect(finalised.value[0]?.letter).toBe('B');
    expect(finalised.value[0]?.gpaPoints).toBe(3);

    const beforeTranscript = await runWithContext(ctx, () => records.getTranscript(personId));
    const beforeGpa = await runWithContext(ctx, () => records.calculateGpa({ personId, scope: 'cumulative' }));
    expect(beforeTranscript.entries[0]?.letter).toBe('B');
    expect(beforeGpa).toBe(3);

    // The school tightens its scale: 82% would now be an F under STRICTER_BANDS.
    await republishGradeScale(ctx, scale.id, STRICTER_BANDS);

    const afterTranscript = await runWithContext(ctx, () => records.getTranscript(personId));
    const afterGpa = await runWithContext(ctx, () => records.calculateGpa({ personId, scope: 'cumulative' }));

    expect(afterTranscript.entries[0]?.letter).toBe('B');
    expect(afterTranscript.entries[0]?.gpaPoints).toBe(3);
    expect(afterTranscript.entries[0]?.percentage).toBe(beforeTranscript.entries[0]?.percentage);
    expect(afterTranscript.cumulativeGpa).toBe(beforeTranscript.cumulativeGpa);
    expect(afterGpa).toBe(beforeGpa);
    expect(afterGpa).toBe(3);
  });

  // ---------------------------------------------------------------------
  // 4. calculateGpa weights by credits correctly.
  // ---------------------------------------------------------------------
  it('4. calculateGpa weights by credits correctly (a 1-credit A and a 4-credit C do not average to a B)', async () => {
    const tenantId = await createTenant('tenant-rec-gpa-weight', 'Records GPA Weight');
    const campusId = await createCampus(tenantId, 'main');
    const yearId = await createAcademicYear(tenantId);
    const personId = await createPerson(tenantId, 'Weighted', 'Gpa');
    const ctx = baseCtx(tenantId);
    const term = await createTermFixture(ctx, yearId);
    const oneCreditSection = await createSectionInTerm(ctx, campusId, term.termId, 1);
    const fourCreditSection = await createSectionInTerm(ctx, campusId, term.termId, 4);
    await enrolStudent(ctx, oneCreditSection.sectionId, personId);
    await enrolStudent(ctx, fourCreditSection.sectionId, personId);

    await publishDefaultGradeScale(ctx);
    await gradeStudent(ctx, oneCreditSection.sectionId, term.gradingPeriodId, personId, 95); // -> A, gpaPoints 4
    await gradeStudent(ctx, fourCreditSection.sectionId, term.gradingPeriodId, personId, 75); // -> C, gpaPoints 2

    const finalised = await runWithContext(ctx, () => records.finaliseTranscriptEntries({ personId, termId: term.termId }));
    if (!finalised.ok) throw finalised.error;
    expect(finalised.value).toHaveLength(2);

    const gpa = await runWithContext(ctx, () => records.calculateGpa({ personId, scope: 'cumulative' }));
    // Weighted: (4*1 + 2*4) / (1+4) = 12/5 = 2.4 - NOT the naive average of 3 (a B).
    expect(gpa).toBe(2.4);
    expect(gpa).not.toBe(3);

    const transcript = await runWithContext(ctx, () => records.getTranscript(personId));
    expect(transcript.cumulativeGpa).toBe(2.4);
    expect(transcript.cumulativeCreditsAttempted).toBe(5);
  });

  // ---------------------------------------------------------------------
  // 5. issueReportCards is idempotent, produces one document per student,
  //    and stamps every written row with one bulk_operation_id.
  // ---------------------------------------------------------------------
  it('5. issueReportCards is idempotent, produces one document per student, and stamps every written row with one bulk_operation_id', async () => {
    const tenantId = await createTenant('tenant-rec-issue', 'Records Issue');
    const campusId = await createCampus(tenantId, 'main');
    const yearId = await createAcademicYear(tenantId);
    const ctx = baseCtx(tenantId);
    const term = await createTermFixture(ctx, yearId);
    const section = await createSectionInTerm(ctx, campusId, term.termId, 4);
    const person1 = await createPerson(tenantId, 'Issue', 'One');
    const person2 = await createPerson(tenantId, 'Issue', 'Two');
    await enrolStudent(ctx, section.sectionId, person1);
    await enrolStudent(ctx, section.sectionId, person2);
    await publishDefaultGradeScale(ctx);
    await publishReportCardTemplate(ctx);
    await gradeStudent(ctx, section.sectionId, term.gradingPeriodId, person1, 85);
    await gradeStudent(ctx, section.sectionId, term.gradingPeriodId, person2, 92);

    const idempotencyKey = `issue-${newId()}`;
    const first = await runWithContext(ctx, () => records.issueReportCards({ gradingPeriodId: term.gradingPeriodId, idempotencyKey }));
    if (!first.ok) throw first.error;
    expect(first.value.replayed).toBe(false);
    expect(first.value.reportCards).toHaveLength(2);
    expect(first.value.run.documentCount).toBe(2);
    expect(first.value.run.bulkOperationId).toBeTruthy();

    // One document per student.
    const documentIds = new Set(first.value.reportCards.map((card) => card.documentId));
    expect(documentIds.size).toBe(2);
    const documentRows = await ownerSql`select id from documents.document where tenant_id = ${tenantId}`;
    expect(documentRows.length).toBe(2);

    // Every written row (run + both report_card rows) shares ONE bulk_operation_id.
    const historyRows = await ownerSql`
      select table_name, bulk_operation_id from audit.record_history
      where tenant_id = ${tenantId} and table_schema = 'records' and table_name in ('report_card_run', 'report_card')
    `;
    expect(historyRows.length).toBe(3);
    const bulkIds = new Set(historyRows.map((row) => (row as { bulk_operation_id: string }).bulk_operation_id));
    expect(bulkIds.size).toBe(1);
    expect([...bulkIds][0]).toBe(first.value.run.bulkOperationId);

    // Idempotent replay: same key -> the ORIGINAL result, nothing new written.
    const second = await runWithContext(ctx, () => records.issueReportCards({ gradingPeriodId: term.gradingPeriodId, idempotencyKey }));
    if (!second.ok) throw second.error;
    expect(second.value.replayed).toBe(true);
    expect(second.value.run.id).toBe(first.value.run.id);
    expect(second.value.reportCards.map((c) => c.id).sort()).toEqual(first.value.reportCards.map((c) => c.id).sort());

    const runRows = await ownerSql`select id from records.report_card_run where tenant_id = ${tenantId}`;
    expect(runRows).toHaveLength(1);
    const cardRows = await ownerSql`select id from records.report_card where tenant_id = ${tenantId}`;
    expect(cardRows).toHaveLength(2);
    const documentRowsAfterReplay = await ownerSql`select id from documents.document where tenant_id = ${tenantId}`;
    expect(documentRowsAfterReplay.length).toBe(2); // not 4
  });

  // ---------------------------------------------------------------------
  // 6. An issued report card's stored snapshot does NOT change after the
  //    underlying scores change.
  // ---------------------------------------------------------------------
  it('6. an issued report card\'s stored snapshot does not change after the underlying scores change', async () => {
    const tenantId = await createTenant('tenant-rec-snapshot', 'Records Snapshot');
    const campusId = await createCampus(tenantId, 'main');
    const yearId = await createAcademicYear(tenantId);
    const personId = await createPerson(tenantId, 'Frozen', 'Snapshot');
    const ctx = baseCtx(tenantId);
    const term = await createTermFixture(ctx, yearId);
    const section = await createSectionInTerm(ctx, campusId, term.termId, 4);
    await enrolStudent(ctx, section.sectionId, personId);
    await publishDefaultGradeScale(ctx);
    await publishReportCardTemplate(ctx);
    await gradeStudent(ctx, section.sectionId, term.gradingPeriodId, personId, 85);

    const issued = await runWithContext(ctx, () => records.issueReportCards({ gradingPeriodId: term.gradingPeriodId, idempotencyKey: `snap-${newId()}` }));
    if (!issued.ok) throw issued.error;
    const card = issued.value.reportCards.find((c) => c.personId === personId)!;
    const originalPercentage = card.snapshot.courses[0]?.percentage;
    const originalGpa = card.gpa;
    expect(originalPercentage).toBe(85);

    // The underlying score changes AFTER issue.
    await overwriteLatestScore(ctx, section.sectionId, term.gradingPeriodId, personId, 40);

    // Re-fetching the SAME report card shows exactly what was issued.
    const refetched = await runWithContext(ctx, () => records.getReportCard(card.id));
    if (!refetched.ok) throw refetched.error;
    expect(refetched.value.snapshot.courses[0]?.percentage).toBe(originalPercentage);
    expect(refetched.value.gpa).toBe(originalGpa);

    const rawSnapshotRow = await ownerSql`select snapshot from records.report_card where id = ${card.id}`;
    expect((rawSnapshotRow[0] as { snapshot: { courses: Array<{ percentage: number }> } }).snapshot.courses[0]?.percentage).toBe(85);

    // A NEW preview, computed now, reflects the new score - proving the
    // difference is "frozen snapshot" vs "live view", not a bug.
    const preview = await runWithContext(ctx, () => records.previewReportCard({ personId, gradingPeriodId: term.gradingPeriodId }));
    if (!preview.ok) throw preview.error;
    expect(preview.value.courses[0]?.percentage).toBe(40);
    expect(preview.value.courses[0]?.percentage).not.toBe(originalPercentage);
  });

  // ---------------------------------------------------------------------
  // 7. A section-scoped teacher cannot issue report cards or finalise
  //    transcripts - the real seeded posture grants Teacher read only
  //    (section-scoped), never documents.document:generate or
  //    records.transcript:finalise. This is enforced by the compiled
  //    ability `PermissionGuard` checks in production (see this module's
  //    `RecordsController` header comment for why no additional
  //    per-request scope check is needed for these two routes).
  // ---------------------------------------------------------------------
  it('7. a section-scoped teacher cannot issue report cards or finalise transcripts', async () => {
    const tenantId = await createTenant('tenant-rec-section-scope', 'Records Section Scope');
    const campusId = await createCampus(tenantId, 'main');
    const yearId = await createAcademicYear(tenantId);
    const systemCtx = baseCtx(tenantId);
    const term = await createTermFixture(systemCtx, yearId);
    const section = await createSectionInTerm(systemCtx, campusId, term.termId, 4);

    const teacherPersonId = await createPerson(tenantId, 'Section', 'Teacher');
    await assignTeacher(systemCtx, section.sectionId, teacherPersonId);
    const teacherUserId = await createUser(`records-teacher-${newId()}@example.com`);
    await createMembership(tenantId, teacherUserId, teacherPersonId);

    await seedPermissionCatalogue();
    // The real posture @sms/access seeds for Teacher: read, section-scoped -
    // never generate/finalise (see @sms/access's seed.ts).
    await grantScopedRole(tenantId, teacherUserId, 'documents.document:read', 'section');
    await grantScopedRole(tenantId, teacherUserId, 'records.transcript:read', 'section');

    const ability = await access.compileAbility(teacherUserId, tenantId);
    expect(ability.can('generate', 'documents.document')).toBe(false);
    expect(ability.can('finalise', 'records.transcript')).toBe(false);
    // Sanity: the grants that WERE made compiled into something real, so the
    // two `false`s above are a genuine denial, not an empty/broken ability.
    expect(ability.can('read', 'documents.document')).toBe(true);
    expect(ability.can('read', 'records.transcript')).toBe(true);

    // The scope-constraint layer agrees: no constraint is even reported for
    // the two permissions the teacher was never granted - PermissionGuard
    // denies these routes before this controller's own logic ever runs.
    const constraints = await access.resolveScopeConstraints(teacherUserId, tenantId);
    expect(constraints['documents.document:generate']).toBeUndefined();
    expect(constraints['records.transcript:finalise']).toBeUndefined();
  });
});
