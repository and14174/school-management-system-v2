import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type PersonId, type TenantContext, type TenantId } from '@sms/kernel';
import { closeSqlClients, createSqlClient, runWithContext, type Sql } from '@sms/db';
import type { OutboxMessage } from '@sms/outbox';
import { AttendanceAbsenceSubscriber } from './application/attendance-absence.subscriber.js';
import { NotificationsService } from './application/notifications.service.js';
import { InMemoryNotificationChannel, MapNotificationChannelRegistry } from './application/channel-registry.js';
import type { NotificationRecipient, RecipientResolver, ResolveRecipientsInput } from './application/recipient-resolver.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

/** A `RecipientResolver` a test can point at whatever recipients it needs for one `subjectId`, controllable per test. */
class FakeRecipientResolver implements RecipientResolver {
  private byline = new Map<string, NotificationRecipient[]>();

  set(subjectId: string, recipients: NotificationRecipient[]): void {
    this.byline.set(subjectId, recipients);
  }

  async resolve(input: ResolveRecipientsInput): Promise<NotificationRecipient[]> {
    return this.byline.get(input.subjectId) ?? [];
  }
}

/**
 * Applies the real `audit` + `tenancy` + `identity` + `outbox` migrations
 * (read, never edited - see the module report's constraints) and this
 * module's own `1300` migration to a throwaway Postgres container, then
 * proves - through the real `NotificationsService` and
 * `AttendanceAbsenceSubscriber`, not reimplementations of them - the
 * properties this module exists for. Same structure as `@sms/documents`'
 * `documents.spec.ts` and `@sms/outbox`'s `outbox.spec.ts`.
 *
 * Uses `InMemoryNotificationChannel` (shipped from this module itself, see
 * `channel-registry.ts`'s own comment) and `FakeRecipientResolver` (this
 * file) rather than the real email/console-SMS adapters or the real
 * `people.relationship` walker - those are `apps/api`'s concern, proven
 * live in the module report's end-to-end verification instead.
 */
