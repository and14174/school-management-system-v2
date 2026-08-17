#!/usr/bin/env tsx
/**
 * Idempotent local-dev/CI seed data: an `attendance.absence` email template
 * (published, so `AttendanceAbsenceSubscriber` has something to render) and
 * default opt-ins (`channel: 'email'`, `category: 'attendance'`) for every
 * seeded guardian, so the end-to-end loop - mark a student absent, get a
 * real email in Mailpit - works the first time someone tries it, with no
 * manual setup step.
 *
 * Complements (does not modify - see the module report's constraints)
 * `@sms/tenancy`'s, `@sms/identity`'s, `@sms/access`'s and `@sms/people`'s
 * own `seed.ts`: all four must have already run (this script looks up the
 * "greenwood" tenant, its admin user, and its guardians, and fails with a
 * clear message if any is missing).
 *
 * Usage: tsx src/seed.ts (run after tenancy's, identity's, access's and
 * people's).
 */
import 'reflect-metadata';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { closeSqlClients, runWithContext, withSystemTx } from '@sms/db';
import { newId, unwrap, type PersonId, type TenantId, type UserId } from '@sms/kernel';
import { NotificationsService } from './application/notifications.service.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// Resolved relative to this file, not process.cwd() - see @sms/tenancy's migrate.ts/seed.ts for why.
try {
  process.loadEnvFile(join(__dirname, '..', '..', '..', '..', '.env'));
} catch {
  // no .env file present - assume the environment already has what we need
}

const ADMIN_EMAIL = 'admin@greenwood.test';

const notifications = new NotificationsService();

async function findGreenwoodTenantId(): Promise<TenantId> {
  const rows = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from tenancy.tenant where slug = 'greenwood' limit 1`));
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error(
      'No tenant with slug "greenwood" found. Run @sms/tenancy\'s seed first: ' +
        '(cd libs/platform/tenancy && ../../../node_modules/.bin/tsx src/seed.ts)',
    );
  }
  return row.id as TenantId;
}

async function findAdminUserId(): Promise<UserId> {
  const rows = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from identity.user where email = ${ADMIN_EMAIL} limit 1`));
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error(
      `No user "${ADMIN_EMAIL}" found. Run @sms/identity's seed first: ` +
        '(cd libs/platform/identity && ../../../node_modules/.bin/tsx src/seed.ts)',
    );
  }
  return row.id as UserId;
}

/** Every `people.person` currently holding the `guardian` role in this tenant - see `@sms/people`'s `0500` migration for `person_role`. */
async function findGuardianPersonIds(tenantId: TenantId): Promise<PersonId[]> {
  const rows = await withSystemTx((db) =>
    db.execute<{ person_id: string }>(
      sql`select distinct person_id from people.person_role where tenant_id = ${tenantId} and role = 'guardian'`,
    ),
  );
  return (rows as unknown as Array<{ person_id: string }>).map((row) => row.person_id as PersonId);
}

async function publishAbsenceTemplate(tenantId: TenantId, adminUserId: UserId): Promise<void> {
  await runWithContext({ tenantId, userId: adminUserId, actorUserId: adminUserId, roles: [], requestId: newId() }, async () => {
    const existing = await notifications.listTemplates();
    const alreadyPublished = existing.some((t) => t.key === 'attendance.absence' && t.channel === 'email' && t.latestVersion !== null);
    if (alreadyPublished) {
      console.log('  skip   template "attendance.absence" (email) - already published');
      return;
    }

    unwrap(
      await notifications.publishTemplateVersion({
        templateKey: 'attendance.absence',
        channel: 'email',
        name: 'Attendance - absence notice',
        description: 'Sent to a student\'s guardians when they are marked absent from a session.',
        subjectTemplate: 'Attendance notice',
        bodyTemplate:
          'This is an automated notice from the school.\n\n' +
          'Your student was marked absent on {{date}}.\n\n' +
          'If you believe this is in error, please contact the school office.',
      }),
    );
    console.log('  create template "attendance.absence" (email), version 1');
  });
}

async function seedGuardianOptIns(tenantId: TenantId, adminUserId: UserId, guardianIds: PersonId[]): Promise<void> {
  await runWithContext({ tenantId, userId: adminUserId, actorUserId: adminUserId, roles: [], requestId: newId() }, async () => {
    for (const personId of guardianIds) {
      const before = await notifications.getPreferences(personId);
      const already = before.some((p) => p.channel === 'email' && p.category === 'attendance');
      if (already) {
        continue;
      }
      unwrap(await notifications.setPreference({ personId, channel: 'email', category: 'attendance', optedIn: true }));
    }
    console.log(`  opt-in guardians -> email/attendance (${guardianIds.length} guardian(s) checked)`);
  });
}

async function main(): Promise<void> {
  const tenantId = await findGreenwoodTenantId();
  const adminUserId = await findAdminUserId();
  const guardianIds = await findGuardianPersonIds(tenantId);

  await publishAbsenceTemplate(tenantId, adminUserId);
  await seedGuardianOptIns(tenantId, adminUserId, guardianIds);

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
