import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Test, type TestingModule } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { GradebookController } from './api/gradebook.controller.js';
import { GradebookModule } from './api/gradebook.module.js';
import { AssignmentService } from './application/assignment.service.js';
import { CalculationRuleSetService } from './application/calculation-rule-set.service.js';
import { CategoryService } from './application/category.service.js';
import { CorrectionService } from './application/correction.service.js';
import { evaluateStudentGrade, resolveLetter } from './application/evaluator.js';
import { GradeScaleService } from './application/grade-scale.service.js';
import { GradingPeriodLockService } from './application/grading-period-lock.service.js';
import { ScoreService } from './application/score.service.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// ---------------------------------------------------------------------------
// The evaluator is a pure function - no database needed. Tested directly,
// separately from the integration suite below.
// ---------------------------------------------------------------------------
describe('evaluator (pure)', () => {
  it('4. weighting and drop-lowest produce the expected percentage, and the breakdown explains it', () => {
    const rules = {
      rounding: { decimals: 1, mode: 'half-up' as const },
      categories: [
        { name: 'Homework', weight: 20, dropLowest: 1 },
        { name: 'Exams', weight: 80, dropLowest: 0 },
      ],
    };

    const result = evaluateStudentGrade(rules, [
      {
        categoryId: 'cat-hw',
        categoryName: 'Homework',
        assignments: [
          { assignmentId: 'hw1', assignmentTitle: 'HW1', pointsPossible: 10, pointsEarned: 5, status: 'graded' }, // 50%
          { assignmentId: 'hw2', assignmentTitle: 'HW2', pointsPossible: 10, pointsEarned: 10, status: 'graded' }, // 100%
          { assignmentId: 'hw3', assignmentTitle: 'HW3', pointsPossible: 10, pointsEarned: 0, status: 'graded' }, // 0% - dropped
        ],
      },
      {
        categoryId: 'cat-exam',
        categoryName: 'Exams',
        assignments: [{ assignmentId: 'exam1', assignmentTitle: 'Midterm', pointsPossible: 100, pointsEarned: 90, status: 'graded' }], // 90%
      },
    ]);

    // Homework: drop hw3 (lowest, 0%). Remaining 5+10=15 earned / 20 possible = 75%.
    const homeworkBreakdown = result.breakdown.find((b) => b.categoryId === 'cat-hw')!;
    expect(homeworkBreakdown.percentage).toBe(75);
    expect(homeworkBreakdown.earnedPoints).toBe(15);
    expect(homeworkBreakdown.possiblePoints).toBe(20);
    const dropped = homeworkBreakdown.contributions.filter((c) => c.dropped);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.assignmentId).toBe('hw3');

    const examBreakdown = result.breakdown.find((b) => b.categoryId === 'cat-exam')!;
    expect(examBreakdown.percentage).toBe(90);

    // Overall: 75*0.20 + 90*0.80 = 15 + 72 = 87.
    expect(result.percentage).toBe(87);
  });

  it('resolveLetter picks the highest band whose min <= percentage, from any input order', () => {
    const bands = [
      { label: 'F', min: 0, gpaPoints: 0 },
      { label: 'A', min: 90, gpaPoints: 4 },
      { label: 'B', min: 80, gpaPoints: 3 },
    ];
    expect(resolveLetter(bands, 95)?.label).toBe('A');
    expect(resolveLetter(bands, 85)?.label).toBe('B');
    expect(resolveLetter(bands, 10)?.label).toBe('F');
  });

  it('exempt assignments are excluded entirely; missing counts as zero', () => {
    const rules = { rounding: { decimals: 0, mode: 'half-up' as const }, categories: [{ name: 'Homework', weight: 100, dropLowest: 0 }] };
    const result = evaluateStudentGrade(rules, [
      {
        categoryId: 'c1',
        categoryName: 'Homework',
        assignments: [
          { assignmentId: 'a1', assignmentTitle: 'A1', pointsPossible: 10, pointsEarned: 10, status: 'graded' },
          { assignmentId: 'a2', assignmentTitle: 'A2', pointsPossible: 10, pointsEarned: null, status: 'exempt' },
          { assignmentId: 'a3', assignmentTitle: 'A3', pointsPossible: 10, pointsEarned: null, status: 'missing' },
        ],
      },
    ]);
    // a2 excluded entirely; a3 counts as 0/10. So 10/20 = 50%.
    expect(result.percentage).toBe(50);
  });
});

