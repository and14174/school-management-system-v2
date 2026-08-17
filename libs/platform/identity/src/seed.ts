#!/usr/bin/env tsx
/**
 * Idempotent local-dev/CI seed data: `admin@greenwood.test` / `Passw0rd!demo`,
 * with an `active` `identity.membership` on the "greenwood" tenant.
 *
 * Complements (does not modify - see the module report's constraints)
 * `@sms/tenancy`'s own `seed.ts`: that script must have already created the
 * "greenwood" tenant (this script looks it up by slug and fails with a clear
 * message if it hasn't run yet, rather than silently creating a second,
 * divergent tenant). Safe to run repeatedly: checks for the user by email
 * and the membership by (user, tenant) before creating either.
 *
 * Usage: tsx src/seed.ts (run after `@sms/tenancy`'s `tsx src/seed.ts`).
 */
import 'reflect-metadata';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { closeSqlClients, withSystemTx } from '@sms/db';
import type { TenantId } from '@sms/kernel';
import { IdentityService } from './application/identity.service.js';
import { MembershipService } from './application/membership.service.js';
import { getIdentityDb } from './infrastructure/db.js';
import { userTable } from './infrastructure/schema.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// Resolved relative to this file, not process.cwd() - see @sms/tenancy's migrate.ts/seed.ts for why.
try {
  process.loadEnvFile(join(__dirname, '..', '..', '..', '..', '.env'));
} catch {
  // no .env file present - assume the environment already has what we need
}

const ADMIN_EMAIL = 'admin@greenwood.test';
const ADMIN_PASSWORD = 'Passw0rd!demo';
// A person's name, not the school's: the UI greets people by first name, and
// "Good afternoon, Greenwood" reads as a bug even though it is not one.
const ADMIN_NAME = 'Amina Rahimi';

const memberships = new MembershipService();
const identity = new IdentityService(memberships);

async function findGreenwoodTenantId(): Promise<TenantId> {
  const rows = await withSystemTx((db) =>
    db.execute<{ id: string }>(sql`select id from tenancy.tenant where slug = 'greenwood' limit 1`),
  );
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error(
      'No tenant with slug "greenwood" found. Run @sms/tenancy\'s seed first: ' +
        '(cd libs/platform/tenancy && ../../../node_modules/.bin/tsx src/seed.ts)',
    );
  }
  return row.id as TenantId;
}

async function main(): Promise<void> {
  const tenantId = await findGreenwoodTenantId();

  const existingUserRows = await getIdentityDb().select().from(userTable).where(eq(userTable.email, ADMIN_EMAIL)).limit(1);
  const existingUser = existingUserRows[0];

  if (!existingUser) {
    const created = await identity.createUserWithMembership({
      email: ADMIN_EMAIL,
      name: ADMIN_NAME,
      password: ADMIN_PASSWORD,
      tenantId,
    });
    if (!created.ok) {
      throw created.error;
    }
    console.log(`  create user "${ADMIN_EMAIL}" with active membership on tenant "greenwood"`);
  } else {
    console.log(`  skip   user "${ADMIN_EMAIL}" (already exists)`);

    const existingMembership = await memberships.getForUserAndTenant(existingUser.id as never, tenantId);
    if (!existingMembership) {
      const created = await memberships.create({ tenantId, userId: existingUser.id as never, status: 'active' });
      if (!created.ok) {
        throw created.error;
      }
      console.log('  create membership for existing user on tenant "greenwood"');
    } else {
      console.log('  skip   membership (already exists)');
    }
  }

  console.log('seed complete');
  console.log('');
  console.log('  Seeded credentials:');
  console.log(`    email:    ${ADMIN_EMAIL}`);
  console.log(`    password: ${ADMIN_PASSWORD}`);
  console.log('    tenant:   greenwood');
}

main()
  .catch((error: unknown) => {
    console.error('seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSqlClients();
  });
