#!/usr/bin/env tsx
/**
 * Idempotent local-dev/CI seed data: a default "Standard A-F" percentage
 * grade scale (with GPA points) and its first published version, a
 * "Standard Weighted" calculation rule set (Homework 20 / Quizzes 30 /
 * Exams 50, drop-lowest-1 on Homework) and its first published version, one
 * grading period per term, Homework/Quizzes/Exams categories and 5
 * assignments (2 homework, 2 quizzes, 1 exam - all published) per section
 * `@sms/academic`'s seed creates, and scores for every enrolled student
 * producing a believable spread (~75-98%, deterministic so re-running this
 * seed reproduces the same numbers).
 *
 * Complements (does not modify - see the module report's constraints)
 * `@sms/tenancy`'s, `@sms/identity`'s, `@sms/access`'s, `@sms/people`'s and
 * `@sms/academic`'s own `seed.ts`: all five must have already run (this
 * script looks up the "greenwood" tenant, its sections/terms/rosters, and
 * `teacher@greenwood.test`, and fails with a clear message if any is
 * missing). `@sms/academic`'s seed does not create any grading period, so
 * this script creates one per term through the real `AcademicContract`
 * (`createGradingPeriod`) - the one piece of academic structure this module
 * needs that upstream did not provide.
 *
 * Usage: tsx src/seed.ts (run after tenancy's, identity's, access's,
 * people's and academic's). Not wired into `apps/api`'s `db:seed` chain -
 * that script lives at `apps/api/package.json`, outside this module's
 * allowed edit paths (see the module report's constraints); run this seed
 * manually as the last step.
 */
import 'reflect-metadata';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Test, type TestingModule } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { closeSqlClients, runWithContext, withSystemTx } from '@sms/db';
import { OUTBOX_CONTRACT, OutboxModule, type OutboxContract } from '@sms/outbox';
import { ACADEMIC_CONTRACT, AcademicModule, type AcademicContract } from '@sms/academic';
import { newId, todayDateOnly, type DateOnly, type PersonId, type TenantId, type UserId } from '@sms/kernel';
import { AssignmentService } from './application/assignment.service.js';
import { CalculationRuleSetService } from './application/calculation-rule-set.service.js';
import { CategoryService } from './application/category.service.js';
import { GradeScaleService } from './application/grade-scale.service.js';
import { ScoreService } from './application/score.service.js';
import type { CalculationRules, GradeBand, ScoreStatus } from './domain/types.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

try {
  process.loadEnvFile(join(__dirname, '..', '..', '..', '..', '.env'));
} catch {
  // no .env file present - assume the environment already has what we need
}

const TEACHER_EMAIL = 'teacher@greenwood.test';

const gradeScales = new GradeScaleService();
const ruleSets = new CalculationRuleSetService();
const categories = new CategoryService();

/**
 * A minimal Nest DI container for `AcademicModule` + `OutboxModule` - the
 * only way to obtain the real `ACADEMIC_CONTRACT`/`OUTBOX_CONTRACT` outside
 * `apps/api`'s own bootstrap (same precedent as `@sms/attendance`'s
 * `seed.ts`'s `buildRecordService`). `.compile()` alone (no `.init()`)
 * deliberately does NOT run either module's `onApplicationBootstrap`, so
 * this does not start a background dispatcher loop.
 */
async function buildServices(): Promise<{ academic: AcademicContract; assignments: AssignmentService; scores: ScoreService }> {
  seedModule = await Test.createTestingModule({ imports: [AcademicModule, OutboxModule] }).compile();
  const moduleRef = seedModule;
  const academic = moduleRef.get<AcademicContract>(ACADEMIC_CONTRACT);
  const outbox = moduleRef.get<OutboxContract>(OUTBOX_CONTRACT);
  return { academic, assignments: new AssignmentService(outbox), scores: new ScoreService(outbox, gradeScales, ruleSets) };
}

