#!/usr/bin/env tsx
/**
 * Idempotent local-dev/CI seed data: a published school-wide announcement, a
 * published grade-level announcement, a published announcement addressed
 * directly to `parent@greenwood.test`'s own linked guardian, and one open
 * thread (with a couple of messages) between `teacher@greenwood.test` and
 * that same guardian, about a real seeded child of theirs.
 *
 * Two audience-resolution facts drove the shape below, both real seed-data
 * quirks this script does not control (`@sms/people`'s own seed sets `may_
 * receive_comms` per relationship, and not every guardian has it `true` for
 * every child):
 *
 *   1. Threads do not care about `may_receive_comms` at all - it only
 *      governs whether an ANNOUNCEMENT'S audience query resolves to someone.
 *      A guardian can be in a conversation about their child regardless of
 *      whether they are flagged to receive broadcast announcements. So the
 *      thread's guardian/child pair is resolved with NO `may_receive_comms`
 *      filter, and always prefers `parent@greenwood.test`'s own linked
 *      guardian and one of their real children.
 *
 *   2. The GRADE-LEVEL announcement's audience, by contrast, genuinely is a
 *      `may_receive_comms = true` query (see `AnnouncementService.
 *      resolveAudience`) - so it is resolved honestly, preferring `parent@
 *      greenwood.test`'s own guardian but falling back to a different
 *      eligible guardian/child pair if theirs has no `may_receive_comms =
 *      true` relationship to a currently-enrolled child (which is exactly
 *      what happens for the seeded "Luis Alvarez" -> `parent@greenwood.test`
 *      link: both his relationships are `may_receive_comms = false`). That
 *      is the audience filter working correctly, not a bug - but it does
 *      mean `parent@greenwood.test` may legitimately not be in that
 *      particular announcement's frozen recipient list.
 *
 * To still guarantee `parent@greenwood.test` has SOMETHING to see in the
 * live demo regardless of that flag, a THIRD announcement is seeded with an
 * explicit `personIds` audience naming their own linked guardian directly -
 * a realistic use of the `personIds` escape hatch (a hand-picked, personal
 * note), not a workaround of `may_receive_comms`'s meaning.
 *
 * Complements (does not modify - see the module report's constraints)
 * `@sms/tenancy`'s, `@sms/identity`'s, `@sms/access`'s, `@sms/people`'s and
 * `@sms/academic`'s own `seed.ts` - AND `@sms/access`'s `seed-demo-logins.ts`,
 * which must run BEFORE this script (unlike every other domain module's own
 * seed, this one specifically needs `parent@greenwood.test`'s person link to
 * already exist). Every write check-then-creates (or relies on a real DB
 * constraint) so re-running this script converges rather than duplicating
 * rows.
 *
 * Usage: tsx src/seed.ts (run LAST - after tenancy's, identity's, access's,
 * people's, academic's seeds AND access's seed-demo-logins.ts). Not wired
 * into `apps/api`'s `db:seed` chain - that script lives at `apps/api/
 * package.json`, outside this module's allowed edit paths (see the module
 * report's constraints); run this seed manually as the very last step.
 */
import 'reflect-metadata';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Test, type TestingModule } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { closeSqlClients, runWithContext, withSystemTx } from '@sms/db';
import { OUTBOX_CONTRACT, OutboxModule, type OutboxContract } from '@sms/outbox';
import { newId, type PersonId, type TenantId, type UserId } from '@sms/kernel';
import { AnnouncementService } from './application/announcement.service.js';
import { ThreadService } from './application/thread.service.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// Resolved relative to this file, not process.cwd() - see @sms/tenancy's migrate.ts/seed.ts for why.
try {
  process.loadEnvFile(join(__dirname, '..', '..', '..', '..', '.env'));
} catch {
  // no .env file present - assume the environment already has what we need
}

const ADMIN_EMAIL = 'admin@greenwood.test';
const TEACHER_EMAIL = 'teacher@greenwood.test';
const PARENT_EMAIL = 'parent@greenwood.test';

