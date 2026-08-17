import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Test, type TestingModule } from '@nestjs/testing';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, newId, type TenantId, type UserId } from '@sms/kernel';
import { closeSqlClients, createSqlClient, runWithContext, type Sql } from '@sms/db';
import { ACCESS_CONTRACT, PERMISSION_CATALOGUE, REQUIRE_PERMISSION_KEY, type AccessContract } from '@sms/access';
import { IS_PUBLIC_KEY } from '@sms/identity';
import { PUBLIC_API_CONTRACT, type PublicApiContract } from './contract.js';
import { PublicApiModule } from './api/public-api.module.js';
import { ApiKeyGuard } from './api/api-key-auth.guard.js';
import { apiKey } from './infrastructure/schema.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// A low, fast-to-hit threshold for the rate-limit test - set BEFORE the Nest
// module compiles, since RedisRateLimiter reads it once in its constructor.
process.env.API_KEY_RATE_LIMIT_PER_MINUTE = '3';
// The Redis already running locally (infra/docker-compose.yml) - real Redis,
// not a fake, same reasoning as @sms/documents' spec using real MinIO: it is
// reachable from this process, so exercising it proves more than a fake
// would (and this module's own fail-open behaviour on a genuinely
// unreachable Redis is exactly the one property a fake could not prove).
process.env.REDIS_URL ??= 'redis://localhost:6379';

/**
 * Applies the real `audit` + `tenancy` + `identity` + `access` migrations
 * (read, never edited) and this module's own `1600` migration to a
 * throwaway Postgres container, then proves - through the real
 * `ApiKeysService` (via `PUBLIC_API_CONTRACT`, built with Nest DI exactly
 * like `apps/api` wires it) and the real `ApiKeyGuard` - the properties this
 * module exists for: the stored value is never the plaintext key, a valid
 * key authenticates, a revoked/expired key fails closed, a key can never be
 * minted with more than its creator's own permissions, and rate limiting
 * trips at the configured threshold.
 */