async function findGreenwoodTenantId(): Promise<TenantId> {
  const rows = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from tenancy.tenant where slug = 'greenwood' limit 1`));
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error('No tenant with slug "greenwood" found. Run @sms/tenancy\'s seed first.');
  }
  return row.id as TenantId;
}

async function findTeacherUserId(): Promise<UserId> {
  const rows = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from identity.user where email = ${TEACHER_EMAIL} limit 1`));
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error(`No user "${TEACHER_EMAIL}" found. Run @sms/academic's seed first (it creates this login).`);
  }
  return row.id as UserId;
}

type TermRow = { readonly id: string; readonly name: string; readonly starts_on: string; readonly ends_on: string };

async function listTerms(tenantId: TenantId): Promise<TermRow[]> {
  const rows = await withSystemTx((db) => db.execute<TermRow>(sql`select id, name, starts_on::text, ends_on::text from academic.term where tenant_id = ${tenantId} order by sequence`));
  return rows as unknown as TermRow[];
}

async function ensureGradingPeriod(academic: AcademicContract, ctx: { tenantId: TenantId; roles: string[]; requestId: string }, term: TermRow): Promise<string> {
  const existingRows = await withSystemTx((db) =>
    db.execute<{ id: string }>(sql`select id from academic.grading_period where tenant_id = ${ctx.tenantId} and term_id = ${term.id} limit 1`),
  );
  const existing = (existingRows as unknown as Array<{ id: string }>)[0];
  if (existing) {
    console.log(`  skip   grading period for term "${term.name}" (already exists)`);
    return existing.id;
  }
  return runWithContext(ctx, async () => {
    const created = await academic.createGradingPeriod({
      termId: term.id,
      name: `${term.name} - Full Period`,
      startsOn: term.starts_on as DateOnly,
      endsOn: term.ends_on as DateOnly,
      sequence: 1,
    });
    if (!created.ok) throw created.error;
    console.log(`  create grading period for term "${term.name}"`);
    return created.value.id;
  });
}

type SectionRow = { readonly id: string; readonly code: string; readonly term_id: string };

async function listSections(tenantId: TenantId): Promise<SectionRow[]> {
  const rows = await withSystemTx((db) => db.execute<SectionRow>(sql`select id, code, term_id from academic.section where tenant_id = ${tenantId} order by code`));
  return rows as unknown as SectionRow[];
}

type RosterRow = { readonly person_id: string };

async function listRoster(tenantId: TenantId, sectionId: string): Promise<PersonId[]> {
  const rows = await withSystemTx((db) =>
    db.execute<RosterRow>(sql`select person_id from academic.section_enrollment where tenant_id = ${tenantId} and section_id = ${sectionId}`),
  );
  return (rows as unknown as RosterRow[]).map((row) => row.person_id as PersonId);
}

const DEFAULT_SCALE_NAME = 'Standard A-F';
const BANDS: GradeBand[] = [
  { label: 'A', min: 90, gpaPoints: 4.0 },
  { label: 'B', min: 80, gpaPoints: 3.0 },
  { label: 'C', min: 70, gpaPoints: 2.0 },
  { label: 'D', min: 60, gpaPoints: 1.0 },
  { label: 'F', min: 0, gpaPoints: 0.0 },
];

const DEFAULT_RULE_SET_NAME = 'Standard Weighted';
const RULES: CalculationRules = {
  rounding: { decimals: 1, mode: 'half-up' },
  categories: [
    { name: 'Homework', weight: 20, dropLowest: 1 },
    { name: 'Quizzes', weight: 30, dropLowest: 0 },
    { name: 'Exams', weight: 50, dropLowest: 0 },
  ],
};

async function ensureDefaultScale(tenantId: TenantId): Promise<void> {
  const existing = await gradeScales.listGradeScales(tenantId);
  if (existing.some((scale) => scale.name === DEFAULT_SCALE_NAME)) {
    console.log(`  skip   grade scale "${DEFAULT_SCALE_NAME}" (already exists)`);
    return;
  }
  const created = await gradeScales.createGradeScale(tenantId, { name: DEFAULT_SCALE_NAME, kind: 'percentage', isDefault: true });
  if (!created.ok) throw created.error;
  const published = await gradeScales.publishScaleVersion(tenantId, { gradeScaleId: created.value.id, bands: BANDS });
  if (!published.ok) throw published.error;
  console.log(`  create grade scale "${DEFAULT_SCALE_NAME}" (v${published.value.version})`);
}