/**
 * `OutboxService` (the concrete `OUTBOX_CONTRACT` implementation) is an
 * internal `@sms/outbox` class - only the port/token and `OutboxModule` are
 * exported. A minimal Nest DI container just for `OutboxModule` is the only
 * way to obtain a real one outside `apps/api`'s own bootstrap - same
 * precedent as `@sms/attendance`'s `seed.ts` (`buildRecordService`).
 * `.compile()` alone (no `.init()`) deliberately does not run `OutboxModule.
 * onApplicationBootstrap`, so this does not start a background dispatcher
 * loop that would otherwise keep this script's process alive.
 */
async function buildServices(): Promise<{ announcements: AnnouncementService; threads: ThreadService }> {
  seedModule = await Test.createTestingModule({ imports: [OutboxModule] }).compile();
  const moduleRef = seedModule;
  const outbox = moduleRef.get<OutboxContract>(OUTBOX_CONTRACT);
  return { announcements: new AnnouncementService(outbox), threads: new ThreadService(outbox) };
}

async function findTenantId(): Promise<TenantId> {
  const rows = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from tenancy.tenant where slug = 'greenwood' limit 1`));
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error('No tenant with slug "greenwood" found. Run @sms/tenancy\'s seed first.');
  }
  return row.id as TenantId;
}

async function findUserId(email: string, ranAfterHint: string): Promise<UserId> {
  const rows = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from identity.user where email = ${email} limit 1`));
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error(`No user "${email}" found. ${ranAfterHint}`);
  }
  return row.id as UserId;
}

async function findPersonIdForUser(tenantId: TenantId, userId: UserId, email: string): Promise<PersonId> {
  const rows = await withSystemTx((db) =>
    db.execute<{ person_id: string | null }>(
      sql`select person_id from identity.membership where tenant_id = ${tenantId} and user_id = ${userId} limit 1`,
    ),
  );
  const personId = (rows as unknown as Array<{ person_id: string | null }>)[0]?.person_id;
  if (!personId) {
    throw new Error(`"${email}"'s membership has no linked person record.`);
  }
  return personId as PersonId;
}

type GradeLevelPairRow = {
  readonly guardian_person_id: string;
  readonly child_person_id: string;
  readonly grade_level_id: string;
  readonly grade_level_name: string;
};

/**
 * A (guardian, currently-enrolled child) pair with `may_receive_comms =
 * true` - the real audience filter `resolveAudience`'s `gradeLevel` kind
 * applies. PREFERS `preferGuardianPersonId`, falling back to any other
 * eligible pair in the tenant when theirs has none (see this file's own
 * header, point 2).
 */
async function findGradeLevelAudiencePair(tenantId: TenantId, preferGuardianPersonId: PersonId): Promise<GradeLevelPairRow> {
  const rows = await withSystemTx((db) =>
    db.execute<GradeLevelPairRow>(sql`
      select r.from_person_id as guardian_person_id, se.person_id as child_person_id,
             c.grade_level_id, gl.name as grade_level_name
      from people.relationship r
      join academic.section_enrollment se
        on se.person_id = r.to_person_id
       and se.tenant_id = r.tenant_id
       and se.valid_from <= current_date
       and (se.valid_to is null or se.valid_to >= current_date)
      join academic.section sec on sec.id = se.section_id
      join academic.course c on c.id = sec.course_id
      join academic.grade_level gl on gl.id = c.grade_level_id
      where r.tenant_id = ${tenantId} and r.may_receive_comms = true
      order by (r.from_person_id = ${preferGuardianPersonId}) desc, r.created_at
      limit 1
    `),
  );
  const row = (rows as unknown as GradeLevelPairRow[])[0];
  if (!row) {
    throw new Error(
      'No (guardian, currently-enrolled child) pair with may_receive_comms = true found. Run @sms/people\'s and @sms/academic\'s seeds first.',
    );
  }
  return row;
}

type ChildRow = {
  readonly child_person_id: string;
  readonly given_name: string;
  readonly family_name: string;
  readonly grade_level_name: string;
};

/**
 * A currently-enrolled child of `guardianPersonId` specifically - NO `may_
 * receive_comms` filter (see this file's own header, point 1: a thread does
 * not care about that flag). Falls back to any other guardian/child pair in
 * the tenant if `guardianPersonId` has no currently-enrolled child of their
 * own at all (should not happen for a login `@sms/access`'s `seed-demo-
 * logins.ts` picked as `guardian_with_children`, but handled rather than
 * assumed).
 */