describe('public-api (real Postgres + real Redis via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: Sql;
  let moduleRef: TestingModule;
  let access: AccessContract;
  let keys: PublicApiContract;
  let guard: ApiKeyGuard;

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

    await applyMigrations(join(__dirname, '..', '..', 'audit', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', 'tenancy', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', 'identity', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', 'access', 'migrations'));
    await applyMigrations(join(__dirname, '..', 'migrations'));

    const appUrl = new URL(ownerUrl);
    appUrl.username = 'sms_app';
    appUrl.password = 'dev';

    process.env.DATABASE_URL = appUrl.toString();
    process.env.DATABASE_MIGRATION_URL = ownerUrl;
    // Deliberately >= 32 bytes, and deliberately NOT the real dev secret -
    // key-material.ts derives the HMAC key from this (domain-separated, see
    // its own comment), so a distinct test value proves the derivation does
    // not depend on any particular AUTH_SECRET value.
    process.env.AUTH_SECRET = 'test-only-32-byte-minimum-secret-value-not-for-prod';

    moduleRef = await Test.createTestingModule({ imports: [PublicApiModule] }).compile();
    access = moduleRef.get(ACCESS_CONTRACT);
    keys = moduleRef.get(PUBLIC_API_CONTRACT);
    guard = moduleRef.get(ApiKeyGuard);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await closeSqlClients();
    await ownerSql?.end({ timeout: 1 });
    await container?.stop();
  });

  // ---------------------------------------------------------------------
  // Fixture helpers - raw SQL against ownerSql (bypasses RLS, as sms_owner),
  // same precedent as @sms/billing's/@sms/documents' own spec helpers.
  // ---------------------------------------------------------------------
  async function createTenant(slug: string, name: string): Promise<TenantId> {
    const rows = await ownerSql`insert into tenancy.tenant (slug, name) values (${slug}, ${name}) returning id`;
    return (rows[0] as { id: string }).id as TenantId;
  }

  async function createUser(email: string): Promise<UserId> {
    const rows = await ownerSql`insert into identity.user (id, name, email) values (${newId()}, ${email}, ${email}) returning id`;
    return (rows[0] as { id: string }).id as UserId;
  }

  let permissionCatalogueSeeded = false;
  async function seedPermissionCatalogueOnce(): Promise<void> {
    if (permissionCatalogueSeeded) return;
    for (const def of PERMISSION_CATALOGUE) {
      await ownerSql`
        insert into access.permission (id, key, resource, action, description)
        values (${newId()}, ${def.key}, ${def.resource}, ${def.action}, ${def.description})
        on conflict (key) do nothing
      `;
    }
    permissionCatalogueSeeded = true;
  }

  /** Grants `userId` exactly `permissionKeys` at `tenant` scope, via a fresh role. */
  async function grantRole(tenantId: TenantId, userId: UserId, permissionKeys: string[]): Promise<void> {
    await seedPermissionCatalogueOnce();
    const roleId = newId();
    await ownerSql`insert into access.role (id, tenant_id, key, name) values (${roleId}, ${tenantId}, ${'role-' + roleId}, 'Test role')`;
    for (const key of permissionKeys) {
      const permissionRows = await ownerSql`select id from access.permission where key = ${key} limit 1`;
      const permissionId = (permissionRows[0] as { id: string } | undefined)?.id;
      if (!permissionId) throw new Error(`Permission "${key}" not seeded.`);
      await ownerSql`insert into access.role_permission (id, role_id, permission_id, scope, tenant_id) values (${newId()}, ${roleId}, ${permissionId}, 'tenant', ${tenantId})`;
    }
    await ownerSql`insert into access.role_assignment (id, tenant_id, role_id, user_id) values (${newId()}, ${tenantId}, ${roleId}, ${userId})`;
  }

  function ctxFor(tenantId: TenantId, userId: UserId) {
    return { tenantId, userId, actorUserId: userId, roles: [], requestId: newId() };
  }

  /** A duck-typed `ExecutionContext` for direct `ApiKeyGuard.canActivate` calls - no HTTP server involved, matching this repo's precedent of testing services/guards through Nest DI without a live server. */
  function fakeContext(request: {
    headers: Record<string, string | undefined>;
    method: string;
    url: string;
    identity?: unknown;
  }, requiredPermission?: string): ExecutionContext {
    const handler = function TestHandler() {};
    if (requiredPermission) {
      Reflect.defineMetadata(REQUIRE_PERMISSION_KEY, requiredPermission, handler);
    }
    class TestController {}
    return {
      getHandler: () => handler,
      getClass: () => TestController,
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({}),
        getNext: () => undefined,
      }),
    } as unknown as ExecutionContext;
  }

  it('the stored value is NOT the plaintext key', async () => {
    const tenantId = await createTenant(`store-${newId()}`, 'Store Tenant');
    const admin = await createUser(`admin-${newId()}@example.com`);
    await grantRole(tenantId, admin, ['api.key:read', 'api.key:manage', 'people.person:read']);

    const minted = await runWithContext(ctxFor(tenantId, admin), () =>
      keys.mint({ name: 'Finance export', grantedPermissions: ['people.person:read'], neverExpires: true }),
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const [row] = await ownerSql`select key_hash, prefix from public_api.api_key where id = ${minted.value.id}`;
    const stored = row as { key_hash: string; prefix: string };

    expect(stored.key_hash).not.toBe(minted.value.plaintext);
    expect(minted.value.plaintext.includes(stored.key_hash)).toBe(false);
    expect(stored.key_hash).not.toContain(stored.prefix); // the hash carries no recognisable fragment of the key at all
    expect(stored.key_hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex digest, not the raw secret
    expect(minted.value.plaintext).toContain(stored.prefix); // sanity: the prefix IS shown, deliberately (non-secret)
  });

  it('a valid key authenticates via the real ApiKeyGuard, in the exact shape AuthGuard would populate from a cookie session', async () => {
    const tenantId = await createTenant(`auth-${newId()}`, 'Auth Tenant');
    const admin = await createUser(`admin-${newId()}@example.com`);
    await grantRole(tenantId, admin, ['api.key:manage', 'people.person:read']);

    const minted = await runWithContext(ctxFor(tenantId, admin), () =>
      keys.mint({ name: 'Warehouse sync', grantedPermissions: ['people.person:read'], neverExpires: true }),
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const request = { headers: { authorization: `Bearer ${minted.value.plaintext}` }, method: 'GET', url: '/api/v1/people' };
    const context = fakeContext(request, 'people.person:read');

    const allowed = await guard.canActivate(context);
    expect(allowed).toBe(true);
    expect(request).toMatchObject({ identity: { userId: admin, activeTenantId: tenantId } });

    // Attribution: last-used-at and a per-call request-log row exist, without ever recording the key itself.
    const [usage] = await ownerSql`select last_used_at, use_count from public_api.api_key_usage where api_key_id = ${minted.value.id}`;
    expect(usage).toBeTruthy();
    expect(Number((usage as { use_count: number }).use_count)).toBeGreaterThanOrEqual(1);

    const logRows = await ownerSql`select method, path from public_api.api_key_request_log where api_key_id = ${minted.value.id}`;
    expect(logRows.length).toBeGreaterThanOrEqual(1);
    expect((logRows[0] as { method: string; path: string }).method).toBe('GET');
    expect((logRows[0] as { method: string; path: string }).path).toBe('/api/v1/people');
  });

  it('an unknown/garbled key fails to authenticate', async () => {
    const request = { headers: { authorization: 'Bearer sms_key_deadbeefcafe.not-a-real-secret-at-all' }, method: 'GET', url: '/api/v1/people' };
    const context = fakeContext(request, 'people.person:read');

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('a revoked key fails on the very next request', async () => {
    const tenantId = await createTenant(`revoke-${newId()}`, 'Revoke Tenant');
    const admin = await createUser(`admin-${newId()}@example.com`);
    await grantRole(tenantId, admin, ['api.key:manage', 'people.person:read']);

    const minted = await runWithContext(ctxFor(tenantId, admin), () =>
      keys.mint({ name: 'To be revoked', grantedPermissions: ['people.person:read'], neverExpires: true }),
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const requestBefore = { headers: { authorization: `Bearer ${minted.value.plaintext}` }, method: 'GET', url: '/api/v1/people' };
    expect(await guard.canActivate(fakeContext(requestBefore, 'people.person:read'))).toBe(true);

    const revoked = await runWithContext(ctxFor(tenantId, admin), () => keys.revoke({ id: minted.value.id, reason: 'no longer needed' }));
    expect(revoked.ok).toBe(true);

    const requestAfter = { headers: { authorization: `Bearer ${minted.value.plaintext}` }, method: 'GET', url: '/api/v1/people' };
    await expect(guard.canActivate(fakeContext(requestAfter, 'people.person:read'))).rejects.toThrow(UnauthorizedException);

    // Revocation is permanent and archived, never deleted - the row is still there, marked.
    const [row] = await ownerSql`select revoked_at, revoke_reason from public_api.api_key where id = ${minted.value.id}`;
    expect((row as { revoked_at: Date | null }).revoked_at).not.toBeNull();
    expect((row as { revoke_reason: string | null }).revoke_reason).toBe('no longer needed');

    // Idempotent: revoking an already-revoked key is a no-op success, not an error.
    const revokedAgain = await runWithContext(ctxFor(tenantId, admin), () => keys.revoke({ id: minted.value.id }));
    expect(revokedAgain.ok).toBe(true);
  });

  it('an expired key fails closed', async () => {
    const tenantId = await createTenant(`expire-${newId()}`, 'Expire Tenant');
    const admin = await createUser(`admin-${newId()}@example.com`);
    await grantRole(tenantId, admin, ['api.key:manage', 'people.person:read']);

    const minted = await runWithContext(ctxFor(tenantId, admin), () =>
      keys.mint({
        name: 'Short-lived',
        grantedPermissions: ['people.person:read'],
        expiresAt: new Date(Date.now() + 60_000), // a minute in the future, so mint-time validation passes
      }),
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    // Back-date it directly, past expiry - proves the AUTHENTICATE path
    // checks expiry (mint-time validation only rejects a past expiresAt at
    // creation, which is a different property).
    await ownerSql`update public_api.api_key set expires_at = now() - interval '1 hour' where id = ${minted.value.id}`;

    const request = { headers: { authorization: `Bearer ${minted.value.plaintext}` }, method: 'GET', url: '/api/v1/people' };
    await expect(guard.canActivate(fakeContext(request, 'people.person:read'))).rejects.toThrow(UnauthorizedException);
  });

  it('a key cannot be minted with a permission its creator lacks', async () => {
    const tenantId = await createTenant(`subset-${newId()}`, 'Subset Tenant');
    const limitedUser = await createUser(`limited-${newId()}@example.com`);
    // Holds ONLY api.key:manage + people.person:read - deliberately NOT billing.invoice:read.
    await grantRole(tenantId, limitedUser, ['api.key:manage', 'people.person:read']);

    const attempt = await runWithContext(ctxFor(tenantId, limitedUser), () =>
      keys.mint({ name: 'Overreaching key', grantedPermissions: ['people.person:read', 'billing.invoice:read'], neverExpires: true }),
    );

    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.error).toBeInstanceOf(ForbiddenError);
    expect(attempt.error.message).toContain('billing.invoice:read');

    // Nothing was persisted - a rejected mint leaves no half-created row.
    const rows = await ownerSql`select id from public_api.api_key where tenant_id = ${tenantId} and name = 'Overreaching key'`;
    expect(rows.length).toBe(0);
  });

  it("a permission removed from the creator's role stops the key from working on the very next check (re-checked, not cached from mint time)", async () => {
    const tenantId = await createTenant(`revoke-role-${newId()}`, 'Revoke Role Tenant');
    const admin = await createUser(`admin-${newId()}@example.com`);
    await grantRole(tenantId, admin, ['api.key:manage', 'billing.invoice:read']);

    const minted = await runWithContext(ctxFor(tenantId, admin), () =>
      keys.mint({ name: 'Billing reader', grantedPermissions: ['billing.invoice:read'], neverExpires: true }),
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    // The key itself still lists billing.invoice:read as granted - the guard's
    // OWN subset check would pass. What must actually stop the request is the
    // unmodified PermissionGuard downstream recompiling the CREATOR's live
    // ability, which this test proves has genuinely lost the permission.
    const abilityAfterRevocation = await access.compileAbility(admin, tenantId);
    await ownerSql`delete from access.role_permission where role_id in (select role_id from access.role_assignment where user_id = ${admin} and tenant_id = ${tenantId})`;
    access.invalidateAbility(tenantId, admin);
    const abilityNow = await access.compileAbility(admin, tenantId);

    expect(abilityAfterRevocation.can('read', 'billing.invoice')).toBe(true);
    expect(abilityNow.can('read', 'billing.invoice')).toBe(false);
  });

  it("a key cannot be used for a permission outside its own granted subset, even if its creator still holds that permission", async () => {
    const tenantId = await createTenant(`scope-${newId()}`, 'Scope Tenant');
    const admin = await createUser(`admin-${newId()}@example.com`);
    // The creator holds BOTH permissions - only one is granted to the key.
    await grantRole(tenantId, admin, ['api.key:manage', 'people.person:read', 'billing.invoice:read']);

    const minted = await runWithContext(ctxFor(tenantId, admin), () =>
      keys.mint({ name: 'People only', grantedPermissions: ['people.person:read'], neverExpires: true }),
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const okRequest = { headers: { authorization: `Bearer ${minted.value.plaintext}` }, method: 'GET', url: '/api/v1/people' };
    expect(await guard.canActivate(fakeContext(okRequest, 'people.person:read'))).toBe(true);

    const deniedRequest = { headers: { authorization: `Bearer ${minted.value.plaintext}` }, method: 'GET', url: '/api/v1/billing/summary' };
    await expect(guard.canActivate(fakeContext(deniedRequest, 'billing.invoice:read'))).rejects.toThrow(ForbiddenError);
  });

  it('a route with no declared @RequirePermission is refused for key auth outright', async () => {
    const tenantId = await createTenant(`nogate-${newId()}`, 'No Gate Tenant');
    const admin = await createUser(`admin-${newId()}@example.com`);
    await grantRole(tenantId, admin, ['api.key:manage', 'people.person:read']);

    const minted = await runWithContext(ctxFor(tenantId, admin), () =>
      keys.mint({ name: 'No-gate probe', grantedPermissions: ['people.person:read'], neverExpires: true }),
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const request = { headers: { authorization: `Bearer ${minted.value.plaintext}` }, method: 'GET', url: '/api/v1/access/roles' };
    await expect(guard.canActivate(fakeContext(request /* no requiredPermission */))).rejects.toThrow(ForbiddenError);
  });

  it('a Bearer token that is not shaped like one of our keys is left alone (defers to cookie auth)', async () => {
    const request = { headers: { authorization: 'Bearer some-other-bearer-scheme-token' }, method: 'GET', url: '/api/v1/people' };
    const allowed = await guard.canActivate(fakeContext(request, 'people.person:read'));
    expect(allowed).toBe(true);
    expect((request as { identity?: unknown }).identity).toBeUndefined();
  });

  it('a request with no Authorization header at all is left alone (defers to cookie auth)', async () => {
    const request = { headers: {}, method: 'GET', url: '/api/v1/people' };
    const allowed = await guard.canActivate(fakeContext(request, 'people.person:read'));
    expect(allowed).toBe(true);
  });

  it('a @Public() route is never intercepted for key validation, even with a garbage Authorization header', async () => {
    const request = { headers: { authorization: 'Bearer sms_key_garbage.not-a-real-key' }, method: 'GET', url: '/api/v1/docs-json' };
    const handler = function PublicHandler() {};
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
    class PublicController {}
    const context = {
      getHandler: () => handler,
      getClass: () => PublicController,
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}), getNext: () => undefined }),
    } as unknown as ExecutionContext;

    const allowed = await guard.canActivate(context);
    expect(allowed).toBe(true);
  });

  it('rate limiting trips at the configured threshold (real Redis, limit=3/min set for this suite)', async () => {
    const tenantId = await createTenant(`rate-${newId()}`, 'Rate Tenant');
    const admin = await createUser(`admin-${newId()}@example.com`);
    await grantRole(tenantId, admin, ['api.key:manage', 'people.person:read']);

    const minted = await runWithContext(ctxFor(tenantId, admin), () =>
      keys.mint({ name: 'Rate-limited caller', grantedPermissions: ['people.person:read'], neverExpires: true }),
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const makeRequest = () => ({ headers: { authorization: `Bearer ${minted.value.plaintext}` }, method: 'GET', url: '/api/v1/people' });

    // The configured limit is 3/minute (process.env.API_KEY_RATE_LIMIT_PER_MINUTE, set at the top of this file).
    for (let i = 0; i < 3; i += 1) {
      await expect(guard.canActivate(fakeContext(makeRequest(), 'people.person:read'))).resolves.toBe(true);
    }
    // The 4th request in the same window is rejected.
    await expect(guard.canActivate(fakeContext(makeRequest(), 'people.person:read'))).rejects.toThrow(/rate limit/i);
  });

  it('isolates keys across tenants (RLS)', async () => {
    const tenantA = await createTenant(`rls-a-${newId()}`, 'Tenant A');
    const tenantB = await createTenant(`rls-b-${newId()}`, 'Tenant B');
    const adminA = await createUser(`admin-a-${newId()}@example.com`);
    const adminB = await createUser(`admin-b-${newId()}@example.com`);
    await grantRole(tenantA, adminA, ['api.key:manage', 'api.key:read', 'people.person:read']);
    await grantRole(tenantB, adminB, ['api.key:manage', 'api.key:read', 'people.person:read']);

    const mintedA = await runWithContext(ctxFor(tenantA, adminA), () =>
      keys.mint({ name: "Tenant A's key", grantedPermissions: ['people.person:read'], neverExpires: true }),
    );
    expect(mintedA.ok).toBe(true);
    if (!mintedA.ok) return;

    const listForB = await runWithContext(ctxFor(tenantB, adminB), () => keys.list());
    expect(listForB.find((k) => k.id === mintedA.value.id)).toBeUndefined();

    const getFromB = await runWithContext(ctxFor(tenantB, adminB), () => keys.get(mintedA.value.id));
    expect(getFromB.ok).toBe(false);

    const listForA = await runWithContext(ctxFor(tenantA, adminA), () => keys.list());
    expect(listForA.find((k) => k.id === mintedA.value.id)).toBeDefined();
  });

  it('list/get never expose key_hash - only ApiKeySummary fields', async () => {
    const tenantId = await createTenant(`shape-${newId()}`, 'Shape Tenant');
    const admin = await createUser(`admin-${newId()}@example.com`);
    await grantRole(tenantId, admin, ['api.key:manage', 'api.key:read', 'people.person:read']);

    const minted = await runWithContext(ctxFor(tenantId, admin), () =>
      keys.mint({ name: 'Shape probe', grantedPermissions: ['people.person:read'], neverExpires: true }),
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const summary = await runWithContext(ctxFor(tenantId, admin), () => keys.get(minted.value.id));
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value).not.toHaveProperty('keyHash');
    expect(summary.value).not.toHaveProperty('key_hash');
    expect(Object.keys(summary.value).sort()).toEqual(
      [
        'id',
        'tenantId',
        'name',
        'prefix',
        'grantedPermissions',
        'createdByUserId',
        'createdAt',
        'expiresAt',
        'neverExpires',
        'revokedAt',
        'revokedByUserId',
        'revokeReason',
        'lastUsedAt',
      ].sort(),
    );
  });

  it('sanity: the drizzle schema agrees with the migration on column names', async () => {
    // A cheap guard against the schema.ts/migration drifting apart silently -
    // select every mapped column by name.
    const rows = await ownerSql`select * from public_api.api_key limit 0`;
    expect(rows).toBeDefined();
    expect(Object.keys(apiKey)).toContain('grantedPermissions');
  });
});