/**
 * Applies the real `audit` + `tenancy` + `identity` + `access` + `people` +
 * `academic` + `outbox` migrations (read, never edited - see the module
 * report's constraints) and this module's own `1000` migration to a
 * throwaway container, then proves - through the real application services
 * and the real `GradebookController` (built via Nest DI exactly like
 * `apps/api` wires it, importing `AcademicModule` alongside so
 * `SECTION_SCOPE_RESOLVER` resolves for real) - the properties this module
 * exists for. See the module brief's TESTS section for the exact list; each
 * `it` block below is numbered to match.
 */
describe('gradebook (real Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: Sql;
  let moduleRef: TestingModule;
  let academic: AcademicContract;
  let access: AccessContract;
  let gradebookController: GradebookController;
  let gradeScales: GradeScaleService;
  let ruleSets: CalculationRuleSetService;
  let categoriesSvc: CategoryService;
  let assignmentsSvc: AssignmentService;
  let scoresSvc: ScoreService;
  let correctionsSvc: CorrectionService;
  let locksSvc: GradingPeriodLockService;

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
    await applyMigrations(join(__dirname, '..', '..', '..', 'platform', 'outbox', 'migrations'));
    await applyMigrations(join(__dirname, '..', 'migrations'));

    const appUrl = new URL(ownerUrl);
    appUrl.username = 'sms_app';
    appUrl.password = 'dev';

    process.env.DATABASE_URL = appUrl.toString();
    process.env.DATABASE_MIGRATION_URL = ownerUrl;

    moduleRef = await Test.createTestingModule({ imports: [AcademicModule, GradebookModule] }).compile();
    academic = moduleRef.get(ACADEMIC_CONTRACT);
    access = moduleRef.get(ACCESS_CONTRACT);
    gradebookController = moduleRef.get(GradebookController);
    gradeScales = moduleRef.get(GradeScaleService);
    ruleSets = moduleRef.get(CalculationRuleSetService);
    categoriesSvc = moduleRef.get(CategoryService);
    assignmentsSvc = moduleRef.get(AssignmentService);
    scoresSvc = moduleRef.get(ScoreService);
    correctionsSvc = moduleRef.get(CorrectionService);
    locksSvc = moduleRef.get(GradingPeriodLockService);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await closeSqlClients();
    await ownerSql?.end({ timeout: 1 });
    await container?.stop();
  });

  // ---------------------------------------------------------------------
  // Fixture helpers - raw SQL against ownerSql (bypasses RLS, as sms_owner),
  // same precedent as attendance.spec.ts's own helpers.
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

  interface SectionFixture {
    readonly sectionId: string;
    readonly gradingPeriodId: string;
  }

  /** A minimal but real section + term + grading period, through the REAL `AcademicContract` (not raw SQL). */
  async function createSectionFixture(ctx: { tenantId: TenantId; roles: string[]; requestId: string }, campusId: CampusId, academicYearId: AcademicYearId): Promise<SectionFixture> {
    return runWithContext(ctx, async () => {
      const suffix = newId();
      const department = unwrap(await academic.createDepartment({ code: `D-${suffix}`, name: `Dept ${suffix}` }));
      const subject = unwrap(await academic.createSubject({ departmentId: department.id, code: `S-${suffix}`, name: `Subj ${suffix}` }));
      const gradeLevel = unwrap(await academic.createGradeLevel({ code: `G-${suffix}`, name: `Grade ${suffix}` }));
      const course = unwrap(await academic.createCourse({ subjectId: subject.id, gradeLevelId: gradeLevel.id, code: `C-${suffix}`, name: `Course ${suffix}` }));
      const term = unwrap(await academic.createTerm({ academicYearId, name: `Term-${suffix}`, startsOn: '2020-01-01' as DateOnly, endsOn: '2035-01-01' as DateOnly }));
      const section = unwrap(await academic.createSection({ courseId: course.id, termId: term.id, campusId, code: `SEC-${suffix}`, name: `Section ${suffix}` }));
      const gradingPeriod = unwrap(
        await academic.createGradingPeriod({ termId: term.id, name: `GP-${suffix}`, startsOn: '2020-01-01' as DateOnly, endsOn: '2035-01-01' as DateOnly }),
      );
      return { sectionId: section.id, gradingPeriodId: gradingPeriod.id };
    });
  }

  async function enrolStudent(ctx: { tenantId: TenantId; roles: string[]; requestId: string }, sectionId: string, personId: PersonId): Promise<void> {
    await runWithContext(ctx, async () => {
      unwrap(await academic.enrolStudent({ sectionId, personId }));
    });
  }

  async function assignTeacher(ctx: { tenantId: TenantId; roles: string[]; requestId: string }, sectionId: string, personId: PersonId): Promise<void> {
    await runWithContext(ctx, async () => {
      unwrap(await academic.assignTeacher({ sectionId, personId, role: 'lead', validFrom: '2020-01-01' as DateOnly }));
    });
  }

  function baseCtx(tenantId: TenantId, userId?: UserId): { tenantId: TenantId; userId?: UserId; actorUserId?: UserId; roles: string[]; requestId: string } {
    return { tenantId, ...(userId ? { userId, actorUserId: userId } : {}), roles: [], requestId: newId() };
  }

  /** A single-category, single-assignment fixture ready for `enterScores`. */
  async function createGradableAssignment(
    tenantId: TenantId,
    sectionId: string,
    gradingPeriodId: string,
    pointsPossible = 100,
  ): Promise<{ categoryId: string; assignmentId: string }> {
    const category = unwrap(await categoriesSvc.createCategory(tenantId, { sectionId, name: `Cat-${newId()}`, weight: 100, dropLowest: 0 }));
    const assignment = unwrap(await assignmentsSvc.createAssignment(tenantId, { sectionId, categoryId: category.id, gradingPeriodId, title: 'Test Assignment', pointsPossible }));
    const published = unwrap(await assignmentsSvc.publishAssignment(tenantId, assignment.id));
    return { categoryId: category.id, assignmentId: published.id };
  }

  // ---------------------------------------------------------------------
  // 1. RLS isolates gradebook rows across tenants.
  // ---------------------------------------------------------------------
  it('1. RLS isolates gradebook rows across tenants', async () => {
    const tenantX = await createTenant('tenant-gb-rls-x', 'Tenant Gradebook RLS X');
    const tenantY = await createTenant('tenant-gb-rls-y', 'Tenant Gradebook RLS Y');
    const campusX = await createCampus(tenantX, 'main');
    const yearX = await createAcademicYear(tenantX);
    const personX = await createPerson(tenantX, 'RLS', 'StudentX');
    const ctxX = baseCtx(tenantX);

    const fixture = await createSectionFixture(ctxX, campusX, yearX);
    const { assignmentId } = await createGradableAssignment(tenantX, fixture.sectionId, fixture.gradingPeriodId);

    const entered = await runWithContext(ctxX, () =>
      scoresSvc.enterScores(tenantX, { assignmentId, idempotencyKey: `rls-${newId()}`, scores: [{ personId: personX, points: 90, status: 'graded' }] }),
    );
    expect(entered.ok).toBe(true);

    const scoresFromY = await runWithContext(baseCtx(tenantY), () => scoresSvc.listScoresForAssignment(tenantY, assignmentId));
    expect(scoresFromY).toHaveLength(0);

    const scoresFromX = await runWithContext(ctxX, () => scoresSvc.listScoresForAssignment(tenantX, assignmentId));
    expect(scoresFromX).toHaveLength(1);

    // Directly against the table too, as the ordinary sms_app role with NO
    // app.tenant_id GUC set - proves RLS, not just an application filter.
    const appSqlNoContext = createSqlClient(process.env.DATABASE_URL!);
    try {
      const rows = await appSqlNoContext`select id from gradebook.score where tenant_id = ${tenantX}`;
      expect(rows.length).toBe(0);
    } finally {
      await appSqlNoContext.end({ timeout: 1 });
    }
  });

  // ---------------------------------------------------------------------
  // 2. A published scale version cannot be UPDATEd or DELETEd at table level.
  // ---------------------------------------------------------------------
  it('2. a published grade scale version cannot be UPDATEd or DELETEd at table level', async () => {
    const tenantId = await createTenant('tenant-gb-immutable', 'Tenant Gradebook Immutable');
    const ctx = baseCtx(tenantId);

    const scale = await runWithContext(ctx, () => gradeScales.createGradeScale(tenantId, { name: 'Scale-A', kind: 'percentage', isDefault: true }));
    if (!scale.ok) throw scale.error;
    const version = await runWithContext(ctx, () =>
      gradeScales.publishScaleVersion(tenantId, { gradeScaleId: scale.value.id, bands: [{ label: 'A', min: 90 }, { label: 'F', min: 0 }] }),
    );
    if (!version.ok) throw version.error;

    await expect(ownerSql`update gradebook.grade_scale_version set bands = '[]'::jsonb where id = ${version.value.id}`).rejects.toThrow();
    await expect(ownerSql`delete from gradebook.grade_scale_version where id = ${version.value.id}`).rejects.toThrow();

    // Same posture for calculation_rule_set_version.
    const ruleSet = await runWithContext(ctx, () => ruleSets.createRuleSet(tenantId, { name: 'RuleSet-A', isDefault: true }));
    if (!ruleSet.ok) throw ruleSet.error;
    const ruleVersion = await runWithContext(ctx, () =>
      ruleSets.publishRuleSetVersion(tenantId, { calculationRuleSetId: ruleSet.value.id, rules: { rounding: { decimals: 1, mode: 'half-up' }, categories: [] } }),
    );
    if (!ruleVersion.ok) throw ruleVersion.error;
    await expect(ownerSql`update gradebook.calculation_rule_set_version set rules = '{}'::jsonb where id = ${ruleVersion.value.id}`).rejects.toThrow();
    await expect(ownerSql`delete from gradebook.calculation_rule_set_version where id = ${ruleVersion.value.id}`).rejects.toThrow();
  });

  // ---------------------------------------------------------------------
  // 3. HEADLINE: editing a scale creates a new version and does NOT change
  //    an existing grade's resolved letter.
  // ---------------------------------------------------------------------
  it('3. editing a scale creates a new version and does not change an existing grade\'s resolved letter', async () => {
    const tenantId = await createTenant('tenant-gb-scale-version', 'Tenant Gradebook Scale Version');
    const campusId = await createCampus(tenantId, 'main');
    const yearId = await createAcademicYear(tenantId);
    const personId = await createPerson(tenantId, 'Historical', 'Student');
    const ctx = baseCtx(tenantId);

    const fixture = await createSectionFixture(ctx, campusId, yearId);
    const { assignmentId } = await createGradableAssignment(tenantId, fixture.sectionId, fixture.gradingPeriodId, 100);

    const scale = await runWithContext(ctx, () => gradeScales.createGradeScale(tenantId, { name: 'Historical Scale', kind: 'percentage', isDefault: true }));
    if (!scale.ok) throw scale.error;
    const v1 = await runWithContext(ctx, () =>
      gradeScales.publishScaleVersion(tenantId, { gradeScaleId: scale.value.id, bands: [{ label: 'A', min: 90, gpaPoints: 4 }, { label: 'B', min: 80, gpaPoints: 3 }, { label: 'F', min: 0, gpaPoints: 0 }] }),
    );
    if (!v1.ok) throw v1.error;

    // Grade this student 85/100 = 85% -> resolves to 'B' under v1.
    const entered = await runWithContext(ctx, () =>
      scoresSvc.enterScores(tenantId, { assignmentId, idempotencyKey: `historical-${newId()}`, scores: [{ personId, points: 85, status: 'graded' }] }),
    );
    if (!entered.ok) throw entered.error;
    const historicalScore = entered.value.scores[0]!;
    expect(historicalScore.gradeScaleVersionId).toBe(v1.value.id);

    const letterAtEntry = resolveLetter(v1.value.bands, 85);
    expect(letterAtEntry?.label).toBe('B');

    // The school changes its scale mid-year: publish a v2 where 85% would
    // resolve completely differently (everything is now 'A').
    const v2 = await runWithContext(ctx, () => gradeScales.publishScaleVersion(tenantId, { gradeScaleId: scale.value.id, bands: [{ label: 'A', min: 0, gpaPoints: 4 }] }));
    if (!v2.ok) throw v2.error;
    expect(v2.value.version).toBe(2);
    expect(v2.value.id).not.toBe(v1.value.id);

    // Re-fetch the SAME historical score row: its grade_scale_version_id is
    // UNCHANGED (still v1) - editing the scale never touched it.
    const rescored = await runWithContext(ctx, () => scoresSvc.listScoresForAssignment(tenantId, assignmentId));
    const stillHistorical = rescored.find((s) => s.id === historicalScore.id)!;
    expect(stillHistorical.gradeScaleVersionId).toBe(v1.value.id);

    // Recomputing the letter through the version the score ACTUALLY points
    // at reproduces the exact same letter, regardless of v2 existing.
    const v1Refetched = await runWithContext(ctx, () => gradeScales.getVersionById(tenantId, stillHistorical.gradeScaleVersionId!));
    const recomputedLetter = resolveLetter(v1Refetched!.bands, (stillHistorical.points! / 100) * 100);
    expect(recomputedLetter?.label).toBe('B');

    // A NEW score entered now resolves through v2 instead - proving the
    // pointer genuinely moves forward for new grading, just never backward
    // for old grading.
    const personId2 = await createPerson(tenantId, 'New', 'Student');
    const enteredAfterV2 = await runWithContext(ctx, () =>
      scoresSvc.enterScores(tenantId, { assignmentId, idempotencyKey: `new-${newId()}`, scores: [{ personId: personId2, points: 85, status: 'graded' }] }),
    );
    if (!enteredAfterV2.ok) throw enteredAfterV2.error;
    expect(enteredAfterV2.value.scores[0]?.gradeScaleVersionId).toBe(v2.value.id);
  });
  // ---------------------------------------------------------------------
  // 3b. REGRESSION: the same property, through calculateSectionGrades - the
  //     path a report card actually uses.
  //
  //     Test 3 asserts the ingredients: the score row keeps its
  //     grade_scale_version_id, and resolveLetter() returns the right letter
  //     when handed the old bands. Both stayed true while the system was
  //     still re-grading, because calculateSectionGrades resolved the CURRENT
  //     default version and ignored the stamp - publishing a stricter scale
  //     silently turned an existing 82.2% from a B into a C.
  //
  //     Assert the dish, not the ingredients: go through the production path.
  // ---------------------------------------------------------------------
  it('3b. calculateSectionGrades resolves against the scale version the scores were entered under', async () => {
    const tenantId = await createTenant('tenant-gb-calc-version', 'Tenant Gradebook Calc Version');
    const campusId = await createCampus(tenantId, 'main');
    const yearId = await createAcademicYear(tenantId);
    const personId = await createPerson(tenantId, 'Stable', 'Grade');
    const ctx = baseCtx(tenantId);

    const fixture = await createSectionFixture(ctx, campusId, yearId);
    await enrolStudent(ctx, fixture.sectionId, personId);
    const { assignmentId } = await createGradableAssignment(tenantId, fixture.sectionId, fixture.gradingPeriodId, 100);

    const scale = await runWithContext(ctx, () =>
      gradeScales.createGradeScale(tenantId, { name: 'Calc Scale', kind: 'percentage', isDefault: true }),
    );
    if (!scale.ok) throw scale.error;
    const v1 = await runWithContext(ctx, () =>
      gradeScales.publishScaleVersion(tenantId, {
        gradeScaleId: scale.value.id,
        bands: [
          { label: 'A', min: 90, gpaPoints: 4 },
          { label: 'B', min: 80, gpaPoints: 3 },
          { label: 'F', min: 0, gpaPoints: 0 },
        ],
      }),
    );
    if (!v1.ok) throw v1.error;

    const entered = await runWithContext(ctx, () =>
      scoresSvc.enterScores(tenantId, {
        assignmentId,
        idempotencyKey: `calc-${newId()}`,
        scores: [{ personId, points: 82, status: 'graded' }],
      }),
    );
    if (!entered.ok) throw entered.error;

    const before = await runWithContext(ctx, () =>
      scoresSvc.calculateSectionGrades(tenantId, {
        sectionId: fixture.sectionId,
        gradingPeriodId: fixture.gradingPeriodId,
      }),
    );
    const beforeGrade = before.find((g) => g.personId === personId)!;
    expect(beforeGrade.letter).toBe('B');
    expect(beforeGrade.gradeScaleVersionId).toBe(v1.value.id);

    // The school tightens its scale: 82% would now be an F.
    const v2 = await runWithContext(ctx, () =>
      gradeScales.publishScaleVersion(tenantId, {
        gradeScaleId: scale.value.id,
        bands: [
          { label: 'A', min: 95, gpaPoints: 4 },
          { label: 'B', min: 90, gpaPoints: 3 },
          { label: 'F', min: 0, gpaPoints: 0 },
        ],
      }),
    );
    if (!v2.ok) throw v2.error;

    const after = await runWithContext(ctx, () =>
      scoresSvc.calculateSectionGrades(tenantId, {
        sectionId: fixture.sectionId,
        gradingPeriodId: fixture.gradingPeriodId,
      }),
    );
    const afterGrade = after.find((g) => g.personId === personId)!;

    // Already-marked work keeps the grade it was given.
    expect(afterGrade.letter).toBe('B');
    expect(afterGrade.gpaPoints).toBe(3);
    expect(afterGrade.gradeScaleVersionId).toBe(v1.value.id);
    expect(afterGrade.percentage).toBe(beforeGrade.percentage);

    // And a LATE entry after the republish must not re-grade the period.
    //
    // This is the case newest-stamp-wins got wrong: adding one make-up score
    // stamped v2 flipped every other score in the period onto the new scale,
    // turning an existing B into a C with nothing explaining why. A grading
    // period is graded under the scale in force when its grading began.
    const lateAssignment = await createGradableAssignment(tenantId, fixture.sectionId, fixture.gradingPeriodId, 100);
    const lateEntry = await runWithContext(ctx, () =>
      scoresSvc.enterScores(tenantId, {
        assignmentId: lateAssignment.assignmentId,
        idempotencyKey: `late-${newId()}`,
        scores: [{ personId, points: 82, status: 'graded' }],
      }),
    );
    if (!lateEntry.ok) throw lateEntry.error;
    expect(lateEntry.value.scores[0]!.gradeScaleVersionId).toBe(v2.value.id);

    const afterLate = await runWithContext(ctx, () =>
      scoresSvc.calculateSectionGrades(tenantId, {
        sectionId: fixture.sectionId,
        gradingPeriodId: fixture.gradingPeriodId,
      }),
    );
    const afterLateGrade = afterLate.find((g) => g.personId === personId)!;
    expect(afterLateGrade.gradeScaleVersionId).toBe(v1.value.id);
    expect(afterLateGrade.letter).toBe('B');
  }, 60_000);



  // ---------------------------------------------------------------------
  // 5. enterScores is idempotent, and publishes its outbox event in the
  //    same transaction; a failed transaction leaves neither.
  // ---------------------------------------------------------------------
  it('5. enterScores is idempotent and publishes gradebook.score_entered in the same transaction; a failed transaction leaves neither', async () => {
    const tenantId = await createTenant('tenant-gb-idempotent', 'Tenant Gradebook Idempotent');
    const campusId = await createCampus(tenantId, 'main');
    const yearId = await createAcademicYear(tenantId);
    const ctx = baseCtx(tenantId);
    const fixture = await createSectionFixture(ctx, campusId, yearId);
    const { assignmentId } = await createGradableAssignment(tenantId, fixture.sectionId, fixture.gradingPeriodId, 10);
    const person1 = await createPerson(tenantId, 'Idem', 'One');
    const person2 = await createPerson(tenantId, 'Idem', 'Two');
    const idempotencyKey = `idem-${newId()}`;

    const first = await runWithContext(ctx, () =>
      scoresSvc.enterScores(tenantId, {
        assignmentId,
        idempotencyKey,
        scores: [
          { personId: person1, points: 8, status: 'graded' },
          { personId: person2, points: 9, status: 'graded' },
        ],
      }),
    );
    if (!first.ok) throw first.error;
    expect(first.value.replayed).toBe(false);
    expect(first.value.scores).toHaveLength(2);

    const second = await runWithContext(ctx, () =>
      scoresSvc.enterScores(tenantId, {
        assignmentId,
        idempotencyKey,
        scores: [
          { personId: person1, points: 8, status: 'graded' },
          { personId: person2, points: 9, status: 'graded' },
        ],
      }),
    );
    if (!second.ok) throw second.error;
    expect(second.value.replayed).toBe(true);
    expect(second.value.scores.map((s) => s.id).sort()).toEqual(first.value.scores.map((s) => s.id).sort());

    const scoreRows = await ownerSql`select id from gradebook.score where tenant_id = ${tenantId} and assignment_id = ${assignmentId}`;
    expect(scoreRows).toHaveLength(2); // not 4

    const submissionRows = await ownerSql`select id from gradebook.submission where tenant_id = ${tenantId} and idempotency_key = ${idempotencyKey}`;
    expect(submissionRows).toHaveLength(1); // not 2

    const eventRows = await ownerSql`
      select id from outbox.message where tenant_id = ${tenantId} and topic = 'gradebook.score_entered' and payload->>'personId' = ${person1}
    `;
    expect(eventRows).toHaveLength(1);

    // --- Failure case: a batch whose SECOND score exceeds pointsPossible
    // (10). score[0] would insert+publish INSIDE the transaction before
    // score[1] throws - proving the whole batch (score AND event) rolls
    // back together.
    const person3 = await createPerson(tenantId, 'Outbox', 'RolledBack');
    const person4 = await createPerson(tenantId, 'Outbox', 'AlsoRolledBack');

    const failed = await runWithContext(ctx, () =>
      scoresSvc.enterScores(tenantId, {
        assignmentId,
        idempotencyKey: `outbox-fail-${newId()}`,
        scores: [
          { personId: person3, points: 5, status: 'graded' },
          { personId: person4, points: 999, status: 'graded' },
        ],
      }),
    );
    expect(failed.ok).toBe(false);

    const rolledBackScoreRows = await ownerSql`select id from gradebook.score where tenant_id = ${tenantId} and person_id = ${person3}`;
    expect(rolledBackScoreRows).toHaveLength(0);

    const rolledBackEventRows = await ownerSql`select id from outbox.message where tenant_id = ${tenantId} and payload->>'personId' = ${person3}`;
    expect(rolledBackEventRows).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // 6. A locked grading period rejects a score write; an approved
  //    correction is the only way through.
  // ---------------------------------------------------------------------
  it('6. a locked grading period rejects a score write; an approved correction is the only way through', async () => {
    const tenantId = await createTenant('tenant-gb-lock', 'Tenant Gradebook Lock');
    const campusId = await createCampus(tenantId, 'main');
    const yearId = await createAcademicYear(tenantId);
    const ctx = baseCtx(tenantId);
    const fixture = await createSectionFixture(ctx, campusId, yearId);
    const { assignmentId } = await createGradableAssignment(tenantId, fixture.sectionId, fixture.gradingPeriodId, 100);
    const personId = await createPerson(tenantId, 'Lock', 'Student');

    const entered = await runWithContext(ctx, () =>
      scoresSvc.enterScores(tenantId, { assignmentId, idempotencyKey: `lock-first-${newId()}`, scores: [{ personId, points: 70, status: 'graded' }] }),
    );
    if (!entered.ok) throw entered.error;
    const scoreId = entered.value.scores[0]!.id;

    // Free edit before locking succeeds.
    const editBeforeLock = await runWithContext(ctx, () =>
      scoresSvc.enterScores(tenantId, { assignmentId, idempotencyKey: `lock-edit-${newId()}`, scores: [{ personId, points: 75, status: 'graded' }] }),
    );
    expect(editBeforeLock.ok).toBe(true);

    const locked = await runWithContext(ctx, () => locksSvc.lockGradingPeriod(tenantId, fixture.gradingPeriodId));
    expect(locked.ok).toBe(true);
    if (!locked.ok) throw locked.error;
    expect(locked.value.locked).toBe(true);

    const editAfterLock = await runWithContext(ctx, () =>
      scoresSvc.enterScores(tenantId, { assignmentId, idempotencyKey: `lock-after-${newId()}`, scores: [{ personId, points: 80, status: 'graded' }] }),
    );
    expect(editAfterLock.ok).toBe(false);
    if (!editAfterLock.ok) {
      expect(editAfterLock.error.code).toBe('VALIDATION_ERROR');
    }

    // The score is untouched by the rejected attempt.
    const untouchedRows = await ownerSql`select points from gradebook.score where id = ${scoreId}`;
    expect(Number((untouchedRows[0] as { points: string }).points)).toBe(75);

    // The ONLY way to change it now: an approved correction.
    const correctionRequest = await runWithContext(ctx, () =>
      correctionsSvc.requestCorrection(tenantId, { scoreId, toPoints: 90, toStatus: 'graded', reason: 'Re-grade after appeal' }),
    );
    expect(correctionRequest.ok).toBe(true);
    if (!correctionRequest.ok) throw correctionRequest.error;

    const decided = await runWithContext(ctx, () => correctionsSvc.decideCorrection(tenantId, { correctionId: correctionRequest.value.id, approve: true }));
    expect(decided.ok).toBe(true);
    if (!decided.ok) throw decided.error;
    expect(decided.value.status).toBe('approved');

    const correctedRows = await ownerSql`select points from gradebook.score where id = ${scoreId}`;
    expect(Number((correctedRows[0] as { points: string }).points)).toBe(90);

    // Unlocking allows ordinary writes again.
    const unlocked = await runWithContext(ctx, () => locksSvc.unlockGradingPeriod(tenantId, fixture.gradingPeriodId));
    expect(unlocked.ok).toBe(true);
    const editAfterUnlock = await runWithContext(ctx, () =>
      scoresSvc.enterScores(tenantId, { assignmentId, idempotencyKey: `lock-unlocked-${newId()}`, scores: [{ personId, points: 95, status: 'graded' }] }),
    );
    expect(editAfterUnlock.ok).toBe(true);
  });

  // ---------------------------------------------------------------------
  // 7. A section-scoped teacher can enter scores only for their own
  //    sections.
  // ---------------------------------------------------------------------
  it('7. a section-scoped teacher can enter scores only for their own sections', async () => {
    const tenantId = await createTenant('tenant-gb-section-scope', 'Tenant Gradebook Section Scope');
    const campusId = await createCampus(tenantId, 'main');
    const yearId = await createAcademicYear(tenantId);
    const systemCtx = baseCtx(tenantId);

    const ownSection = await createSectionFixture(systemCtx, campusId, yearId);
    const otherSection = await createSectionFixture(systemCtx, campusId, yearId);

    const teacherPersonId = await createPerson(tenantId, 'Section', 'Teacher');
    await assignTeacher(systemCtx, ownSection.sectionId, teacherPersonId);

    const studentId = await createPerson(tenantId, 'Section', 'Student');
    await enrolStudent(systemCtx, ownSection.sectionId, studentId);
    const otherStudentId = await createPerson(tenantId, 'Other', 'Student');
    await enrolStudent(systemCtx, otherSection.sectionId, otherStudentId);

    const { assignmentId: ownAssignmentId } = await createGradableAssignment(tenantId, ownSection.sectionId, ownSection.gradingPeriodId);
    const { assignmentId: otherAssignmentId } = await createGradableAssignment(tenantId, otherSection.sectionId, otherSection.gradingPeriodId);

    const teacherUserId = await createUser(`section-teacher-${newId()}@example.com`);
    await createMembership(tenantId, teacherUserId, teacherPersonId);

    await seedPermissionCatalogue();
    await grantScopedRole(tenantId, teacherUserId, 'academic.gradebook:read', 'section');
    await grantScopedRole(tenantId, teacherUserId, 'academic.gradebook:write', 'section');

    const teacherCtx = baseCtx(tenantId, teacherUserId);

    const constraintCheck = await access.resolveScopeConstraints(teacherUserId, tenantId);
    expect(constraintCheck['academic.gradebook:write']).toEqual({ kind: 'section', sectionIds: [ownSection.sectionId] });

    // --- entering scores for OWN section's assignment succeeds...
    const ownEntry = await runWithContext(teacherCtx, () =>
      gradebookController.enterScores(ownAssignmentId, { idempotencyKey: `scope-own-${newId()}`, scores: [{ personId: studentId, points: 88, status: 'graded' }] }),
    );
    expect(ownEntry.scores).toHaveLength(1);

    // ...but the OTHER section's assignment is forbidden, before any write happens.
    await expect(
      runWithContext(teacherCtx, () =>
        gradebookController.enterScores(otherAssignmentId, { idempotencyKey: `scope-other-${newId()}`, scores: [{ personId: otherStudentId, points: 88, status: 'graded' }] }),
      ),
    ).rejects.toThrow(/do not have access/i);

    const otherSectionScoreRows = await ownerSql`select id from gradebook.score where tenant_id = ${tenantId} and assignment_id = ${otherAssignmentId}`;
    expect(otherSectionScoreRows).toHaveLength(0);

    // --- reading the OTHER section's assignments is likewise forbidden.
    await expect(runWithContext(teacherCtx, () => gradebookController.listAssignments(otherSection.sectionId))).rejects.toThrow(/do not have access/i);

    // --- but the teacher's own section's assignments list succeeds.
    const ownAssignments = await runWithContext(teacherCtx, () => gradebookController.listAssignments(ownSection.sectionId));
    expect(ownAssignments.map((a: { id: string }) => a.id)).toContain(ownAssignmentId);
  });
});