async function findEnrolledChildForGuardian(tenantId: TenantId, guardianPersonId: PersonId): Promise<ChildRow> {
  const rows = await withSystemTx((db) =>
    db.execute<ChildRow>(sql`
      select se.person_id as child_person_id, p.given_name, p.family_name, gl.name as grade_level_name
      from people.relationship r
      join academic.section_enrollment se
        on se.person_id = r.to_person_id
       and se.tenant_id = r.tenant_id
       and se.valid_from <= current_date
       and (se.valid_to is null or se.valid_to >= current_date)
      join people.person p on p.id = se.person_id
      join academic.section sec on sec.id = se.section_id
      join academic.course c on c.id = sec.course_id
      join academic.grade_level gl on gl.id = c.grade_level_id
      where r.tenant_id = ${tenantId}
      order by (r.from_person_id = ${guardianPersonId}) desc, r.created_at
      limit 1
    `),
  );
  const row = (rows as unknown as ChildRow[])[0];
  if (!row) {
    throw new Error('No (guardian, currently-enrolled child) pair found at all. Run @sms/people\'s and @sms/academic\'s seeds first.');
  }
  return row;
}

async function main(): Promise<void> {
  const tenantId = await findTenantId();
  const adminUserId = await findUserId(ADMIN_EMAIL, "Run @sms/identity's seed first.");
  const teacherUserId = await findUserId(TEACHER_EMAIL, "Run @sms/academic's seed first (it creates this login).");
  const parentUserId = await findUserId(
    PARENT_EMAIL,
    "Run @sms/access's seed-demo-logins.ts first (it creates this login) - see this file's own header.",
  );

  const teacherPersonId = await findPersonIdForUser(tenantId, teacherUserId, TEACHER_EMAIL);
  const parentPersonId = await findPersonIdForUser(tenantId, parentUserId, PARENT_EMAIL);

  const gradeLevelPair = await findGradeLevelAudiencePair(tenantId, parentPersonId);
  if ((gradeLevelPair.guardian_person_id as PersonId) !== parentPersonId) {
    console.log(
      `  note   "${PARENT_EMAIL}"'s linked guardian has no may_receive_comms=true currently-enrolled child - ` +
        `the grade-level announcement's audience organically falls back to a different guardian ` +
        `(${gradeLevelPair.guardian_person_id}). That is the real audience filter working correctly, not a bug - ` +
        `see this file's own header.`,
    );
  }

  const parentsChild = await findEnrolledChildForGuardian(tenantId, parentPersonId);

  const { announcements, threads } = await buildServices();
  const adminCtx = { tenantId, userId: adminUserId, actorUserId: adminUserId, roles: [], requestId: newId() };
  const teacherCtx = { tenantId, userId: teacherUserId, actorUserId: teacherUserId, roles: [], requestId: newId() };

  // -------------------------------------------------------------------
  // 1. A published, school-wide announcement.
  // -------------------------------------------------------------------
  const schoolWideTitle = 'Welcome back for the new term';
  const existingSchoolWide = (await announcements.listAnnouncements(tenantId, {})).find((a) => a.title === schoolWideTitle);
  if (!existingSchoolWide) {
    const created = await announcements.createAnnouncement(tenantId, {
      title: schoolWideTitle,
      body: "We are excited to welcome every family back for the new term. Please check the school calendar for key dates, and reach out to your child's teacher with any questions.",
      category: 'General',
      audience: { kind: 'tenant' },
    });
    if (!created.ok) throw created.error;
    const published = await runWithContext(adminCtx, () => announcements.publishAnnouncement(tenantId, created.value.id));
    if (!published.ok) throw published.error;
    console.log(`  create + publish school-wide announcement "${schoolWideTitle}"`);
  } else {
    console.log(`  skip   school-wide announcement "${schoolWideTitle}" (already exists)`);
  }

  // -------------------------------------------------------------------
  // 2. A published, grade-level announcement - real `may_receive_comms`
  //    audience resolution (see this file's own header, point 2).
  // -------------------------------------------------------------------
  const gradeLevelTitle = `${gradeLevelPair.grade_level_name} field trip permission slips due`;
  const existingGradeLevel = (await announcements.listAnnouncements(tenantId, {})).find((a) => a.title === gradeLevelTitle);
  if (!existingGradeLevel) {
    const created = await announcements.createAnnouncement(tenantId, {
      title: gradeLevelTitle,
      body: `Permission slips for the upcoming ${gradeLevelPair.grade_level_name} field trip are due back to the front office by Friday.`,
      category: 'Event',
      audience: { kind: 'gradeLevel', gradeLevelId: gradeLevelPair.grade_level_id },
    });
    if (!created.ok) throw created.error;
    const published = await runWithContext(adminCtx, () => announcements.publishAnnouncement(tenantId, created.value.id));
    if (!published.ok) throw published.error;
    console.log(`  create + publish grade-level announcement "${gradeLevelTitle}"`);
  } else {
    console.log(`  skip   grade-level announcement "${gradeLevelTitle}" (already exists)`);
  }

  // -------------------------------------------------------------------
  // 3. A published announcement addressed directly to parent@greenwood.
  //    test's own guardian - guarantees they have something to see in the
  //    live demo regardless of their may_receive_comms flags (see this
  //    file's own header).
  // -------------------------------------------------------------------
  const personalTitle = `${parentsChild.given_name} ${parentsChild.family_name}: attendance follow-up`;
  const existingPersonal = (await announcements.listAnnouncements(tenantId, {})).find((a) => a.title === personalTitle);
  if (!existingPersonal) {
    const created = await announcements.createAnnouncement(tenantId, {
      title: personalTitle,
      body: `A note for ${parentsChild.given_name}'s family: thank you for confirming the recent absences. Please let the front office know if you need anything.`,
      category: 'General',
      audience: { kind: 'personIds', personIds: [parentPersonId] },
    });
    if (!created.ok) throw created.error;
    const published = await runWithContext(adminCtx, () => announcements.publishAnnouncement(tenantId, created.value.id));
    if (!published.ok) throw published.error;
    console.log(`  create + publish personal announcement "${personalTitle}"`);
  } else {
    console.log(`  skip   personal announcement "${personalTitle}" (already exists)`);
  }

  // -------------------------------------------------------------------
  // 4. One thread between the teacher and parent@greenwood.test's own
  //    guardian, about their real child - a couple of messages. Threads do
  //    not depend on may_receive_comms (see this file's own header, point 1).
  // -------------------------------------------------------------------
  const threadSubject = `Attendance check-in for ${parentsChild.given_name} ${parentsChild.family_name}`;
  const existingThreads = await threads.listThreads(tenantId, { subjectType: 'people.person', subjectId: parentsChild.child_person_id });
  const existingThread = existingThreads.find((t) => t.subject === threadSubject);
  if (!existingThread) {
    const started = await runWithContext(teacherCtx, () =>
      threads.startThread(tenantId, teacherUserId, {
        subject: threadSubject,
        subjectType: 'people.person',
        subjectId: parentsChild.child_person_id,
        participantPersonIds: [teacherPersonId, parentPersonId],
        firstMessage: "Hi - I wanted to check in, as I've noticed a few recent absences. Is everything okay at home?",
      }),
    );
    if (!started.ok) throw started.error;
    const threadId = started.value.id;
    console.log(`  create thread "${started.value.subject}" (teacher <-> guardian)`);

    const reply = await runWithContext(teacherCtx, () =>
      threads.postMessage(tenantId, parentPersonId, {
        threadId,
        body: 'Thank you for reaching out - we had a bout of illness at home but everything is fine now. Sorry for not letting you know sooner!',
        idempotencyKey: `seed-${threadId}-reply-1`,
      }),
    );
    if (!reply.ok) throw reply.error;

    const followUp = await runWithContext(teacherCtx, () =>
      threads.postMessage(tenantId, teacherPersonId, {
        threadId,
        body: 'Glad to hear it! Thanks for letting me know - feel free to reach out any time.',
        idempotencyKey: `seed-${threadId}-followup-1`,
      }),
    );
    if (!followUp.ok) throw followUp.error;
    console.log('  post   2 messages to the thread');
  } else {
    console.log(`  skip   thread "${threadSubject}" (already exists)`);
  }

  console.log('seed complete');
  console.log('');
  console.log(`  guardian (parent@greenwood.test) ${parentPersonId}`);
  console.log(`  child    ${parentsChild.given_name} ${parentsChild.family_name} (${parentsChild.child_person_id}, grade level: ${parentsChild.grade_level_name})`);
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