describe('notifications (real Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: Sql;

  // notifications.template_version.created_by_user_id FK identity.user - a
  // real row is required, same precedent as @sms/documents' documents.spec.ts
  // createUser helper.
  async function createUser(email: string): Promise<string> {
    const rows = await ownerSql`insert into identity.user (id, name, email) values (${newId()}, ${email}, ${email}) returning id`;
    return (rows[0] as { id: string }).id;
  }

  async function ctxFor(tenantId: TenantId): Promise<TenantContext> {
    const userId = await createUser(`${newId()}@example.com`);
    return { tenantId, roles: [], requestId: newId(), userId, actorUserId: userId } as unknown as TenantContext;
  }

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

    const applyMigrations = async (dir: string): Promise<void> => {
      const files = readdirSync(dir)
        .filter((name) => name.endsWith('.sql'))
        .sort((a, b) => a.localeCompare(b, 'en'));
      for (const file of files) {
        await ownerSql.unsafe(readFileSync(join(dir, file), 'utf8'));
      }
    };

    // Read each module's migrations folder rather than naming files - see
    // access.spec.ts/documents.spec.ts for why a hardcoded file list stops
    // applying anything added later.
    await applyMigrations(join(__dirname, '..', '..', 'audit', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', 'tenancy', 'migrations'));
    // notifications.template_version.created_by_user_id FK identity.user -
    // same precedent as @sms/documents' own spec applying identity's
    // migrations for the same reason.
    await applyMigrations(join(__dirname, '..', '..', 'identity', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', 'outbox', 'migrations'));
    await applyMigrations(join(__dirname, '..', 'migrations'));

    const appUrl = new URL(ownerUrl);
    appUrl.username = 'sms_app';
    appUrl.password = 'dev';
    process.env.DATABASE_URL = appUrl.toString();
    process.env.DATABASE_MIGRATION_URL = ownerUrl;
  }, 180_000);

  afterAll(async () => {
    await closeSqlClients();
    await ownerSql?.end({ timeout: 1 });
    await container?.stop();
  });

  async function createTenant(slug: string, name: string): Promise<TenantId> {
    const rows = await ownerSql`insert into tenancy.tenant (slug, name) values (${slug}, ${name}) returning id`;
    return (rows[0] as { id: string }).id as TenantId;
  }

  it('isolates templates, notifications and deliveries across tenants (RLS)', async () => {
    const tenantA = await createTenant(`notif-rls-a-${newId()}`, 'Notif RLS A');
    const tenantB = await createTenant(`notif-rls-b-${newId()}`, 'Notif RLS B');
    const ctxA = await ctxFor(tenantA);
    const ctxB = await ctxFor(tenantB);

    const resolver = new FakeRecipientResolver();
    const channel = new InMemoryNotificationChannel('email');
    const registry = new MapNotificationChannelRegistry([channel]);
    const notifications = new NotificationsService(resolver, registry);

    const guardianId = newId();
    const studentId = newId();
    resolver.set(studentId, [{ personId: guardianId as PersonId, mayReceiveComms: true, reason: 'parent', addresses: { email: 'guardian@example.com' } }]);

    const published = await runWithContext(ctxA, () =>
      notifications.publishTemplateVersion({
        templateKey: 'rls.test',
        channel: 'email',
        bodyTemplate: 'Hello {{studentId}}',
      }),
    );
    expect(published.ok).toBe(true);

    const notifyResult = await runWithContext(ctxA, () =>
      notifications.notify({
        templateKey: 'rls.test',
        category: 'general',
        subjectType: 'people.person',
        subjectId: studentId,
        payload: { studentId },
        dedupeKey: `rls-${newId()}`,
      }),
    );
    expect(notifyResult.ok).toBe(true);
    if (!notifyResult.ok) return;

    // Tenant B sees nothing of tenant A's templates, notifications or deliveries.
    const templatesForB = await runWithContext(ctxB, () => notifications.listTemplates());
    expect(templatesForB.find((t) => t.key === 'rls.test')).toBeUndefined();

    const deliveriesForB = await runWithContext(ctxB, () => notifications.listDeliveries({ notificationId: notifyResult.value.notification.id }));
    expect(deliveriesForB).toEqual([]);

    // Directly against the table too, ruling out an application-level filter
    // doing the work RLS is supposed to.
    const appSqlNoContext = createSqlClient(process.env.DATABASE_URL!);
    try {
      const rows = await appSqlNoContext`select id from notifications.notification where tenant_id = ${tenantA}`;
      expect(rows.length).toBe(0); // no app.tenant_id GUC set -> zero rows, never "every tenant"
    } finally {
      await appSqlNoContext.end({ timeout: 1 });
    }

    // Sanity: tenant A still sees its own data.
    const deliveriesForA = await runWithContext(ctxA, () => notifications.listDeliveries({ notificationId: notifyResult.value.notification.id }));
    expect(deliveriesForA.length).toBe(1);
  });

  it('a published template version cannot be UPDATEd or DELETEd at the table level', async () => {
    const tenantId = await createTenant(`notif-immutable-${newId()}`, 'Notif Immutable');
    const ctx = await ctxFor(tenantId);
    const notifications = new NotificationsService();

    const published = await runWithContext(ctx, () =>
      notifications.publishTemplateVersion({ templateKey: 'immutable.test', channel: 'email', bodyTemplate: 'v1 body' }),
    );
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const versionId = published.value.id;

    await expect(
      ownerSql`update notifications.template_version set body_template = 'v2 body' where id = ${versionId}`,
    ).rejects.toThrow(/immutable/i);
    await expect(ownerSql`delete from notifications.template_version where id = ${versionId}`).rejects.toThrow(/immutable/i);

    const [row] = await ownerSql`select body_template from notifications.template_version where id = ${versionId}`;
    expect((row as { body_template: string }).body_template).toBe('v1 body');
  });

  it('consent is enforced at SEND time: an opted-out preference and a mayReceiveComms:false relationship both suppress, with a reason - never a silent send and never a missing row', async () => {
    const tenantId = await createTenant(`notif-consent-${newId()}`, 'Notif Consent');
    const ctx = await ctxFor(tenantId);

    const resolver = new FakeRecipientResolver();
    const channel = new InMemoryNotificationChannel('email');
    const registry = new MapNotificationChannelRegistry([channel]);
    const notifications = new NotificationsService(resolver, registry);

    await runWithContext(ctx, () =>
      notifications.publishTemplateVersion({ templateKey: 'attendance.absence', channel: 'email', bodyTemplate: 'Absent on {{date}}' }),
    );

    const studentId = newId();
    const consentingGuardian = newId();
    const noConsentRelationshipGuardian = newId(); // relationship.mayReceiveComms === false
    const optedOutGuardian = newId(); // relationship allows it, but preference says no

    resolver.set(studentId, [
      { personId: consentingGuardian as PersonId, mayReceiveComms: true, reason: 'parent', addresses: { email: 'ok@example.com' } },
      { personId: noConsentRelationshipGuardian as PersonId, mayReceiveComms: false, reason: 'emergency_contact', addresses: { email: 'no-consent@example.com' } },
      { personId: optedOutGuardian as PersonId, mayReceiveComms: true, reason: 'parent', addresses: { email: 'opted-out@example.com' } },
    ]);

    // The opted-out guardian has an explicit preference row saying no to
    // (email, attendance) - set BEFORE notify() runs, since consent must be
    // checked at send time, not baked in earlier.
    await runWithContext(ctx, () =>
      notifications.setPreference({ personId: optedOutGuardian as PersonId, channel: 'email', category: 'attendance', optedIn: false }),
    );

    const result = await runWithContext(ctx, () =>
      notifications.notify({
        templateKey: 'attendance.absence',
        category: 'attendance',
        subjectType: 'people.person',
        subjectId: studentId,
        payload: { date: '2026-08-10' },
        dedupeKey: `consent-${newId()}`,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.deliveries.length).toBe(3); // every recipient gets a row - never a silently missing one

    const byPerson = new Map(result.value.deliveries.map((d) => [d.personId, d]));

    const consentingDelivery = byPerson.get(consentingGuardian as PersonId)!;
    expect(consentingDelivery.status).toBe('sent');
    expect(consentingDelivery.suppressedReason).toBeNull();

    const noConsentDelivery = byPerson.get(noConsentRelationshipGuardian as PersonId)!;
    expect(noConsentDelivery.status).toBe('suppressed');
    expect(noConsentDelivery.suppressedReason).toBe('relationship_may_not_receive_comms');

    const optedOutDelivery = byPerson.get(optedOutGuardian as PersonId)!;
    expect(optedOutDelivery.status).toBe('suppressed');
    expect(optedOutDelivery.suppressedReason).toBe('preference_opted_out');

    // The channel was only ever actually invoked for the one consenting recipient.
    expect(channel.sent.length).toBe(1);
    expect(channel.sent[0]!.to).toBe('ok@example.com');
  });

  it('the same dedupeKey sent twice results in exactly one send - at-least-once outbox redelivery is safe', async () => {
    const tenantId = await createTenant(`notif-dedupe-${newId()}`, 'Notif Dedupe');
    const ctx = await ctxFor(tenantId);

    const resolver = new FakeRecipientResolver();
    const channel = new InMemoryNotificationChannel('email');
    const registry = new MapNotificationChannelRegistry([channel]);
    const notifications = new NotificationsService(resolver, registry);

    await runWithContext(ctx, () =>
      notifications.publishTemplateVersion({ templateKey: 'dedupe.test', channel: 'email', bodyTemplate: 'body' }),
    );

    const studentId = newId();
    const guardianId = newId();
    resolver.set(studentId, [{ personId: guardianId as PersonId, mayReceiveComms: true, reason: 'parent', addresses: { email: 'guardian@example.com' } }]);

    const dedupeKey = `dedupe-${newId()}`;
    const input = {
      templateKey: 'dedupe.test',
      category: 'general',
      subjectType: 'people.person',
      subjectId: studentId,
      payload: {},
      dedupeKey,
    };

    const first = await runWithContext(ctx, () => notifications.notify(input));
    const second = await runWithContext(ctx, () => notifications.notify(input)); // simulates a redelivered outbox message

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.value.deduped).toBe(false);
    expect(second.value.deduped).toBe(true);
    expect(second.value.notification.id).toBe(first.value.notification.id); // same logical message
    expect(second.value.deliveries.length).toBe(first.value.deliveries.length);

    // The channel adapter itself was only ever called once.
    expect(channel.sent.length).toBe(1);

    const rows = await ownerSql`select count(*)::int as n from notifications.notification where dedupe_key = ${dedupeKey}`;
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it('a redelivery after a crash between commit and send still delivers - a half-finished notify is recoverable, not a silent permanent drop', async () => {
    const tenantId = await createTenant(`notif-crash-${newId()}`, 'Notif Crash');
    const ctx = await ctxFor(tenantId);

    const resolver = new FakeRecipientResolver();
    const channel = new InMemoryNotificationChannel('email');
    const registry = new MapNotificationChannelRegistry([channel]);
    const notifications = new NotificationsService(resolver, registry);

    await runWithContext(ctx, () =>
      notifications.publishTemplateVersion({ templateKey: 'crash.test', channel: 'email', bodyTemplate: 'body' }),
    );

    const studentId = newId();
    const guardianId = newId();
    resolver.set(studentId, [
      { personId: guardianId as PersonId, mayReceiveComms: true, reason: 'parent', addresses: { email: 'guardian@example.com' } },
    ]);

    const input = {
      templateKey: 'crash.test',
      category: 'general',
      subjectType: 'people.person',
      subjectId: studentId,
      payload: {},
      dedupeKey: `crash-${newId()}`,
    };

    const first = await runWithContext(ctx, () => notifications.notify(input));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(channel.sent.length).toBe(1);

    // Rewind to the exact state a crash between COMMIT and dispatch leaves
    // behind: the notification and its delivery rows are committed, but the
    // email never went out, so the row is still 'queued'.
    const notificationId = first.value.notification.id;
    await ownerSql`
      update notifications.delivery
      set status = 'queued', sent_at = null, provider_message_id = null, attempts = 0
      where notification_id = ${notificationId}
    `;
    channel.sent.length = 0;

    // The outbox redelivers. The dedupe key conflicts - and the old code
    // returned deduped:true here having sent nothing, losing the message
    // forever. The queued row must actually be dispatched.
    const retry = await runWithContext(ctx, () => notifications.notify(input));
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;

    expect(retry.value.deduped).toBe(true);
    expect(channel.sent.length).toBe(1); // it really went out this time
    expect(retry.value.deliveries.every((d) => d.status === 'sent')).toBe(true);

    // And a further redelivery, now that everything is 'sent', must NOT
    // produce a second email - the whole point of the dedupe key.
    const third = await runWithContext(ctx, () => notifications.notify(input));
    expect(third.ok).toBe(true);
    expect(channel.sent.length).toBe(1);

    const rows = await ownerSql`select count(*)::int as n from notifications.notification where dedupe_key = ${input.dedupeKey}`;
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it('a recipient resolver that throws leaves NO notification row behind - a later redelivery is not deduped away', async () => {
    const tenantId = await createTenant(`notif-resolver-${newId()}`, 'Notif Resolver');
    const ctx = await ctxFor(tenantId);

    let failing = true;
    const resolver: RecipientResolver = {
      async resolve(): Promise<NotificationRecipient[]> {
        if (failing) throw new Error('simulated recipient resolution failure');
        return [{ personId: newId() as PersonId, mayReceiveComms: true, reason: 'parent', addresses: { email: 'g@example.com' } }];
      },
    };
    const channel = new InMemoryNotificationChannel('email');
    const notifications = new NotificationsService(resolver, new MapNotificationChannelRegistry([channel]));

    await runWithContext(ctx, () =>
      notifications.publishTemplateVersion({ templateKey: 'resolver.test', channel: 'email', bodyTemplate: 'body' }),
    );

    const input = {
      templateKey: 'resolver.test',
      category: 'general',
      subjectType: 'people.person',
      subjectId: newId(),
      payload: {},
      dedupeKey: `resolver-${newId()}`,
    };

    await expect(runWithContext(ctx, () => notifications.notify(input))).rejects.toThrow('simulated recipient resolution failure');

    // Nothing was claimed by the failed attempt, so the retry is a fresh send
    // rather than a no-op that silently tells nobody.
    const before = await ownerSql`select count(*)::int as n from notifications.notification where dedupe_key = ${input.dedupeKey}`;
    expect((before[0] as { n: number }).n).toBe(0);

    failing = false;
    const retry = await runWithContext(ctx, () => notifications.notify(input));
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.deduped).toBe(false);
    expect(channel.sent.length).toBe(1);
  });

  it('a channel that throws records a failed delivery with the error - the delivery is never marked sent or delivered', async () => {
    const tenantId = await createTenant(`notif-failure-${newId()}`, 'Notif Failure');
    const ctx = await ctxFor(tenantId);

    const resolver = new FakeRecipientResolver();
    const failingChannel = new InMemoryNotificationChannel('email', () => 'throw');
    const registry = new MapNotificationChannelRegistry([failingChannel]);
    const notifications = new NotificationsService(resolver, registry);

    await runWithContext(ctx, () =>
      notifications.publishTemplateVersion({ templateKey: 'failure.test', channel: 'email', bodyTemplate: 'body' }),
    );

    const studentId = newId();
    const guardianId = newId();
    resolver.set(studentId, [{ personId: guardianId as PersonId, mayReceiveComms: true, reason: 'parent', addresses: { email: 'guardian@example.com' } }]);

    const result = await runWithContext(ctx, () =>
      notifications.notify({
        templateKey: 'failure.test',
        category: 'general',
        subjectType: 'people.person',
        subjectId: studentId,
        payload: {},
        dedupeKey: `failure-${newId()}`,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.deliveries.length).toBe(1);
    const delivery = result.value.deliveries[0]!;
    expect(delivery.status).toBe('failed');
    expect(delivery.lastError).toContain('simulated delivery failure');
    expect(delivery.sentAt).toBeNull();
    expect(delivery.deliveredAt).toBeNull();

    const [row] = await ownerSql`select status, last_error from notifications.delivery where id = ${delivery.id}`;
    expect((row as { status: string }).status).toBe('failed');
    expect((row as { last_error: string }).last_error).toContain('simulated delivery failure');
  });

  it('the attendance.marked_absent subscriber turns an outbox message into deliveries for the student\'s guardians', async () => {
    const tenantId = await createTenant(`notif-attendance-${newId()}`, 'Notif Attendance');
    const ctx = await ctxFor(tenantId);

    const resolver = new FakeRecipientResolver();
    const channel = new InMemoryNotificationChannel('email');
    const registry = new MapNotificationChannelRegistry([channel]);
    const notifications = new NotificationsService(resolver, registry);
    const subscriber = new AttendanceAbsenceSubscriber(notifications);

    await runWithContext(ctx, () =>
      notifications.publishTemplateVersion({
        templateKey: 'attendance.absence',
        channel: 'email',
        bodyTemplate: 'Your student was marked absent on {{date}}.',
      }),
    );

    const studentPersonId = newId();
    const guardianId = newId();
    resolver.set(studentPersonId, [
      { personId: guardianId as PersonId, mayReceiveComms: true, reason: 'parent', addresses: { email: 'guardian@example.com' } },
    ]);

    const message: OutboxMessage = {
      id: newId(),
      tenantId,
      topic: 'attendance.marked_absent',
      payload: {
        personId: studentPersonId,
        sectionId: newId(),
        sectionMeetingId: newId(),
        date: '2026-08-10',
        codeId: newId(),
      },
      requestId: null,
      actorUserId: null,
      occurredAt: new Date(),
      publishedAt: null,
      attempts: 0,
      lastError: null,
    };

    await subscriber.handle(message);

    const deliveries = await runWithContext(ctx, () =>
      notifications.listDeliveries({ personId: guardianId as PersonId }),
    );
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.status).toBe('sent');
    expect(channel.sent.length).toBe(1);
    expect(channel.sent[0]!.body).toContain('2026-08-10');

    // Redelivery (the same outbox message handed to handle() a second time,
    // exactly what OutboxDispatcher's at-least-once guarantee can do) must
    // not send a second email.
    await subscriber.handle(message);
    expect(channel.sent.length).toBe(1);

    const deliveriesAfterRedelivery = await runWithContext(ctx, () => notifications.listDeliveries({ personId: guardianId as PersonId }));
    expect(deliveriesAfterRedelivery.length).toBe(1);
  });
});