async function ensureDefaultRuleSet(tenantId: TenantId): Promise<void> {
  const existing = await ruleSets.listRuleSets(tenantId);
  if (existing.some((set) => set.name === DEFAULT_RULE_SET_NAME)) {
    console.log(`  skip   calculation rule set "${DEFAULT_RULE_SET_NAME}" (already exists)`);
    return;
  }
  const created = await ruleSets.createRuleSet(tenantId, { name: DEFAULT_RULE_SET_NAME, isDefault: true });
  if (!created.ok) throw created.error;
  const published = await ruleSets.publishRuleSetVersion(tenantId, { calculationRuleSetId: created.value.id, rules: RULES });
  if (!published.ok) throw published.error;
  console.log(`  create calculation rule set "${DEFAULT_RULE_SET_NAME}" (v${published.value.version})`);
}

interface CategoryPlan {
  readonly name: string;
  readonly weight: number;
  readonly dropLowest: number;
}
const CATEGORY_PLAN: CategoryPlan[] = [
  { name: 'Homework', weight: 20, dropLowest: 1 },
  { name: 'Quizzes', weight: 30, dropLowest: 0 },
  { name: 'Exams', weight: 50, dropLowest: 0 },
];

async function ensureCategories(tenantId: TenantId, sectionId: string): Promise<Map<string, string>> {
  const existing = await categories.listCategories(tenantId, sectionId);
  const byName = new Map(existing.map((c) => [c.name, c.id]));
  for (const [index, plan] of CATEGORY_PLAN.entries()) {
    if (byName.has(plan.name)) continue;
    const created = await categories.createCategory(tenantId, { sectionId, name: plan.name, weight: plan.weight, dropLowest: plan.dropLowest, sequence: index });
    if (!created.ok) throw created.error;
    byName.set(plan.name, created.value.id);
  }
  return byName;
}

interface AssignmentPlan {
  readonly category: string;
  readonly title: string;
  readonly pointsPossible: number;
  readonly dueOffsetDays: number;
}
const ASSIGNMENT_PLAN: AssignmentPlan[] = [
  { category: 'Homework', title: 'Homework 1', pointsPossible: 20, dueOffsetDays: 3 },
  { category: 'Homework', title: 'Homework 2', pointsPossible: 20, dueOffsetDays: 10 },
  { category: 'Quizzes', title: 'Quiz 1', pointsPossible: 25, dueOffsetDays: 7 },
  { category: 'Quizzes', title: 'Quiz 2', pointsPossible: 25, dueOffsetDays: 14 },
  { category: 'Exams', title: 'Midterm Exam', pointsPossible: 100, dueOffsetDays: 20 },
];

