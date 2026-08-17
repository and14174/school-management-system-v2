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
import { CommunicationsController } from './api/communications.controller.js';
import { CommunicationsModule } from './api/communications.module.js';
import { AnnouncementService } from './application/announcement.service.js';
import { ThreadService } from './application/thread.service.js';
import { COMMUNICATIONS_CONTRACT, type CommunicationsContract } from './contract.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

/**
 * Applies the real `audit` + `tenancy` + `identity` + `access` + `people` +
 * `academic` + `outbox` migrations (read, never edited - see the module
 * report's constraints) and this module's own `1350` migration to a
 * throwaway container, then proves - through the real application services
 * and the real `CommunicationsController` (built via Nest DI exactly like
 * `apps/api` wires it, importing `AcademicModule` alongside so `people.
 * student:read`'s `section` scope resolves for real - same precedent as
 * `@sms/attendance`'s own `attendance.spec.ts`), not reimplementations of
 * them - the properties this module exists for. See the module brief's
 * TESTS section for the exact list; each `it` block below is numbered to
 * match.
 */
describe('communications (real Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: Sql;
  let moduleRef: TestingModule;
  let access: AccessContract;
  let academic: AcademicContract;
  let communicationsController: CommunicationsController;
  let communications: CommunicationsContract;
  let announcements: AnnouncementService;
  let threads: ThreadService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('sms_test')
      .withUsername('sms_owner')
      .withPassword('dev')
      .start();

    const ownerUrl = container.getConnectionUri();
    ownerSql = createSqlClient(ownerUrl);

    await ownerSql`create role sms_app with login password 'dev' nobypassrls`;
    await ownerSql`grant connect on database sms_test to sms_app`;

    // Read each module's migrations folder rather than naming files - see
    // this module brief's own "Test specs must read their module's
    // migrations folder" note (docs/decisions.md).
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

    moduleRef = await Test.createTestingModule({ imports: [AcademicModule, CommunicationsModule] }).compile();
    access = moduleRef.get(ACCESS_CONTRACT);
    academic = moduleRef.get(ACADEMIC_CONTRACT);
    communicationsController = moduleRef.get(CommunicationsController);
    communications = moduleRef.get(COMMUNICATIONS_CONTRACT);
    announcements = moduleRef.get(AnnouncementService);
    threads = moduleRef.get(ThreadService);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await closeSqlClients();
    await ownerSql?.end({ timeout: 1 });
    await container?.stop();
  });

  // ---------------------------------------------------------------------
  // Fixture helpers - raw SQL against ownerSql (bypasses RLS, as sms_owner),
  // same precedent as attendance.spec.ts's own createTenant/createUser/
  // createPerson helpers.
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

  async function createRelationship(tenantId: TenantId, fromPersonId: PersonId, toPersonId: PersonId, mayReceiveComms: boolean): Promise<void> {
    await ownerSql`
      insert into people.relationship (id, tenant_id, from_person_id, to_person_id, type, may_receive_comms)
      values (${newId()}, ${tenantId}, ${fromPersonId}, ${toPersonId}, 'parent', ${mayReceiveComms})
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

  /** A role granting exactly `permissionKey` at `scope`, assigned to `userId` in `tenantId`. */
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

  interface GradeLevelFixture {
    readonly sectionId: string;
    readonly gradeLevelId: string;
  }

  /** A minimal but real department/subject/grade-level/course/term/section, through the REAL `AcademicContract` - so `resolveAudience`'s `gradeLevel` join against real academic tables is exercised exactly as production would. */
  async function createGradeLevelFixture(
    ctx: { tenantId: TenantId; roles: string[]; requestId: string },
    campusId: CampusId,
    academicYearId: AcademicYearId,
  ): Promise<GradeLevelFixture> {
    return runWithContext(ctx, async () => {
      const suffix = newId();
      const department = unwrap(await academic.createDepartment({ code: `D-${suffix}`, name: `Dept ${suffix}` }));
      const subject = unwrap(await academic.createSubject({ departmentId: department.id, code: `S-${suffix}`, name: `Subj ${suffix}` }));
      const gradeLevel = unwrap(await academic.createGradeLevel({ code: `G-${suffix}`, name: `Grade ${suffix}` }));
      const course = unwrap(
        await academic.createCourse({ subjectId: subject.id, gradeLevelId: gradeLevel.id, code: `C-${suffix}`, name: `Course ${suffix}` }),
      );
      const term = unwrap(
        await academic.createTerm({ academicYearId, name: `Term-${suffix}`, startsOn: '2020-01-01' as DateOnly, endsOn: '2035-01-01' as DateOnly }),
      );
      const section = unwrap(
        await academic.createSection({ courseId: course.id, termId: term.id, campusId, code: `SEC-${suffix}`, name: `Section ${suffix}` }),
      );
      return { sectionId: section.id, gradeLevelId: gradeLevel.id };
    });
  }

  async function enrolStudent(ctx: { tenantId: TenantId; roles: string[]; requestId: string }, sectionId: string, personId: PersonId): Promise<void> {
    await runWithContext(ctx, async () => {
      unwrap(await academic.enrolStudent({ sectionId, personId }));
    });
  }

  // ---------------------------------------------------------------------
  // 1. RLS isolates announcements, threads and messages across tenants.
  // ---------------------------------------------------------------------
  it('1. RLS isolates announcements, threads and messages across tenants', async () => {
    const tenantX = await createTenant('tenant-comms-rls-x', 'Tenant Comms RLS X');
    const tenantY = await createTenant('tenant-comms-rls-y', 'Tenant Comms RLS Y');
    const personX = await createPerson(tenantX, 'RLS', 'PersonX');

    const created = await announcements.createAnnouncement(tenantX, {
      title: 'RLS test announcement',
      body: 'Body',
      category: 'General',
      audience: { kind: 'personIds', personIds: [personX] },
    });
    if (!created.ok) throw created.error;
    const published = await runWithContext(baseCtx(tenantX), () => announcements.publishAnnouncement(tenantX, created.value.id));
    if (!published.ok) throw published.error;

    const started = await runWithContext(baseCtx(tenantX), () =>
      threads.startThread(tenantX, null, {
        subject: 'RLS thread',
        subjectType: 'people.person',
        subjectId: personX,
        participantPersonIds: [personX],
        firstMessage: 'hello',
      }),
    );
    if (!started.ok) throw started.error;

    // Cross-tenant reads via the real services return nothing for tenantY.
    const announcementFromY = await announcements.getAnnouncement(tenantY, created.value.id);
    expect(announcementFromY.ok).toBe(false);

    const threadFromY = await threads.getThread(tenantY, started.value.id);
    expect(threadFromY.ok).toBe(false);

    const listFromY = await announcements.listAnnouncements(tenantY, {});
    expect(listFromY).toHaveLength(0);

    const threadsFromY = await threads.listThreads(tenantY, {});
    expect(threadsFromY).toHaveLength(0);

    // Directly against the tables too, as the ordinary sms_app role with NO
    // app.tenant_id GUC set - rules out an application-level filter doing
    // the work RLS is supposed to.
    const appSqlNoContext = createSqlClient(process.env.DATABASE_URL!);
    try {
      const announcementRows = await appSqlNoContext`select id from communications.announcement where tenant_id = ${tenantX}`;
      expect(announcementRows.length).toBe(0);
      const threadRows = await appSqlNoContext`select id from communications.thread where tenant_id = ${tenantX}`;
      expect(threadRows.length).toBe(0);
      const messageRows = await appSqlNoContext`select id from communications.message where tenant_id = ${tenantX}`;
      expect(messageRows.length).toBe(0);
    } finally {
      await appSqlNoContext.end({ timeout: 1 });
    }
  });

  // ---------------------------------------------------------------------
  // 2. A message cannot be UPDATEd or DELETEd at table level.
  // ---------------------------------------------------------------------
  it('2. a message cannot be UPDATEd or DELETEd at table level', async () => {
    const tenantId = await createTenant('tenant-comms-append-only', 'Tenant Comms Append Only');
    const personA = await createPerson(tenantId, 'Append', 'Only');

    const started = await runWithContext(baseCtx(tenantId), () =>
      threads.startThread(tenantId, null, {
        subject: 'Append-only test',
        subjectType: 'other',
        subjectId: newId(),
        participantPersonIds: [personA],
        firstMessage: 'original message',
      }),
    );
    if (!started.ok) throw started.error;

    const messageRows = await ownerSql`select id from communications.message where tenant_id = ${tenantId} and thread_id = ${started.value.id}`;
    const messageId = (messageRows[0] as { id: string }).id;

    await expect(ownerSql`update communications.message set body = 'edited' where id = ${messageId}`).rejects.toThrow(
      /append-only/i,
    );
    await expect(ownerSql`delete from communications.message where id = ${messageId}`).rejects.toThrow(/append-only/i);

    const stillThereRows = await ownerSql`select body from communications.message where id = ${messageId}`;
    expect((stillThereRows[0] as { body: string }).body).toBe('original message');
  });

  // ---------------------------------------------------------------------
  // 3. A published announcement's title/body cannot be changed; supersede
  //    creates a new one and links the old.
  // ---------------------------------------------------------------------
  it("3. a published announcement's title/body cannot be changed; supersede creates a new one and links the old", async () => {
    const tenantId = await createTenant('tenant-comms-supersede', 'Tenant Comms Supersede');
    const personA = await createPerson(tenantId, 'Supersede', 'Recipient');

    const created = await announcements.createAnnouncement(tenantId, {
      title: 'Original title',
      body: 'Original body',
      category: 'General',
      audience: { kind: 'personIds', personIds: [personA] },
    });
    if (!created.ok) throw created.error;
    const ctx = baseCtx(tenantId);
    const published = await runWithContext(ctx, () => announcements.publishAnnouncement(tenantId, created.value.id));
    if (!published.ok) throw published.error;
    expect(published.value.status).toBe('published');

    // Direct SQL UPDATE of title/body on a published announcement is
    // refused at the table level - trigger-enforced, not merely
    // application-level.
    await expect(
      ownerSql`update communications.announcement set title = 'Hacked title' where id = ${published.value.id}`,
    ).rejects.toThrow(/immutable/i);

    const unchangedRows = await ownerSql`select title, body from communications.announcement where id = ${published.value.id}`;
    expect((unchangedRows[0] as { title: string }).title).toBe('Original title');

    // But a non-content field (status/superseded_by_announcement_id) CAN be
    // updated straight through the database - proving the trigger
    // discriminates rather than blanket-denying (same posture as
    // attendance.correction's trigger).
    await expect(
      ownerSql`update communications.announcement set status = 'superseded' where id = ${published.value.id}`,
    ).resolves.toBeDefined();
    await ownerSql`update communications.announcement set status = 'published' where id = ${published.value.id}`;

    // supersedeAnnouncement issues a NEW announcement and links the old one
    // - the old row's own title/body are never touched by it either.
    const superseded = await runWithContext(ctx, () =>
      announcements.supersedeAnnouncement(tenantId, published.value.id, { title: 'Corrected title', body: 'Corrected body' }),
    );
    if (!superseded.ok) throw superseded.error;
    expect(superseded.value.title).toBe('Corrected title');
    expect(superseded.value.status).toBe('published');
    expect(superseded.value.id).not.toBe(published.value.id);

    const originalAfter = await announcements.getAnnouncement(tenantId, published.value.id);
    if (!originalAfter.ok) throw originalAfter.error;
    expect(originalAfter.value.status).toBe('superseded');
    expect(originalAfter.value.supersededByAnnouncementId).toBe(superseded.value.id);
    // The original's content is untouched by the correction.
    expect(originalAfter.value.title).toBe('Original title');
    expect(originalAfter.value.body).toBe('Original body');
  });

  // ---------------------------------------------------------------------
  // 4. The frozen audience does not change: publish to a resolved set,
  //    then change who would match, and assert the recipient list is
  //    unchanged.
  // ---------------------------------------------------------------------
  it('4. the frozen audience does not change after who would match it changes', async () => {
    const tenantId = await createTenant('tenant-comms-frozen-audience', 'Tenant Comms Frozen Audience');
    const campusId = await createCampus(tenantId, 'main');
    const yearId = await createAcademicYear(tenantId);
    const systemCtx = baseCtx(tenantId);
    const fixture = await createGradeLevelFixture(systemCtx, campusId, yearId);

    const studentA = await createPerson(tenantId, 'Grade', 'StudentA');
    const guardianA = await createPerson(tenantId, 'Grade', 'GuardianA');
    await createRelationship(tenantId, guardianA, studentA, true);
    await enrolStudent(systemCtx, fixture.sectionId, studentA);

    const created = await announcements.createAnnouncement(tenantId, {
      title: 'Grade-level notice',
      body: 'Body',
      category: 'Event',
      audience: { kind: 'gradeLevel', gradeLevelId: fixture.gradeLevelId },
    });
    if (!created.ok) throw created.error;
    const published = await runWithContext(systemCtx, () => announcements.publishAnnouncement(tenantId, created.value.id));
    if (!published.ok) throw published.error;

    const recipientsAtPublish = await announcements.listAnnouncementRecipients(tenantId, published.value.id);
    expect(recipientsAtPublish.map((r) => r.personId).sort()).toEqual([guardianA].sort());

    // Now change who WOULD match: enrol a second student in the same
    // section, with a guardian who ALSO may_receive_comms.
    const studentB = await createPerson(tenantId, 'Grade', 'StudentB');
    const guardianB = await createPerson(tenantId, 'Grade', 'GuardianB');
    await createRelationship(tenantId, guardianB, studentB, true);
    await enrolStudent(systemCtx, fixture.sectionId, studentB);

    // Re-resolving the query today would now include guardianB - but the
    // FROZEN recipient list must not.
    const recipientsAfter = await announcements.listAnnouncementRecipients(tenantId, published.value.id);
    expect(recipientsAfter.map((r) => r.personId).sort()).toEqual([guardianA].sort());
    expect(recipientsAfter.map((r) => r.personId)).not.toContain(guardianB);

    const recipientRows = await ownerSql`
      select person_id from communications.announcement_recipient where tenant_id = ${tenantId} and announcement_id = ${published.value.id}
    `;
    expect(recipientRows).toHaveLength(1);
    expect((recipientRows[0] as { person_id: string }).person_id).toBe(guardianA);
  });

  // ---------------------------------------------------------------------
  // 5. postMessage is idempotent on its key and publishes its outbox event
  //    in the same transaction; a failed call leaves neither.
  // ---------------------------------------------------------------------
  it('5. postMessage is idempotent on its key, publishes its outbox event in the same transaction, and a failed call leaves neither', async () => {
    const tenantId = await createTenant('tenant-comms-idempotent', 'Tenant Comms Idempotent');
    const personA = await createPerson(tenantId, 'Idem', 'Participant');
    const personB = await createPerson(tenantId, 'Idem', 'NotAParticipant');

    const ctx = baseCtx(tenantId);
    const started = await runWithContext(ctx, () =>
      threads.startThread(tenantId, null, {
        subject: 'Idempotency test',
        subjectType: 'other',
        subjectId: newId(),
        participantPersonIds: [personA],
        firstMessage: 'opening message',
      }),
    );
    if (!started.ok) throw started.error;
    const threadId = started.value.id;
    const key = `idem-${newId()}`;

    const first = await runWithContext(ctx, () =>
      threads.postMessage(tenantId, personA, { threadId, body: 'hello there', idempotencyKey: key }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw first.error;
    expect(first.value.replayed).toBe(false);

    const messageRows = await ownerSql`select id from communications.message where tenant_id = ${tenantId} and idempotency_key = ${key}`;
    expect(messageRows).toHaveLength(1);
    const outboxRows = await ownerSql`
      select id from outbox.message where tenant_id = ${tenantId} and topic = 'communications.message_posted' and payload->>'messageId' = ${first.value.message.id}
    `;
    expect(outboxRows).toHaveLength(1);

    // Replay: same key, writes nothing further - neither the message nor a
    // second outbox event.
    const second = await runWithContext(ctx, () =>
      threads.postMessage(tenantId, personA, { threadId, body: 'hello there (replay attempt)', idempotencyKey: key }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw second.error;
    expect(second.value.replayed).toBe(true);
    expect(second.value.message.id).toBe(first.value.message.id);

    const messageRowsAfterReplay = await ownerSql`select id from communications.message where tenant_id = ${tenantId} and idempotency_key = ${key}`;
    expect(messageRowsAfterReplay).toHaveLength(1);
    const outboxRowsAfterReplay = await ownerSql`
      select id from outbox.message where tenant_id = ${tenantId} and topic = 'communications.message_posted' and payload->>'messageId' = ${first.value.message.id}
    `;
    expect(outboxRowsAfterReplay).toHaveLength(1);

    // A failed call (personB is not a participant) writes NEITHER a message
    // row nor an outbox event for its own (unused) idempotency key - the
    // whole thing runs inside one transaction and nothing survives the
    // rejection.
    const failKey = `idem-fail-${newId()}`;
    const failed = await runWithContext(ctx, () =>
      threads.postMessage(tenantId, personB, { threadId, body: 'should not be written', idempotencyKey: failKey }),
    );
    expect(failed.ok).toBe(false);

    const failedMessageRows = await ownerSql`select id from communications.message where tenant_id = ${tenantId} and idempotency_key = ${failKey}`;
    expect(failedMessageRows).toHaveLength(0);
    const failedOutboxRows = await ownerSql`
      select id from outbox.message where tenant_id = ${tenantId} and topic = 'communications.message_posted' and payload->>'authorPersonId' = ${personB}
    `;
    expect(failedOutboxRows).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // 6. A person who is not a participant cannot read a thread - via the
  //    real read path, not a hand-filtered list.
  // ---------------------------------------------------------------------
  it('6. a person who is not a participant cannot read a thread, via the real read path', async () => {
    const tenantId = await createTenant('tenant-comms-thread-scope', 'Tenant Comms Thread Scope');
    const participantPersonId = await createPerson(tenantId, 'Thread', 'Participant');
    const outsiderPersonId = await createPerson(tenantId, 'Thread', 'Outsider');

    const started = await runWithContext(baseCtx(tenantId), () =>
      threads.startThread(tenantId, null, {
        subject: 'Scope test thread',
        subjectType: 'other',
        subjectId: newId(),
        participantPersonIds: [participantPersonId],
        firstMessage: 'private conversation',
      }),
    );
    if (!started.ok) throw started.error;
    const threadId = started.value.id;

    await seedPermissionCatalogue();

    const participantUserId = await createUser(`thread-participant-${newId()}@example.com`);
    await createMembership(tenantId, participantUserId, participantPersonId);
    await grantScopedRole(tenantId, participantUserId, 'people.student:read', 'own');

    const outsiderUserId = await createUser(`thread-outsider-${newId()}@example.com`);
    await createMembership(tenantId, outsiderUserId, outsiderPersonId);
    await grantScopedRole(tenantId, outsiderUserId, 'people.student:read', 'own');

    const constraintCheck = await access.resolveScopeConstraints(outsiderUserId, tenantId);
    expect(constraintCheck['people.student:read']).toEqual({ kind: 'own', personId: outsiderPersonId });

    // The outsider is denied through the REAL controller path - a targeted
    // participation check (isThreadParticipant), not a fetch-then-filter.
    const outsiderCtx = baseCtx(tenantId, outsiderUserId, outsiderPersonId);
    await expect(runWithContext(outsiderCtx, () => communicationsController.getThread(threadId))).rejects.toThrow(/do not have access/i);

    // The real participant CAN read it.
    const participantCtx = baseCtx(tenantId, participantUserId, participantPersonId);
    const detail = await runWithContext(participantCtx, () => communicationsController.getThread(threadId));
    expect(detail.thread.id).toBe(threadId);
    expect(detail.participants.map((p) => p.personId)).toContain(participantPersonId);
    expect(detail.messages).toHaveLength(1);
  });

  // ---------------------------------------------------------------------
  // 7. getUnreadCounts reflects unread announcements and messages, and
  //    drops to zero after marking read.
  // ---------------------------------------------------------------------
  it('7. getUnreadCounts reflects unread announcements and messages, and drops to zero after marking read', async () => {
    const tenantId = await createTenant('tenant-comms-unread', 'Tenant Comms Unread');
    const personA = await createPerson(tenantId, 'Unread', 'PersonA');
    const personB = await createPerson(tenantId, 'Unread', 'PersonB');
    const ctx = baseCtx(tenantId, undefined, personA);

    const createdAnnouncement = await announcements.createAnnouncement(tenantId, {
      title: 'Unread test announcement',
      body: 'Body',
      category: 'General',
      audience: { kind: 'personIds', personIds: [personA] },
    });
    if (!createdAnnouncement.ok) throw createdAnnouncement.error;
    const publishedAnnouncement = await runWithContext(ctx, () => announcements.publishAnnouncement(tenantId, createdAnnouncement.value.id));
    if (!publishedAnnouncement.ok) throw publishedAnnouncement.error;

    const started = await runWithContext(ctx, () =>
      threads.startThread(tenantId, null, {
        subject: 'Unread test thread',
        subjectType: 'other',
        subjectId: newId(),
        participantPersonIds: [personA, personB],
        firstMessage: 'first message from starter (personA)',
      }),
    );
    if (!started.ok) throw started.error;
    // personA authored the opening message, so it does not count as unread
    // for personA - post one from personB so there is something for
    // personA to actually be behind on.
    const reply = await runWithContext(ctx, () =>
      threads.postMessage(tenantId, personB, {
        threadId: started.value.id,
        body: 'reply from personB',
        idempotencyKey: `unread-reply-${newId()}`,
      }),
    );
    if (!reply.ok) throw reply.error;

    const before = await runWithContext(ctx, () => communications.getUnreadCounts(personA));
    expect(before.unreadAnnouncements).toBe(1);
    expect(before.unreadThreads).toBe(1);

    const markedAnnouncement = await runWithContext(ctx, () =>
      communications.markAnnouncementRead({ announcementId: publishedAnnouncement.value.id, personId: personA }),
    );
    expect(markedAnnouncement.ok).toBe(true);

    const markedThread = await runWithContext(ctx, () => communications.markThreadRead({ threadId: started.value.id, personId: personA }));
    expect(markedThread.ok).toBe(true);

    const after = await runWithContext(ctx, () => communications.getUnreadCounts(personA));
    expect(after.unreadAnnouncements).toBe(0);
    expect(after.unreadThreads).toBe(0);
  });
});
