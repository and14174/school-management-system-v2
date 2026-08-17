import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type TenantId, type UserId } from '@sms/kernel';
import { closeSqlClients, createSqlClient, type Sql } from '@sms/db';
import { getAuth, resetAuthSingleton } from './application/auth.js';
import { IdentityService } from './application/identity.service.js';
import { MembershipService } from './application/membership.service.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

/**
 * Applies the real `audit` + `tenancy` migrations (read, never edited - see
 * the module report's constraints) and this module's own `0300`/`0301`
 * migrations to a throwaway container, then proves - through the real
 * `getAuth()` Better Auth instance and the real `IdentityService`/
 * `MembershipService`, not reimplementations of them - the four things this
 * module exists for:
 *
 *   1. Sign-up/sign-in issues a session; a wrong password is rejected.
 *   2. `identity.membership` is RLS-isolated across tenants.
 *   3. A user with memberships in two tenants gets exactly the active one in
 *      their resolved session (only after `setActiveTenant`; a single
 *      membership is auto-selected at sign-in); `setActiveTenant` rejects a
 *      tenant the user has no membership in.
 *   4. A suspended membership cannot resolve a context.
 */
describe('identity (real Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: Sql;

  const memberships = new MembershipService();
  const identity = new IdentityService(memberships);

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('sms_test')
      .withUsername('sms_owner')
      .withPassword('dev')
      .start();

    const ownerUrl = container.getConnectionUri();
    // createSqlClient (not a direct `postgres` import) - the no-restricted-imports
    // ESLint rule only exempts libs/shared/db itself; everywhere else, including
    // this module's own tests, goes through @sms/db's sanctioned client factory.
    ownerSql = createSqlClient(ownerUrl);

    // Minimal stand-in for infra/postgres/init/01-roles-and-extensions.sql:
    // a non-owner app role, so table-owner RLS bypass can't mask a bug here.
    // Every migration below GRANTs to sms_app, so it must exist first.
    await ownerSql`create role sms_app with login password 'dev' nobypassrls`;
    await ownerSql`grant connect on database sms_test to sms_app`;

    // Read each module's migrations folder rather than naming files: a
    // hardcoded list silently stops applying anything added later, so a new
    // migration would be invisible to these tests instead of exercised by them.
    // Numeric prefixes make lexical order the real apply order (see migrate.ts).
    const applyMigrations = async (dir: string): Promise<void> => {
      const files = readdirSync(dir)
        .filter((name) => name.endsWith('.sql'))
        .sort((a, b) => a.localeCompare(b, 'en'));
      for (const file of files) {
        await ownerSql.unsafe(readFileSync(join(dir, file), 'utf8'));
      }
    };

    await applyMigrations(join(__dirname, '..', '..', 'audit', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', 'tenancy', 'migrations'));
    await applyMigrations(join(__dirname, '..', 'migrations'));

    const appUrl = new URL(ownerUrl);
    appUrl.username = 'sms_app';
    appUrl.password = 'dev';

    process.env.DATABASE_URL = appUrl.toString();
    process.env.DATABASE_MIGRATION_URL = ownerUrl;
    process.env.AUTH_SECRET = 'test-only-32-byte-minimum-secret-value-not-for-prod';
    process.env.APP_URL = 'http://localhost:3000';
    process.env.API_URL = 'http://localhost:3333';
    resetAuthSingleton();
  }, 180_000);

  afterAll(async () => {
    await closeSqlClients();
    await ownerSql?.end({ timeout: 1 });
    await container?.stop();
  });

  /** Direct insert as sms_owner (bypasses RLS as table owner) - `tenancy.tenant`'s service layer is not exported past `@sms/tenancy`'s public contract, so this is the test-side equivalent of `TenantService.create`. */
  async function createTenant(slug: string, name: string): Promise<TenantId> {
    const rows = await ownerSql`insert into tenancy.tenant (slug, name) values (${slug}, ${name}) returning id`;
    return (rows[0] as { id: string }).id as TenantId;
  }

  /** Extracts a `Cookie:` header value from a Better Auth server-call `Response` (`asResponse: true`). */
  function cookieHeaderFrom(response: Response): Headers {
    const setCookies = response.headers.getSetCookie();
    const cookiePairs = setCookies.map((cookie) => cookie.split(';', 1)[0]);
    return new Headers({ cookie: cookiePairs.join('; ') });
  }

  async function signUp(email: string, name: string, password: string): Promise<{ userId: UserId }> {
    const result = await getAuth().api.signUpEmail({ body: { name, email, password } });
    return { userId: result.user.id as UserId };
  }

  async function signIn(email: string, password: string): Promise<Headers> {
    const response = (await getAuth().api.signInEmail({
      body: { email, password },
      asResponse: true,
    })) as Response;
    expect(response.status).toBeLessThan(300);
    return cookieHeaderFrom(response);
  }

  it('sign-up then sign-in issues a session, and a wrong password is rejected', async () => {
    const email = `user-${newId()}@example.com`;
    await signUp(email, 'Test User', 'correct-horse-battery-staple');

    const headers = await signIn(email, 'correct-horse-battery-staple');
    const session = await identity.getSession(headers);
    expect(session).not.toBeNull();
    expect(session?.user.email).toBe(email);

    // `asResponse: true` turns a rejected sign-in into a Response (401)
    // rather than a thrown error - that is the whole point of the option
    // (an HTTP-shaped result instead of an exception).
    const wrongPasswordResponse = (await getAuth().api.signInEmail({
      body: { email, password: 'totally-wrong-password' },
      asResponse: true,
    })) as Response;
    expect(wrongPasswordResponse.status).toBe(401);
  });

  it('identity.membership is RLS-isolated: tenant B cannot see tenant A memberships, even connected as the non-owner sms_app role', async () => {
    const tenantA = await createTenant('tenant-a-membership-rls', 'Tenant A');
    const tenantB = await createTenant('tenant-b-membership-rls', 'Tenant B');
    const { userId } = await signUp(`rls-${newId()}@example.com`, 'RLS Test', 'correct-horse-battery-staple');

    const created = await memberships.create({ tenantId: tenantA, userId, status: 'active' });
    expect(created.ok).toBe(true);

    const seenFromB = await memberships.getForUserAndTenant(userId, tenantB);
    expect(seenFromB).toBeNull();

    const seenFromA = await memberships.getForUserAndTenant(userId, tenantA);
    expect(seenFromA?.tenantId).toBe(tenantA);

    // Directly against the table too, not just through the service, to rule
    // out an application-level filter doing the work RLS is supposed to.
    const appSqlNoContext = createSqlClient(process.env.DATABASE_URL!);
    try {
      const rows = await appSqlNoContext`select id from identity.membership where user_id = ${userId}`;
      expect(rows.length).toBe(0); // no app.tenant_id GUC set -> zero rows, never "every tenant"
    } finally {
      await appSqlNoContext.end({ timeout: 1 });
    }
  });

  it('a single active membership is auto-selected as the active tenant at sign-in', async () => {
    const tenant = await createTenant('tenant-single-membership', 'Single Membership Tenant');
    const email = `single-${newId()}@example.com`;
    const { userId } = await signUp(email, 'Single Membership User', 'correct-horse-battery-staple');
    await memberships.create({ tenantId: tenant, userId, status: 'active' });

    const headers = await signIn(email, 'correct-horse-battery-staple');
    const session = await identity.getSession(headers);
    expect(session?.activeTenantId).toBe(tenant);
  });

  it('a user with active memberships in two tenants gets exactly the one chosen via setActiveTenant, and setActiveTenant rejects a tenant with no membership', async () => {
    const tenantA = await createTenant('tenant-a-multi', 'Tenant A Multi');
    const tenantB = await createTenant('tenant-b-multi', 'Tenant B Multi');
    const tenantC = await createTenant('tenant-c-multi', 'Tenant C Multi (no membership)');
    const email = `multi-${newId()}@example.com`;
    const { userId } = await signUp(email, 'Multi Membership User', 'correct-horse-battery-staple');
    await memberships.create({ tenantId: tenantA, userId, status: 'active' });
    await memberships.create({ tenantId: tenantB, userId, status: 'active' });

    const headers = await signIn(email, 'correct-horse-battery-staple');
    const session = await identity.getSession(headers);
    expect(session?.activeTenantId).toBeNull(); // two active memberships -> nothing auto-selected

    const setToA = await identity.setActiveTenant(session!.sessionToken, tenantA);
    expect(setToA.ok).toBe(true);
    const sessionAfterA = await identity.getSession(headers);
    expect(sessionAfterA?.activeTenantId).toBe(tenantA);

    const setToB = await identity.setActiveTenant(session!.sessionToken, tenantB);
    expect(setToB.ok).toBe(true);
    const sessionAfterB = await identity.getSession(headers);
    expect(sessionAfterB?.activeTenantId).toBe(tenantB);

    const setToC = await identity.setActiveTenant(session!.sessionToken, tenantC);
    expect(setToC.ok).toBe(false);
    if (!setToC.ok) {
      expect(setToC.error.code).toBe('FORBIDDEN');
    }
    // Rejected switch must not have changed anything.
    const sessionStillB = await identity.getSession(headers);
    expect(sessionStillB?.activeTenantId).toBe(tenantB);
  });

  it('a suspended membership cannot resolve a context: no auto-select at sign-in, and setActiveTenant rejects it', async () => {
    const tenant = await createTenant('tenant-suspended', 'Suspended Membership Tenant');
    const email = `suspended-${newId()}@example.com`;
    const { userId } = await signUp(email, 'Suspended User', 'correct-horse-battery-staple');
    await memberships.create({ tenantId: tenant, userId, status: 'suspended' });

    const headers = await signIn(email, 'correct-horse-battery-staple');
    const session = await identity.getSession(headers);
    expect(session?.activeTenantId).toBeNull();

    const setResult = await identity.setActiveTenant(session!.sessionToken, tenant);
    expect(setResult.ok).toBe(false);
    if (!setResult.ok) {
      expect(setResult.error.code).toBe('FORBIDDEN');
    }

    const membership = await memberships.getForUserAndTenant(userId, tenant);
    expect(membership?.status).toBe('suspended');
  });

  it('createUserWithMembership creates a user with an active membership in one step', async () => {
    const tenant = await createTenant('tenant-create-with-membership', 'Create With Membership Tenant');
    const email = `created-${newId()}@example.com`;

    const result = await identity.createUserWithMembership({
      email,
      name: 'Created User',
      password: 'correct-horse-battery-staple',
      tenantId: tenant,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.membership.status).toBe('active');
      expect(result.value.membership.tenantId).toBe(tenant);
      expect(result.value.user.email).toBe(email);
    }

    // A duplicate sign-up with the same email is rejected (proves the account
    // row really was created, not just the membership).
    await expect(getAuth().api.signUpEmail({ body: { name: 'Dup', email, password: 'another-password-123' } })).rejects.toBeTruthy();
  });
});