function addDays(date: DateOnly, days: number): DateOnly {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const next = new Date(year, month - 1, day);
  next.setDate(next.getDate() + days);
  const y = next.getFullYear().toString().padStart(4, '0');
  const m = (next.getMonth() + 1).toString().padStart(2, '0');
  const d = next.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}` as DateOnly;
}

/** Deterministic (not random) so re-running this seed produces the exact same scores - required for idempotency. Spreads roughly 75-98%, with the occasional low outlier so the drop-lowest-1 rule on Homework has something real to drop. */
function pickPercentage(assignmentIndex: number, studentIndex: number): number {
  const hash = (assignmentIndex * 13 + studentIndex * 7) % 100;
  if (hash < 8) return 55 + (hash % 10); // one deliberately low outlier band, ~8% of the time
  return 75 + (hash % 24); // 75-98%
}

async function seedSection(
  tenantId: TenantId,
  ctx: { tenantId: TenantId; userId: UserId; actorUserId: UserId; roles: string[]; requestId: string },
  assignmentsSvc: AssignmentService,
  scoreSvc: ScoreService,
  section: SectionRow,
  gradingPeriodId: string,
  termStartsOn: DateOnly,
): Promise<number> {
  const categoryIds = await ensureCategories(tenantId, section.id);
  const roster = await listRoster(tenantId, section.id);
  if (roster.length === 0) {
    console.log(`  skip   assignments for section "${section.code}" (no enrolled students)`);
    return 0;
  }

  let assignmentsCreated = 0;
  for (const [assignmentIndex, plan] of ASSIGNMENT_PLAN.entries()) {
    const categoryId = categoryIds.get(plan.category);
    if (!categoryId) throw new Error(`Category "${plan.category}" missing for section ${section.code}.`);

    const existingAssignments = await assignmentsSvc.listAssignments(tenantId, section.id, gradingPeriodId);
    let assignment = existingAssignments.find((a) => a.title === plan.title);
    if (!assignment) {
      const created = await assignmentsSvc.createAssignment(tenantId, {
        sectionId: section.id,
        categoryId,
        gradingPeriodId,
        title: plan.title,
        pointsPossible: plan.pointsPossible,
        dueOn: addDays(termStartsOn, plan.dueOffsetDays),
      });
      if (!created.ok) throw created.error;
      assignment = created.value;
      assignmentsCreated += 1;
    }
    if (!assignment.published) {
      const published = await assignmentsSvc.publishAssignment(tenantId, assignment.id);
      if (!published.ok) throw published.error;
    }

    const scoresInput = roster.map((personId, studentIndex) => {
      const percentage = pickPercentage(assignmentIndex, studentIndex);
      const points = Math.round((percentage / 100) * plan.pointsPossible * 10) / 10;
      return { personId, points, status: 'graded' as ScoreStatus };
    });

    await runWithContext(ctx, () =>
      scoreSvc.enterScores(tenantId, {
        assignmentId: assignment!.id,
        idempotencyKey: `seed-${assignment!.id}`,
        scores: scoresInput,
      }),
    );
  }
  return assignmentsCreated;
}

async function main(): Promise<void> {
  const tenantId = await findGreenwoodTenantId();
  const teacherUserId = await findTeacherUserId();
  const { academic, assignments: assignmentsSvc, scores: scoreSvc } = await buildServices();

  await ensureDefaultScale(tenantId);
  await ensureDefaultRuleSet(tenantId);

  const systemCtx = { tenantId, roles: [], requestId: newId() };
  const terms = await listTerms(tenantId);
  if (terms.length === 0) {
    throw new Error('No terms found. Run @sms/academic\'s seed first.');
  }
  const gradingPeriodIdByTermId = new Map<string, string>();
  for (const term of terms) {
    gradingPeriodIdByTermId.set(term.id, await ensureGradingPeriod(academic, systemCtx, term));
  }

  const sections = await listSections(tenantId);
  if (sections.length === 0) {
    throw new Error('No sections found. Run @sms/academic\'s seed first.');
  }

  const ctx = { tenantId, userId: teacherUserId, actorUserId: teacherUserId, roles: [], requestId: newId() };

  let totalAssignmentsCreated = 0;
  for (const section of sections) {
    const gradingPeriodId = gradingPeriodIdByTermId.get(section.term_id);
    const term = terms.find((t) => t.id === section.term_id);
    if (!gradingPeriodId || !term) {
      console.log(`  skip   section "${section.code}" (no grading period for its term)`);
      continue;
    }
    totalAssignmentsCreated += await seedSection(tenantId, ctx, assignmentsSvc, scoreSvc, section, gradingPeriodId, term.starts_on as DateOnly);
  }

  console.log(`  create ${totalAssignmentsCreated} new assignment(s) across ${sections.length} section(s)`);
  console.log(`  today (${todayDateOnly()}) - grades are computable via calculateSectionGrades for every seeded section`);
  console.log('seed complete');
}

/** Closed in the `finally` below - see `@sms/attendance`'s seed for why. */
let seedModule: TestingModule | undefined;

main()
  .catch((error: unknown) => {
    console.error('seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await seedModule?.close();
    await closeSqlClients();
  });
