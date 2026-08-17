import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { newId } from '@sms/kernel';
import { authDrizzleSchema } from '../infrastructure/schema.js';
import { getIdentityDb } from '../infrastructure/db.js';
import { MembershipService } from './membership.service.js';

const SECONDS_PER_DAY = 60 * 60 * 24;

function requireAuthEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env (or otherwise export it) before using @sms/identity.`);
  }
  return value;
}

/** `process.env[name]`, coerced to a positive integer, or `fallback` if unset/invalid. */
function envSeconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const membershipService = new MembershipService();

/**
 * Builds the Better Auth instance. Exported (not just the lazy singleton
 * below) so tests can build one against a throwaway testcontainers database
 * without going through the module-level singleton's cached connection.
 *
 * - Database: `drizzleAdapter` over `@sms/db`'s pooled `sms_app` connection
 *   (`getIdentityDb()`) - Better Auth's core tables are global/non-RLS (see
 *   the 0300 migration header), so no `withTenantTx` wrapping is needed or
 *   possible here.
 * - Ids: `advanced.database.generateId` calls `@sms/kernel`'s `newId()`, so
 *   every Better Auth row uses the same UUIDv7 id space as the rest of the
 *   system instead of Better Auth's own default id generator.
 * - `session.additionalFields.activeTenantId`: this module's extension (see
 *   the 0300 migration comment on `identity.session`) - the tenant the
 *   session currently acts as.
 * - `databaseHooks.session.create.before`: auto-selects the active tenant
 *   for a user with exactly one active membership, so they never have to
 *   pick one explicitly. A user with several gets `activeTenantId: null`
 *   until they call `setActiveTenant`.
 * - `twoFactor()`: TOTP + backup codes, per the module spec. No email/SMS
 *   OTP delivery is configured (no provider for it exists yet in this
 *   codebase) - only the TOTP + backup-codes factors are usable.
 */
export function createAuth() {
  const authDb = getIdentityDb();
  const appUrl = requireAuthEnv('APP_URL');
  const apiUrl = requireAuthEnv('API_URL');
  const secret = requireAuthEnv('AUTH_SECRET');

  return betterAuth({
    appName: 'School Management System',
    baseURL: apiUrl,
    basePath: '/api/v1/auth',
    secret,
    trustedOrigins: [appUrl],
    database: drizzleAdapter(authDb, {
      provider: 'pg',
      schema: authDrizzleSchema,
      transaction: true,
    }),
    advanced: {
      database: {
        generateId: () => newId(),
      },
      // Secure (HTTPS-only) cookies by default in production; local dev over
      // plain http needs them off. Overridable per the module spec ("secure
      // cookie settings ... read from config").
      useSecureCookies: envFlag('AUTH_USE_SECURE_COOKIES', process.env.NODE_ENV === 'production'),
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: envSeconds('AUTH_PASSWORD_MIN_LENGTH', 8),
      maxPasswordLength: envSeconds('AUTH_PASSWORD_MAX_LENGTH', 128),
    },
    session: {
      expiresIn: envSeconds('AUTH_SESSION_EXPIRES_IN_SECONDS', 7 * SECONDS_PER_DAY),
      updateAge: envSeconds('AUTH_SESSION_UPDATE_AGE_SECONDS', SECONDS_PER_DAY),
      additionalFields: {
        activeTenantId: { type: 'string', required: false },
      },
    },
    plugins: [twoFactor({ issuer: 'School Management System' })],
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            // listForUserDuringAuthentication, not listForUser: this hook runs inside
            // Better Auth's own in-flight write on the pooled sms_app client, and a
            // nested transaction there deadlocks sign-in. See its doc comment.
            const memberships = await membershipService.listForUserDuringAuthentication(session.userId as never);
            const active = memberships.filter((membership) => membership.status === 'active');
            if (active.length !== 1) {
              return;
            }
            return { data: { ...session, activeTenantId: active[0]!.tenantId } };
          },
        },
      },
    },
  });
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  return raw === 'true' || raw === '1';
}

export type Auth = ReturnType<typeof createAuth>;

let authSingleton: Auth | undefined;

/** The process-wide Better Auth instance, built once and reused (same lazy-singleton shape as `@sms/db`'s `getAppSqlClient`). */
export function getAuth(): Auth {
  authSingleton ??= createAuth();
  return authSingleton;
}

/** Test-only: drops the cached singleton so a fresh `getAuth()` picks up new env (e.g. a testcontainers `DATABASE_URL`). */
export function resetAuthSingleton(): void {
  authSingleton = undefined;
}
