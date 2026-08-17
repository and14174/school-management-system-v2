import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Key format, hashing, and verification for machine API keys - see the 1600
 * migration header's "never a readable secret" for the full reasoning.
 *
 * A presented key is `sms_key_<prefix>.<secret>`:
 *   - `prefix` (12 hex chars, 6 random bytes) is NOT secret. It is stored in
 *     plain text, globally unique/indexed, and is what a UI or a log line
 *     may safely show - see `ApiKeySummary.prefix`.
 *   - `secret` (32 random bytes, base64url) is the actual credential. It is
 *     generated once, returned once (`MintedApiKey.plaintext`), and never
 *     stored - only `HMAC-SHA256(secret)` is (`api_key.key_hash`).
 *
 * Hashing choice: argon2/bcrypt are not present as dependencies in this
 * workspace (see the task this module was built against), so the documented,
 * deliberate choice is HMAC-SHA256 keyed by a secret derived from
 * `AUTH_SECRET` (already required, already >=32 bytes - see
 * `apps/api/src/config/env.schema.ts`). This is NOT "a password hash without
 * the slow KDF" - argon2/bcrypt exist to slow down guessing a LOW-ENTROPY,
 * user-chosen secret (a password). An API key secret is 256 bits of
 * `crypto.randomBytes`, chosen by nobody and guessable by nobody; a keyed
 * MAC is the correct primitive for that, and is what every major API
 * provider (Stripe, GitHub, AWS) actually does for machine tokens. Using a
 * dedicated, deliberately DOMAIN-SEPARATED derivation of `AUTH_SECRET`
 * (`hmac(AUTH_SECRET, 'sms/public-api/api-key-hash/v1')`, never `AUTH_SECRET`
 * itself) rather than requiring a brand-new required env var keeps this
 * module boot-safe in every environment that already runs the API - a second
 * env var (`API_KEY_HASH_SECRET`, checked first if 32+ chars are set) is
 * supported for operators who want the two secrets to differ in production.
 */

const KEY_TOKEN_PREFIX = 'sms_key_';
const PREFIX_BYTES = 6; // -> 12 hex chars
const SECRET_BYTES = 32; // 256 bits

export interface GeneratedApiKey {
  /** Shown to the caller exactly once - see `MintedApiKey.plaintext`. Never stored. */
  readonly plaintext: string;
  /** Non-secret, stored in `api_key.prefix`. */
  readonly prefix: string;
  /** The secret half - only its hash (`hashApiKeySecret`) is ever persisted. */
  readonly secret: string;
}

/** Generates a brand-new key. Called exactly once per mint. */
export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(PREFIX_BYTES).toString('hex');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return { plaintext: `${KEY_TOKEN_PREFIX}${prefix}.${secret}`, prefix, secret };
}

export interface ParsedApiKey {
  readonly prefix: string;
  readonly secret: string;
}

/**
 * Splits a presented `Authorization: Bearer <token>` value into its
 * prefix/secret halves, or `undefined` if it is not shaped like one of our
 * keys at all (e.g. a Better Auth bearer some other client sent, or
 * Swagger UI's placeholder value) - `ApiKeyGuard` treats that as "not an API
 * key request" and defers to the ordinary cookie-session `AuthGuard`, not as
 * an authentication failure.
 */
export function parseApiKey(token: string): ParsedApiKey | undefined {
  if (!token.startsWith(KEY_TOKEN_PREFIX)) return undefined;
  const rest = token.slice(KEY_TOKEN_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot === rest.length - 1) return undefined;
  const prefix = rest.slice(0, dot);
  const secret = rest.slice(dot + 1);
  return { prefix, secret };
}

let cachedHmacKey: Buffer | undefined;

function requireDerivationMaterial(): string {
  const override = process.env.API_KEY_HASH_SECRET;
  if (override && override.length >= 32) return override;

  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret) {
    throw new Error(
      'AUTH_SECRET (or API_KEY_HASH_SECRET) must be set to hash/verify API keys. Copy .env.example to .env before using @sms/public-api.',
    );
  }
  return authSecret;
}

/** Domain-separated derivation - see this file's header for why this is not just `AUTH_SECRET` directly. */
function hmacKey(): Buffer {
  cachedHmacKey ??= createHmac('sha256', requireDerivationMaterial()).update('sms/public-api/api-key-hash/v1').digest();
  return cachedHmacKey;
}

/** `HMAC-SHA256(secret)` as a hex digest - what `api_key.key_hash` stores. */
export function hashApiKeySecret(secret: string): string {
  return createHmac('sha256', hmacKey()).update(secret, 'utf8').digest('hex');
}

/** Constant-time comparison against a stored hash - never a plain `===`, which would leak timing information about the secret. */
export function verifyApiKeySecret(secret: string, expectedHashHex: string): boolean {
  const actual = Buffer.from(hashApiKeySecret(secret), 'hex');
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHashHex, 'hex');
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Test-only: drops the cached derived key so a test that changes `AUTH_SECRET`/`API_KEY_HASH_SECRET` mid-run sees the new value. */
export function resetKeyMaterialCacheForTests(): void {
  cachedHmacKey = undefined;
}
